/** Isolated cooperative runtime. Not a production supervisor or a security sandbox.
 * No PID adoption, config discovery, shell hooks, schema rollback or crash lock recovery.
 * Capsules must remain immutable while running. Caller explicitly trusts their protocol support.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { verifySnapshot } from './self-host-snapshot.mjs'

export const PROTOCOL = 'pulse-self-host-runtime'
export class SelfHostRuntime {
  constructor({ controlRoot, timeoutMs = 3000 } = {}) {
    if (!path.isAbsolute(controlRoot ?? '')) throw new Error('controlRoot must be absolute')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('invalid timeout')
    this.root = path.resolve(controlRoot)
    this.timeout = timeoutMs
    this.phase = 'new'
    this.child = null
    this.pending = false
    this.owner = randomUUID()
    this.evidence = {}
    this.history = []
    this.journalQueue = Promise.resolve()
  }
  status() { return { phase: this.phase, controlRoot: this.root, identity: this.child?.identity ?? null, health: this.child?.health ?? null, alive: Boolean(this.child && !this.child.exited && this.child.process.connected) } }
  async exclusive(fn) {
    if (this.pending) throw new Error('operation in progress')
    this.pending = true
    try { return await fn() } finally { this.pending = false }
  }
  async journal(phase, extra = {}) {
    this.phase = phase
    Object.assign(this.evidence, extra)
    this.history.push({ phase, at: new Date().toISOString() })
    const file = path.join(this.root, 'state', 'journal.json')
    const temp = `${file}.${randomUUID()}.tmp`
    const body = JSON.stringify({ version: 1, owner: this.owner, phase, identity: this.child?.identity, health: this.child?.health, ...this.evidence, history: this.history })
    const write = this.journalQueue.then(async () => {
      await fs.writeFile(temp, body, { flag: 'wx', mode: 0o600 })
      await fs.rename(temp, file)
    })
    this.journalQueue = write.catch(() => {})
    await write
  }
  async verify(spec) {
    if (!spec || spec.protocol !== PROTOCOL || spec.version !== 1 || !/^[a-f0-9]{64}$/.test(spec.expectedDigest ?? '')) throw new Error('explicit protocol capability and external digest required')
    if (Object.keys(spec).some(k => !['capsulePath', 'expectedDigest', 'protocol', 'version'].includes(k))) throw new Error('args/cwd/env/hooks are not supported; isolated defaults only')
    if (!path.isAbsolute(spec.capsulePath ?? '')) throw new Error('absolute capsulePath required')
    const capsule = await fs.realpath(spec.capsulePath)
    if (capsule === this.root || capsule.startsWith(this.root + path.sep) || this.root.startsWith(capsule + path.sep)) throw new Error('capsule/controlRoot overlap')
    const result = await verifySnapshot({ snapshot: spec.capsulePath, expectedDigest: spec.expectedDigest })
    if (!result.ok) throw new Error('capsule verification failed')
    const cli = path.join(result.snapshot, result.entries.cli)
    let directory = path.dirname(cli)
    let metadata
    while (directory === result.snapshot || directory.startsWith(result.snapshot + path.sep)) {
      try { metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      directory = path.dirname(directory)
    }
    if (metadata?.selfHostRuntimeProtocol !== 1 || metadata?.selfHostRuntimeCommand !== 'self-host-runtime') throw new Error('capsule lacks static runtime capability')
    if (typeof metadata.version !== 'string' || !metadata.version) throw new Error('capsule package version required')
    return { spec: { ...spec }, cli, version: metadata.version }
  }
  async initialize() {
    // A fresh exclusive root is intentionally required, even after a clean close.
    const parent = path.dirname(this.root)
    if (await fs.realpath(parent) !== parent) throw new Error('symlinked controlRoot parent')
    await fs.mkdir(this.root, { mode: 0o700 })
    for (const name of ['home', 'data', 'state', 'ipc']) await fs.mkdir(path.join(this.root, name), { mode: 0o700 })
    await fs.writeFile(path.join(this.root, 'owner.json'), JSON.stringify({ protocol: PROTOCOL, owner: this.owner }), { flag: 'wx', mode: 0o600 })
    await fs.mkdir(path.join(this.root, 'state', 'lock'))
    await this.journal('ready')
  }
  async request(type, fields = {}) {
    const slot = this.child
    if (!slot || slot.exited || !slot.process.connected) throw new Error('unknown or disconnected child')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const finish = (err, msg) => { clearTimeout(timer); slot.process.off('message', onMessage); slot.process.off('exit', onExit); slot.process.off('disconnect', onExit); err ? reject(err) : resolve(msg) }
      const onExit = () => finish(new Error('child exited/disconnected during request'))
      const onMessage = msg => {
        if (msg?.requestId !== requestId) return
        if (msg.protocol !== PROTOCOL || msg.version !== 1 || msg.type !== `${type}:result` || Object.keys(slot.identity).some(k => msg.identity?.[k] !== slot.identity[k])) return finish(new Error('identity/protocol mismatch'))
        finish(null, msg)
      }
      const timer = setTimeout(() => finish(new Error(`${type} timeout`)), this.timeout)
      slot.process.on('message', onMessage); slot.process.once('exit', onExit); slot.process.once('disconnect', onExit)
      slot.process.send({ protocol: PROTOCOL, version: 1, type, requestId, identity: slot.identity, ...fields }, err => { if (err) finish(err) })
    })
  }
  maintenance(msg) {
    if (msg.ok !== true || msg.error != null || msg.mode !== 'maintenance' || msg.idle !== true || typeof msg.leaseId !== 'string' || !msg.leaseId) throw new Error('maintenance lease required')
    this.child.leaseId = msg.leaseId
  }
  responseError(stage, msg) {
    if (msg.error == null) return
    // Never persist arbitrary child text, paths, credentials or objects.
    const known = new Set(['ISOLATED_ENV_NOT_CLEAN'])
    const code = typeof msg.error === 'string' && known.has(msg.error) ? msg.error : 'CHILD_ERROR_REDACTED'
    throw new Error(`${stage} failed: ${code}`)
  }
  health(msg) {
    const slot = this.child
    if (msg.serverPid !== slot.process.pid || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(msg.serverInstanceId ?? '') || !Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535 || msg.serverVersion !== slot.version) throw new Error('runtime health identity/version mismatch')
    const health = { serverPid: msg.serverPid, serverInstanceId: msg.serverInstanceId, port: msg.port, serverVersion: msg.serverVersion }
    if (slot.health && Object.keys(health).some(k => health[k] !== slot.health[k])) throw new Error('runtime health changed during maintenance')
    slot.health = health
  }
  async launch(verified) {
    if (this.child && !this.child.exited) throw new Error('prior child exit not confirmed')
    verified = await this.verify(verified.spec)
    const dataDir = path.join(this.root, 'data')
    const plannedIdentity = { instanceId: randomUUID(), nonce: randomUUID(), digest: verified.spec.expectedDigest, dataDir }
    await this.journal('launch_planned', { spec: verified.spec, plannedIdentity })
    const child = spawn(process.execPath, [verified.cli, 'self-host-runtime', '--control-root', this.root], {
      cwd: this.root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false,
      env: { HOME: path.join(this.root, 'home'), USERPROFILE: path.join(this.root, 'home'), XDG_CONFIG_HOME: path.join(this.root, 'home'), PULSE_DATA_DIR: dataDir, PULSE_DATA_IPC_ROOT: path.join(this.root, 'ipc'), PULSE_MANAGED: '0', PULSE_SELF_HOST_RUNTIME_V1: '1' },
    })
    const slot = { process: child, version: verified.version, spec: verified.spec, exited: false, identity: { ...plannedIdentity, pid: child.pid } }
    this.child = slot
    child.once('exit', () => {
      slot.exited = true
      if (this.child === slot && this.phase === 'active') {
        this.journal('blocked', { error: 'active child exited unexpectedly' }).catch(() => { this.phase = 'blocked' })
      }
    })
    child.on('disconnect', () => {
      if (this.child === slot && this.phase === 'active') this.journal('blocked', { error: 'active child disconnected unexpectedly' }).catch(() => { this.phase = 'blocked' })
    })
    child.on('error', () => {})
    await this.journal('launching', { spec: verified.spec })
    const initial = await this.request('initialize', { mode: 'maintenance' })
    this.responseError('initialize', initial)
    this.health(initial)
    this.maintenance(initial)
    const probe = await this.request('probe', { leaseId: slot.leaseId })
    this.responseError('probe', probe)
    this.health(probe)
    if (probe.ok !== true || probe.error != null || probe.idle !== true || probe.mode !== 'maintenance' || probe.leaseId !== slot.leaseId) throw new Error('probe failed')
  }
  async activate() {
    await this.verify(this.child.spec)
    if (this.child.exited || !this.child.process.connected) throw new Error('activation child not alive')
    await this.journal('active_committed', { spec: this.child.spec })
    const result = await this.request('resume', { leaseId: this.child.leaseId })
    this.responseError('resume', result)
    if (result.ok !== true || result.error != null || result.mode !== 'active' || this.child.exited || !this.child.process.connected) throw new Error('resume not confirmed')
    await this.journal('active', { spec: this.child.spec })
    if (this.child.exited || !this.child.process.connected || this.phase !== 'active') throw new Error('child lost during active journal commit')
  }
  async stop() {
    const slot = this.child
    if (slot.exited) return
    // Only a cooperative stop. Never kill a busy or unknown process.
    await new Promise((resolve, reject) => {
      const finish = err => { clearTimeout(timer); slot.process.off('exit', onExit); err ? reject(err) : resolve() }
      const onExit = () => finish()
      const timer = setTimeout(() => finish(new Error('stop exit unconfirmed')), this.timeout)
      slot.process.once('exit', onExit)
      if (!slot.process.connected) return finish(new Error('stop disconnected'))
      slot.process.send({ protocol: PROTOCOL, version: 1, type: 'stop', requestId: randomUUID(), identity: slot.identity, leaseId: slot.leaseId }, err => { if (err) finish(err) })
    })
  }
  async blocked(error) { await this.journal('blocked', { error: error.message }); throw error }
  async start(spec) { return this.exclusive(async () => {
    if (this.phase !== 'new') throw new Error('already initialized')
    const verified = await this.verify(spec)
    await this.initialize()
    try { await this.launch(verified); await this.activate(); return this.status() } catch (error) { return this.blocked(error) }
  }) }
  async switch(spec) { return this.exclusive(async () => {
    if (this.phase !== 'active') throw new Error('runtime not active')
    const candidate = await this.verify(spec)
    const old = this.child.spec
    try {
      const idle = await this.request('quiesce')
      this.responseError('quiesce', idle)
      if (idle.busy === true && idle.mode === 'active') return { ...this.status(), busy: true }
      this.maintenance(idle)
      await this.journal('switching', { previous: old, candidate: spec })
      await this.stop()
      try { await this.launch(candidate) } catch (error) {
        // Unknown identity/health never grants a stop lease. Preserve the lock.
        if (!this.child.exited && !this.child.leaseId) throw error
        // Audit only bounded controller-generated categories, never arbitrary verifier/child text.
        const rollbackReason = error.message === 'probe failed' ? 'CANDIDATE_PROBE_FAILED' : 'CANDIDATE_START_FAILED'
        await this.journal('rolling_back', { failedCandidate: spec, rollbackReason })
        await this.stop()
        await this.launch(await this.verify(old))
        await this.activate()
        return { ...this.status(), rolledBack: true, reason: error.message }
      }
      await this.activate()
      return this.status()
    } catch (error) { return this.blocked(error) }
  }) }
  async close() { return this.exclusive(async () => {
    if (this.phase === 'closed') return this.status()
    if (this.phase !== 'active') throw new Error('runtime not active; manual reconciliation required')
    try {
      const idle = await this.request('quiesce')
      this.responseError('quiesce', idle)
      if (idle.busy === true && idle.mode === 'active') return { ...this.status(), busy: true }
      this.maintenance(idle)
      await this.journal('stopping')
      await this.stop()
      await this.journal('closed')
      await fs.rmdir(path.join(this.root, 'state', 'lock'))
      return this.status()
    } catch (error) { return this.blocked(error) }
  }) }
}
