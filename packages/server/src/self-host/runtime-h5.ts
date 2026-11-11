import { dataEndpoint } from '@hunterzhu/pulse-data'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { LocalHost, LocalHostOptions } from '../index.js'
import { H5Server } from '../h5/server.js'

const protocol = 'pulse-self-host-runtime'
type Identity = { instanceId: string; nonce: string; pid: number; digest: string; dataDir: string }
type Request = { protocol: string; version: number; type: string; requestId: string; identity: Identity; mode?: string; leaseId?: string }
const sameIdentity = (a: Identity, b: Identity) => ['instanceId', 'nonce', 'pid', 'digest', 'dataDir'].every(key => a[key as keyof Identity] === b[key as keyof Identity])

/** Validation does not initialize a host. The controller must exclusively create this root. */
export async function validateIsolatedH5Root(root: string, identity: Identity): Promise<void> {
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) throw new Error('ISOLATED_ROOT_INVALID')
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home'), PULSE_DATA_DIR: join(root, 'data'), PULSE_DATA_IPC_ROOT: join(root, 'ipc'), PULSE_MANAGED: '0', PULSE_SELF_HOST_RUNTIME_V1: '1' })) {
    if (process.env[key] !== value) throw new Error(`ISOLATED_ENV_INVALID:${key}`)
  }
  const allowed = new Set(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'PULSE_DATA_DIR', 'PULSE_DATA_IPC_ROOT', 'PULSE_MANAGED', 'PULSE_SELF_HOST_RUNTIME_V1'])
  // CoreFoundation injects this locale marker into clean macOS child environments
  // before JavaScript starts. Accept only its OS-owned shape and current UID.
  const cfEncoding = process.env.__CF_USER_TEXT_ENCODING
  if (process.platform === 'darwin' && cfEncoding !== undefined && /^0x[0-9a-f]{1,8}:0x[0-9a-f]{1,8}:0x[0-9a-f]{1,8}$/i.test(cfEncoding) && Number(cfEncoding.split(':')[0]) === process.getuid?.()) allowed.add('__CF_USER_TEXT_ENCODING')
  if (Object.keys(process.env).some(key => !allowed.has(key))) throw new Error('ISOLATED_ENV_NOT_CLEAN')
  if (!identity || identity.pid !== process.pid || identity.dataDir !== join(root, 'data') || !/^[a-f0-9]{64}$/.test(identity.digest) || !identity.instanceId || !identity.nonce) throw new Error('ISOLATED_IDENTITY_INVALID')
  const endpoint = dataEndpoint(identity.dataDir)
  async function noLinks(directory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry), info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory() && !(process.platform !== 'win32' && info.isSocket() && directory === join(root, 'ipc') && path === endpoint))) throw new Error('ISOLATED_UNSAFE_FILE')
      if (info.isDirectory()) await noLinks(path)
    }
  }
  await noLinks(root)
  if (!(await lstat(join(root, 'ipc'))).isDirectory()) throw new Error('ISOLATED_IPC_ROOT_REQUIRED')
  const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'))
  const journal = JSON.parse(await readFile(join(root, 'state', 'journal.json'), 'utf8'))
  if (owner.protocol !== protocol || !owner.owner || journal.owner !== owner.owner || journal.phase !== 'launching' || !journal.identity || !sameIdentity(identity, journal.identity)) throw new Error('ISOLATED_OWNER_INVALID')
  if (!(await lstat(join(root, 'state', 'lock'))).isDirectory()) throw new Error('ISOLATED_LOCK_REQUIRED')
  // An existing service is never adopted, even when its PID appears dead.
  if ((await readdir(identity.dataDir)).some(name => ['service.json', 'service.lock', '.writer.lock'].includes(name))) throw new Error('ISOLATED_SERVICE_EXISTS')
}

/** IPC-only initialization; no config discovery and no host/database work before initialize. */
export async function runIsolatedH5Runtime(root: string, createHost: (options: LocalHostOptions) => LocalHost): Promise<number> {
  if (!process.send || !process.connected) throw new Error('ISOLATED_IPC_REQUIRED')
  let identity: Identity | undefined, host: LocalHost | undefined, server: H5Server | undefined
  let closing = false, initialized = false
  const seen = new Set<string>()
  let tail = Promise.resolve()
  let finish!: (code: number) => void
  const done = new Promise<number>(resolveDone => { finish = resolveDone })
  async function close(): Promise<void> {
    if (closing) return
    closing = true
    try { try { await server?.stop() } finally { await host?.close() } } finally {
      process.off('message', receive); process.off('disconnect', disconnected)
      if (process.connected) process.disconnect()
      finish(0)
    }
  }
  const disconnected = () => { tail = tail.then(close).catch(() => { finish(1) }) }
  async function handle(message: unknown): Promise<void> {
    const request = message as Request
    if (!request || request.protocol !== protocol || request.version !== 1 || typeof request.requestId !== 'string' || !request.requestId || !request.identity || closing) return
    const reply = (fields: Record<string, unknown>) => { if (process.connected) process.send?.({ protocol, version: 1, type: `${request.type}:result`, requestId: request.requestId, identity: request.identity, ...fields }) }
    if (seen.has(request.requestId) || (identity && !sameIdentity(identity, request.identity))) { reply({ error: 'ISOLATED_REQUEST_REJECTED' }); return }
    seen.add(request.requestId)
    try {
      if (request.type === 'initialize') {
        if (initialized || request.mode !== 'maintenance') throw new Error('ISOLATED_INITIALIZE_REJECTED')
        await validateIsolatedH5Root(root, request.identity)
        initialized = true
        identity = request.identity
        host = createHost({ cwd: join(root, 'home'), dataDir: identity.dataDir, logDir: join(root, 'state', 'logs'), taskAdmissionDirectory: join(root, 'state', 'admission'), provider: { provider: 'mock', defaultModel: 'mock' }, mockResponse: 'Isolated mock runtime.', jarvis: { enabled: false }, allowNetwork: false, approvalMode: 'read-only', enabledCapabilityPacks: [], capabilityPacks: [] })
        await host.init()
        server = new H5Server(host, { dataDir: identity.dataDir, host: '127.0.0.1', port: 0, isolatedRuntime: true })
        await server.start()
        reply(await server.isolatedHealth())
        return
      }
      if (!server || !identity) throw new Error('ISOLATED_INITIALIZE_REQUIRED')
      if (request.type === 'quiesce') { reply(await server.isolatedQuiesce()); return }
      if (request.type === 'health') { reply(await server.isolatedHealth()); return }
      if (!['probe', 'resume', 'stop'].includes(request.type)) throw new Error('ISOLATED_REQUEST_UNKNOWN')
      const health = await server.isolatedHealth()
      if (health.mode !== 'maintenance' || !health.idle || !request.leaseId || request.leaseId !== health.leaseId) throw new Error('ISOLATED_LEASE_INVALID')
      if (request.type === 'probe') reply(health)
      else if (request.type === 'resume') reply({ ...server.isolatedResume(request.leaseId), ok: true })
      else await close()
    } catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }) }
  }
  function receive(message: unknown) { tail = tail.then(() => handle(message)).catch(() => { finish(1) }) }
  process.on('message', receive)
  process.once('disconnect', disconnected)
  return done
}
