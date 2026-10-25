import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { access, readFile, rm } from 'node:fs/promises'
import { UpdateManager } from './manager.js'
import { compatible, releaseId, type Selection } from './contracts.js'
import { atomicJson, readState, statePath, withUpdateLock } from './store.js'

export type ServiceSpec = { node: string; entry: string; args: string[]; dataDir: string; root: string; runtimeDirectory?: string }
type Health = { type: 'update-health'; port: number; dataDir: string; version: string; pid: number }

/** Owns the child, not user PIDs. The OS service always supervises this stable process. */
export async function supervise(spec: ServiceSpec, verificationKeys?: Record<string, string>): Promise<number> {
  const token = randomUUID()
  const bootstrap = await readFile(join(spec.root, 'updates/bootstrap.json'), 'utf8').then(JSON.parse).catch(() => undefined)
  const baseRuntime: string | undefined = bootstrap?.directory ?? spec.runtimeDirectory
  let child: ChildProcess | undefined, stopping = false, applying = false, port: number | undefined
  let runtime = baseRuntime ? { node: join(baseRuntime, process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(baseRuntime, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), directory: baseRuntime } : { node: spec.node, entry: spec.entry, directory: spec.runtimeDirectory }
  const versionOf = async (entry: string) => (JSON.parse(await readFile(resolve(entry, '../../package.json'), 'utf8')) as { version: string }).version
  const manager = new UpdateManager({ root: spec.root, dataDir: spec.dataDir, backendVersion: await versionOf(spec.entry), ...(verificationKeys ? { keys: verificationKeys } : {}), ...(spec.runtimeDirectory ? { runtimeDirectory: spec.runtimeDirectory } : {}) })
  const releaseLease = async () => {
    const path = join(spec.dataDir, '.update-maintenance.json')
    const value = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)
    if (value?.pid === process.pid && value.token === token) await rm(path, { force: true })
  }
  let stopHandler: (() => void) | undefined
  const result = new Promise<number>(resolveExit => {
    const stop = () => { if (stopping) return; stopping = true; void stopChild().then(() => resolveExit(0), () => resolveExit(1)) }
    stopHandler = stop
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    const launch = (maintenance: boolean): Promise<Health> => new Promise((resolveHealth, rejectHealth) => {
      const args = [...spec.args]
      if (port) { const at = args.indexOf('--port'); if (at >= 0) args[at + 1] = String(port); else args.push('--port', String(port)) }
      const manifest = runtime.directory ? JSON.parse(readFileSync(join(runtime.directory, 'desktop-runtime.json'), 'utf8')) as { buildId: string; browserExecutable?: string } : undefined
      const current = child = spawn(runtime.node, [runtime.entry, ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env,
        PULSE_UPDATE_CHILD: '1', PULSE_MANAGED: '1', PULSE_HOME: spec.root, PULSE_UPDATE_TOKEN: token, PULSE_UPDATE_OWNER: String(process.pid),
        ...(runtime.directory ? { PULSE_RUNTIME_DIR: runtime.directory, PULSE_BOOTSTRAP_RUNTIME: baseRuntime, PULSE_RUNTIME_ID: createHash('sha256').update(manifest!.buildId + runtime.directory).digest('hex'), ...(manifest?.browserExecutable ? { PULSE_BROWSER_EXECUTABLE: join(runtime.directory, manifest.browserExecutable) } : {}) } : {}),
        PULSE_UPDATE_MAINTENANCE: maintenance ? '1' : '0',
      } })
      const timer = setTimeout(() => rejectHealth(new Error('UPDATE_HEALTH_TIMEOUT')), 60000)
      current.once('error', error => { clearTimeout(timer); rejectHealth(error) })
      current.once('exit', code => {
        clearTimeout(timer); rejectHealth(new Error('UPDATE_CHILD_EXITED'))
        if (child === current) { child = undefined; if (!applying) resolveExit(stopping ? 0 : code ?? 1) }
      })
      current.on('message', raw => {
        const message = raw as Health | { type: 'update-ready' }
        if (message.type === 'update-health') {
          if (message.pid !== current.pid || resolve(message.dataDir) !== resolve(spec.dataDir) || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) { rejectHealth(new Error('UPDATE_HEALTH_IDENTITY_INVALID')); return }
          port = message.port; clearTimeout(timer); resolveHealth(message)
        }
        if (message.type === 'update-ready' && !applying && !stopping) { applying = true; void apply().finally(() => { applying = false }) }
      })
    })
    const stopChild = async () => {
      const current = child
      if (!current || current.exitCode !== null) return
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { current.kill('SIGKILL') }, 15000)
        const final = setTimeout(() => reject(new Error('UPDATE_CHILD_STOP_TIMEOUT')), 20000)
        current.once('exit', () => { clearTimeout(timer); clearTimeout(final); done() }); current.kill('SIGTERM')
      })
    }
    const waitWriter = async () => {
      const deadline = Date.now() + 30000
      while (true) {
        const writer = await readFile(join(spec.dataDir, '.writer.lock'), 'utf8').then(JSON.parse).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
        if (!writer) return
        try { process.kill(writer.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
        if (Date.now() >= deadline) throw new Error('UPDATE_WRITER_STOP_TIMEOUT')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    const apply = async () => {
      try {
        await withUpdateLock(spec.root, async () => {
          const state = await readState(spec.root, spec.dataDir), before: Selection = state.active
          if (!state.pending || !state.staged) { await releaseLease(); child?.send({ type: 'update-resume' }); return }
          const target = state.staged
          for (const item of Object.values(target)) { await manager.verifyInstalled(item); if (compatible(item.manifest, manager.context(target.backend?.manifest.version, state.shell)).length) throw new Error('UPDATE_INCOMPATIBLE') }
          const oldRuntime = { ...runtime }
          // Journal before stopping: next supervisor start can always return to before.
          state.previous = before; state.phase = 'applying'; await atomicJson(statePath(spec.root, spec.dataDir), state)
          try {
            await stopChild()
            await waitWriter()
            if (stopping) { await releaseLease(); resolveExit(0); return }
            const directory = target.backend?.directory ?? baseRuntime
            if (!directory) throw new Error('UPDATE_BASE_RUNTIME_MISSING')
            runtime = { node: join(directory, process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(directory, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), directory }
            const health = await launch(true)
            if (health.version !== (target.backend?.manifest.version ?? await versionOf(join(baseRuntime!, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js')))) throw new Error('UPDATE_HEALTH_VERSION_INVALID')
            if (before.backend && before.backend.directory !== target.backend?.directory) state.lastBackend = before.backend
            state.active = target; state.previous = before; delete state.staged; state.pending = false; state.phase = 'idle'; state.blocked = []; delete state.error
            await atomicJson(statePath(spec.root, spec.dataDir), state)
            await releaseLease(); child?.send({ type: 'update-resume' })
          } catch (error) {
            await stopChild(); await waitWriter(); runtime = oldRuntime
            state.active = before; state.pending = false; state.phase = 'failed'; state.error = error instanceof Error ? error.message : 'UPDATE_APPLY_FAILED'
            state.lastFailure = { version: target.backend?.manifest.version ?? 'bundled', code: state.error, at: new Date().toISOString() }
            state.failed = [...new Set([...state.failed, ...(target.backend ? [releaseId(target.backend.manifest)] : [])])]; delete state.staged
            await atomicJson(statePath(spec.root, spec.dataDir), state)
            if (stopping) { await releaseLease(); resolveExit(0); return }
            await launch(true); await releaseLease(); child?.send({ type: 'update-resume' })
          }
        })
      } catch (error) {
        await releaseLease(); child?.send({ type: 'update-resume' })
        await withUpdateLock(spec.root, async () => {
          const state = await readState(spec.root, spec.dataDir)
          if (state.pending) { state.pending = false; state.phase = 'failed'; state.error = error instanceof Error ? error.message : 'UPDATE_APPLY_FAILED'; state.lastFailure = { version: state.staged?.backend?.manifest.version ?? 'bundled', code: state.error, at: new Date().toISOString() }; if (state.staged?.backend) state.failed.push(releaseId(state.staged.backend.manifest)); delete state.staged; await atomicJson(statePath(spec.root, spec.dataDir), state) }
        }).catch(() => {})
        process.stderr.write(`Pulse update: ${error instanceof Error ? error.message : 'UPDATE_FAILED'}\n`)
        if (!child && !stopping) resolveExit(1)
      }
    }
    void (async () => {
      const state = await readState(spec.root, spec.dataDir)
      if (state.phase === 'applying') {
        await withUpdateLock(spec.root, async () => {
          const recovery = await readState(spec.root, spec.dataDir)
          if (recovery.staged?.backend) recovery.failed.push(releaseId(recovery.staged.backend.manifest))
          recovery.active = recovery.previous ?? {}; delete recovery.staged; recovery.pending = false; recovery.phase = 'failed'; recovery.error = 'UPDATE_INTERRUPTED_ROLLED_BACK'
          await atomicJson(statePath(spec.root, spec.dataDir), recovery)
        })
      }
      const active = (await readState(spec.root, spec.dataDir)).active.backend
      if (active) {
        try { await manager.verifyInstalled(active); runtime = { node: join(active.directory, process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(active.directory, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), directory: active.directory } }
        catch (error) {
          await withUpdateLock(spec.root, async () => {
            const state = await readState(spec.root, spec.dataDir); state.failed.push(releaseId(active.manifest)); state.active = state.previous ?? {}; state.pending = false; delete state.staged; state.phase = 'failed'; state.error = 'UPDATE_DAMAGED_ROLLED_BACK'
            let previous = state.active.backend
            if (previous?.directory === active.directory) previous = state.lastBackend
            if (previous && await manager.verifyInstalled(previous).then(() => true, () => false)) { state.active.backend = previous; runtime = { node: join(previous.directory, process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(previous.directory, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), directory: previous.directory } }
            else state.active = {}
            state.lastFailure = { version: active.manifest.version, code: 'UPDATE_DAMAGED_ROLLED_BACK', at: new Date().toISOString() }
            await atomicJson(statePath(spec.root, spec.dataDir), state)
          })
        }
      }
      const writer = await readFile(join(spec.dataDir, '.writer.lock'), 'utf8').then(JSON.parse).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (writer && (writer.protocol !== 2 || writer.version !== await versionOf(runtime.entry))) await waitWriter()
      await launch(false)
    })().catch(error => { process.stderr.write(`Pulse supervisor: ${error instanceof Error ? error.message : 'START_FAILED'}\n`); child?.kill('SIGTERM'); resolveExit(1) })
  })
  return result.finally(() => { if (stopHandler) { process.off('SIGINT', stopHandler); process.off('SIGTERM', stopHandler) } })
}
