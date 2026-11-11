import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { dataEndpoint } from '../packages/data/src/index.js'
import { createServer as createNetServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { runIsolatedH5Runtime, validateIsolatedH5Root } from '../packages/server/src/self-host/runtime-h5.js'
import { isolatedRuntimeEnvironment, validateIsolatedRuntimeEnvironment } from '../packages/server/src/self-host/runtime-env.js'
// @ts-expect-error standalone capsule controller
import { isolatedRuntimeEnvironment as controllerEnvironment } from '../scripts/self-host-runtime.mjs'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('isolated real H5 maintenance bridge', () => {
  it('rejects missing IPC before host creation', async () => {
    const send = process.send
    process.send = undefined
    try { await expect(runIsolatedH5Runtime('/nonexistent', () => { throw new Error('factory must not run') })).rejects.toThrow('ISOLATED_IPC_REQUIRED') } finally { process.send = send }
  })
  it('uses actual reader/data health, lease gates, and denies update/automation mutations', async () => {
    const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ph5-')); roots.push(root)
    vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root); vi.stubEnv('XDG_CONFIG_HOME', root)
    await mkdir(join(root, 'ipc')); vi.stubEnv('PULSE_DATA_IPC_ROOT', join(root, 'ipc'))
    const host = createLocalHost({ cwd: root, dataDir: root, taskAdmissionDirectory: join(root, 'admission'), provider: { provider: 'mock', defaultModel: 'mock' }, jarvis: { enabled: false }, approvalMode: 'read-only', allowNetwork: false, enabledCapabilityPacks: [], capabilityPacks: [] })
    const server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0, isolatedRuntime: true })
    try {
      await host.init(); const { port } = await server.start()
      const health = await server.isolatedHealth()
      expect(health).toMatchObject({ ok: true, idle: true, mode: 'maintenance', serverPid: process.pid, port })
      expect(health.leaseId).toBeTruthy()
      expect((await fetch(`http://127.0.0.1:${port}/api/session`)).status).toBe(503)
      expect((await fetch(`http://127.0.0.1:${port}/api/updates/status`)).status).toBe(403)
      expect(() => server.isolatedResume('wrong')).toThrow('ISOLATED_LEASE_INVALID')
      server.isolatedResume(health.leaseId!)
      expect(() => server.isolatedResume(health.leaseId!)).toThrow('ISOLATED_LEASE_INVALID')
      expect((await fetch(`http://127.0.0.1:${port}/api/automation`, { method: 'POST' })).status).toBe(403)
      const upgradeStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port, path: '/api/chat/socket', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }, response => { response.resume(); resolve(response.statusCode) })
        request.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('isolated upgrade unexpectedly accepted')) })
        request.on('error', reject); request.end()
      })
      expect(upgradeStatus).toBe(503)
      const internals = server as unknown as { pendingWorkStarts: Map<Promise<void>, unknown> }
      const pending = new Promise<void>(() => {})
      internals.pendingWorkStarts.set(pending, {})
      expect(await server.isolatedQuiesce()).toMatchObject({ busy: true, mode: 'active' })
      internals.pendingWorkStarts.delete(pending)
      const lease = await server.isolatedQuiesce()
      expect(lease).toMatchObject({ ok: true, idle: true, mode: 'maintenance' })
      expect(lease.leaseId).not.toBe(health.leaseId)
    } finally { await server.stop(); await host.close() }
  }, 30_000)
  it('validates controller ownership and refuses symlinks and stale services before initialization', async () => {
    const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'phr-'))); roots.push(root)
    const saved = { ...process.env }
    const env = isolatedRuntimeEnvironment(root)
    const identity = { instanceId: 'instance', nonce: 'nonce', pid: process.pid, digest: 'a'.repeat(64), dataDir: join(root, 'data') }
    try {
      for (const name of ['home', 'data', 'state', 'ipc']) await mkdir(join(root, name))
      await mkdir(join(root, 'state', 'lock'))
      await writeFile(join(root, 'owner.json'), JSON.stringify({ protocol: 'pulse-self-host-runtime', owner: 'owner' }))
      await writeFile(join(root, 'state', 'journal.json'), JSON.stringify({ owner: 'owner', phase: 'launching', identity, systemRoot: env.SYSTEMROOT }))
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, env)
      await expect(validateIsolatedH5Root(root, identity)).resolves.toBeUndefined()
      process.env.UNEXPECTED_RUNTIME_ENV = 'not-allowed'
      await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_ENV_NOT_CLEAN')
      delete process.env.UNEXPECTED_RUNTIME_ENV
      if (process.platform === 'darwin') {
        const uid = process.getuid!()
        process.env.__CF_USER_TEXT_ENCODING = `0x${uid.toString(16)}:0x19:0x34`
        await expect(validateIsolatedH5Root(root, identity)).resolves.toBeUndefined()
        process.env.__CF_USER_TEXT_ENCODING = `0x${uid.toString(16)}:not-hex:0x34`
        await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_ENV_NOT_CLEAN')
        process.env.__CF_USER_TEXT_ENCODING = `0x${(uid + 1).toString(16)}:0x19:0x34`
        await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_ENV_NOT_CLEAN')
        delete process.env.__CF_USER_TEXT_ENCODING
      }
      await expect(validateIsolatedH5Root(root, { ...identity, nonce: 'wrong' })).rejects.toThrow('ISOLATED_OWNER_INVALID')
      await symlink('/etc', join(root, 'home', 'external'))
      await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_UNSAFE_FILE')
      await rm(join(root, 'home', 'external'))
      await writeFile(join(root, 'data', '.writer.lock'), '{}')
      await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_SERVICE_EXISTS')
      await rm(join(root, 'data', '.writer.lock'))
      if (process.platform !== 'win32') {
        const expected = createNetServer(), unexpected = createNetServer()
        try {
          await new Promise<void>((resolve, reject) => { expected.once('error', reject); expected.listen(dataEndpoint(identity.dataDir), resolve) })
          await expect(validateIsolatedH5Root(root, identity)).resolves.toBeUndefined()
          await new Promise<void>((resolve, reject) => { unexpected.once('error', reject); unexpected.listen(join(root, 'ipc', 'unexpected.sock'), resolve) })
          await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_UNSAFE_FILE')
        } finally {
          await Promise.all([expected, unexpected].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
        }
      }
      await writeFile(join(root, 'data', 'service.json'), '{}')
      await expect(validateIsolatedH5Root(root, identity)).rejects.toThrow('ISOLATED_SERVICE_EXISTS')
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
  it('initializes the actual built CLI subprocess with a clean environment', async () => {
    const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'phc-'))); roots.push(root)
    for (const name of ['home', 'data', 'state', 'ipc']) await mkdir(join(root, name))
    await mkdir(join(root, 'state', 'lock'))
    const owner = randomUUID()
    const env = controllerEnvironment(root)
    await writeFile(join(root, 'owner.json'), JSON.stringify({ protocol: 'pulse-self-host-runtime', owner }))
    const child = spawn(process.execPath, [process.env.PULSE_ISOLATED_RUNTIME_TEST_CLI ?? fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)), 'self-host-runtime', '--control-root', root], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env,
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const exited = new Promise<number | null>(resolveExit => {
      child.once('exit', resolveExit)
      child.once('error', () => { if (!child.pid) resolveExit(null) })
    })
    const identity = { instanceId: randomUUID(), nonce: randomUUID(), pid: child.pid, digest: 'a'.repeat(64), dataDir: join(root, 'data') }
    function request(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const requestId = randomUUID()
      return new Promise((resolveReply, reject) => {
        if (!child.connected) { reject(new Error(`CLI unavailable during ${type}`)); return }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`CLI ${type} timeout: ${stderr}`)) }, 10_000)
        const receive = (message: unknown) => { const response = message as Record<string, unknown>; if (response.requestId === requestId) { cleanup(); resolveReply(response) } }
        const failed = () => { cleanup(); reject(new Error(`CLI exited during ${type}: ${stderr}`)) }
        function cleanup() { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('disconnect', failed); child.off('error', failed) }
        child.on('message', receive); child.once('exit', failed); child.once('disconnect', failed); child.once('error', failed)
        child.send({ protocol: 'pulse-self-host-runtime', version: 1, type, requestId, identity, ...fields }, error => { if (error) failed() })
      })
    }
    try {
      await writeFile(join(root, 'state', 'journal.json'), JSON.stringify({ owner, phase: 'launching', identity, systemRoot: env.SYSTEMROOT }))
      const initialized = await request('initialize', { mode: 'maintenance' })
      // Keep unexpected child text private: only known protocol error codes
      // belong in CI output, never arbitrary environment values or paths.
      const knownErrors = new Set(['ISOLATED_ROOT_INVALID', 'ISOLATED_SYSTEM_ROOT_INVALID', 'ISOLATED_ENV_NOT_CLEAN', 'ISOLATED_ENV_INVALID', 'ISOLATED_IDENTITY_INVALID', 'ISOLATED_UNSAFE_FILE', 'ISOLATED_IPC_ROOT_REQUIRED', 'ISOLATED_OWNER_INVALID', 'ISOLATED_LOCK_REQUIRED', 'ISOLATED_SERVICE_EXISTS', 'ISOLATED_INITIALIZE_REJECTED'])
      const errorCode = typeof initialized.error === 'string' && knownErrors.has(initialized.error) ? initialized.error : 'CHILD_ERROR_REDACTED'
      expect(initialized.error === undefined, `CLI initialize failed: ${errorCode}`).toBe(true)
      expect(initialized).toMatchObject({ ok: true, idle: true, mode: 'maintenance', identity, serverPid: child.pid })
      const leaseId = initialized.leaseId
      expect(await request('probe', { leaseId })).toMatchObject({ ok: true, idle: true, mode: 'maintenance', leaseId })
      expect(await request('resume', { leaseId })).toMatchObject({ ok: true, mode: 'active' })
      const quiesced = await request('quiesce')
      expect(quiesced).toMatchObject({ ok: true, idle: true, mode: 'maintenance' })
      child.send({ protocol: 'pulse-self-host-runtime', version: 1, type: 'stop', requestId: randomUUID(), identity, leaseId: quiesced.leaseId })
      expect(await exited).toBe(0)
    } finally {
      if (child.connected) child.disconnect()
      await exited
    }
  }, 30_000)
  it('keeps controller and packaged validator environment contracts in parity', () => {
    const source = { SystemRoot: 'C:\\Windows', PATH: 'parent-tools', USERNAME: 'parent-user', USERDOMAIN: 'parent-domain', TEMP: 'parent-temp', SECRET: 'parent-secret' }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const root = platform === 'win32' ? 'D:\\isolated' : '/isolated'
      const env = isolatedRuntimeEnvironment(root, platform, source)
      expect(controllerEnvironment(root, platform, source)).toEqual(env)
      expect(() => validateIsolatedRuntimeEnvironment(root, env, platform, env.SYSTEMROOT)).not.toThrow()
      expect(Object.values(env)).not.toContain('parent-secret')
      if (platform === 'win32') {
        expect(env).toMatchObject({ HOMEDRIVE: 'D:', HOMEPATH: '\\isolated\\home', PATH: '', TEMP: 'D:\\isolated\\home', TMP: 'D:\\isolated\\home', LOGONSERVER: '', USERNAME: '', USERDOMAIN: '', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', SYSTEMDRIVE: 'C:' })
        const lower = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]))
        expect(() => validateIsolatedRuntimeEnvironment(root, lower, platform, 'C:\\Windows')).not.toThrow()
        expect(() => validateIsolatedRuntimeEnvironment(root, { ...env, Path: '' }, platform, 'C:\\Windows')).toThrow('ISOLATED_ENV_NOT_CLEAN')
      } else expect(Object.keys(env)).toHaveLength(7)
      for (const key of Object.keys(env)) {
        expect(() => validateIsolatedRuntimeEnvironment(root, { ...env, [key]: 'changed' }, platform, env.SYSTEMROOT)).toThrow('ISOLATED_ENV_INVALID')
        const missing = { ...env }; delete missing[key]
        expect(() => validateIsolatedRuntimeEnvironment(root, missing, platform, env.SYSTEMROOT)).toThrow('ISOLATED_ENV_INVALID')
      }
      expect(() => validateIsolatedRuntimeEnvironment(root, { ...env, SECRET: 'extra' }, platform, env.SYSTEMROOT)).toThrow('ISOLATED_ENV_NOT_CLEAN')
    }
    for (const source of [{}, { SYSTEMROOT: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, ...['Windows', 'C:Windows', '\\\\server\\Windows', 'C:/Windows', 'C:\\Windows\\..\\other', 'C:\\Windows\\', 'C:\\Windows ', 'C:\\Windows\n'].map(SYSTEMROOT => ({ SYSTEMROOT }))]) {
      expect(() => isolatedRuntimeEnvironment('D:\\isolated', 'win32', source)).toThrow('ISOLATED_SYSTEM_ROOT_INVALID')
      expect(() => controllerEnvironment('D:\\isolated', 'win32', source)).toThrow('ISOLATED_SYSTEM_ROOT_INVALID')
    }
  })
  it('requires explicitly isolated listener options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-isolated-options-')); roots.push(root)
    vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root); vi.stubEnv('XDG_CONFIG_HOME', root)
    await mkdir(join(root, 'ipc')); vi.stubEnv('PULSE_DATA_IPC_ROOT', join(root, 'ipc'))
    const host = createLocalHost({ cwd: root, dataDir: root, jarvis: { enabled: false }, allowNetwork: false })
    try { expect(() => new H5Server(host, { dataDir: root, isolatedRuntime: true })).toThrow('ISOLATED_H5_OPTIONS_INVALID') } finally { await host.close() }
  })
})
