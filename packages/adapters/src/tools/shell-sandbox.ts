import { SHARE_ENV, Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { initializeShellSandbox } from './sandbox-initialization.js'

type Wrapped = Awaited<ReturnType<typeof SandboxManager.wrapWithSandboxArgv>>
export interface ShellSandbox {
  reset(): Promise<void>
  initialize(policy: SandboxRuntimeConfig, signal?: AbortSignal): Promise<void>
  wrap(command: string, signal: AbortSignal | undefined, cwd: string, metadata: { commandId: string; commandText: string }): Promise<Wrapped>
  annotate(id: string, stderr: string): Promise<string>
  cleanup(): Promise<void>
}
const unavailable = (cause?: unknown) => Object.assign(new Error('WINDOWS_SANDBOX_WORKER_UNKNOWN'), { code: 'WINDOWS_SANDBOX_WORKER_UNKNOWN', cause })

/** The ordinary manager is retained for POSIX and explicit scripted test fixtures. */
export function directShellSandbox(): ShellSandbox {
  return {
    reset: () => SandboxManager.reset(),
    initialize: (policy, signal) => initializeShellSandbox(policy, process.platform, signal),
    wrap: (command, signal, cwd, metadata) => SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, signal, cwd, metadata),
    annotate: async (id, stderr) => SandboxManager.annotateStderrWithSandboxFailures(id, stderr),
    cleanup: async () => { await SandboxManager.cleanupAfterCommand() },
  }
}

interface Pending { resolve(value: any): void; reject(error: Error): void; detach(): void }
interface Modules { manager: string; initialization: string }
/** One trusted I/O worker per Host process. The existing main-thread sandbox
 * lease still serializes complete command lifecycles, including cancellation. */
export class WindowsShellSandbox implements ShellSandbox {
  private worker?: Worker
  private starting?: Promise<Worker>
  private failure?: Error
  private next = 0
  private lease: Promise<void> = Promise.resolve()
  private pending = new Map<string, Pending>()
  constructor(private readonly modules?: Modules) {}
  private fail(cause: unknown): Error {
    const error = this.failure ??= unavailable(cause)
    for (const item of this.pending.values()) { item.detach(); item.reject(error) }
    this.pending.clear()
    this.worker?.unref()
    return error
  }
  private async start(): Promise<Worker> {
    if (this.failure) throw this.failure
    if (this.worker) return this.worker
    return this.starting ??= (async () => {
      const require = createRequire(import.meta.url)
      let initialization = this.modules?.initialization
      if (!initialization) {
        let path = new URL('./sandbox-initialization.js', import.meta.url)
        try { await access(path) } catch { path = new URL('../../dist/tools/sandbox-initialization.js', import.meta.url); await access(path) }
        initialization = path.href
      }
      const manager = this.modules?.manager ?? pathToFileURL(require.resolve('@anthropic-ai/sandbox-runtime')).href
      const worker = new Worker(new URL('./windows-sandbox-worker.cjs', import.meta.url), { workerData: { manager, initialization }, env: SHARE_ENV })
      this.worker = worker
      worker.on('message', message => {
        if (!message || typeof message.id !== 'string' || typeof message.ok !== 'boolean') { this.fail(new Error('INVALID_SANDBOX_WORKER_RESPONSE')); return }
        const item = this.pending.get(message.id)
        if (!item) return
        this.pending.delete(message.id); item.detach()
        if (!this.pending.size) worker.unref()
        if (message.ok) item.resolve(message.value)
        else {
          const detail = message.error && typeof message.error === 'object' ? message.error : {}
          const error = Object.assign(new Error(typeof detail.message === 'string' ? detail.message : 'SANDBOX_WORKER_OPERATION_FAILED'), detail)
          item.reject(error)
        }
      })
      worker.once('error', error => this.fail(error))
      worker.once('exit', code => this.fail(new Error(`SANDBOX_WORKER_EXIT:${code}`)))
      worker.unref()
      return worker
    })().catch(error => { throw this.fail(error) })
  }
  private async request(operation: string, args: unknown[], signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    const worker = await this.start()
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    const id = String(++this.next), cancellation = new SharedArrayBuffer(4), flag = new Int32Array(cancellation)
    return new Promise((resolve, reject) => {
      const abort = () => {
        Atomics.store(flag, 0, 1)
        // The shared flag is also checked at synchronous preparation boundaries;
        // a blocked worker must not launch anything after the owner cancels.
        try { worker.postMessage({ abort: id }) } catch (error) { this.fail(error) }
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, detach: () => signal?.removeEventListener('abort', abort) })
      worker.ref()
      try { worker.postMessage({ id, operation, args, cancellation }); if (signal?.aborted) abort() }
      catch (error) { this.fail(error) }
    })
  }
  withLease<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lease.then(work, work)
    this.lease = result.then(() => undefined, () => undefined)
    return result
  }
  async reset(): Promise<void> { await this.request('reset', []) }
  async initialize(policy: SandboxRuntimeConfig, signal?: AbortSignal): Promise<void> { await this.request('initialize', [policy], signal) }
  async wrap(command: string, signal: AbortSignal | undefined, cwd: string, metadata: { commandId: string; commandText: string }): Promise<Wrapped> {
    const value = await this.request('wrap', [command, cwd, metadata], signal)
    if (!value || !Array.isArray(value.argv) || !value.argv.length || !value.argv.every((arg: unknown) => typeof arg === 'string') || !value.env || typeof value.env !== 'object') throw this.fail(new Error('INVALID_SANDBOX_DESCRIPTOR'))
    return value as Wrapped
  }
  async annotate(id: string, stderr: string): Promise<string> {
    const value = await this.request('annotate', [id, stderr])
    if (typeof value !== 'string') throw this.fail(new Error('INVALID_SANDBOX_ANNOTATION'))
    return value
  }
  async cleanup(): Promise<void> { await this.request('cleanup', []) }
  /** Explicit destruction is used only for an owned fixture. Unknown worker
   * state is poisoned, never silently restarted or given an in-process fallback. */
  async dispose(): Promise<void> { this.fail(new Error('SANDBOX_WORKER_DISPOSED')); await this.worker?.terminate() }
}
// Process ownership also survives module reloads (including isolated test
// files). Do not accumulate idle SDK workers or lose a poisoned lifetime.
const ownerKey = Symbol.for('pulse.windows-shell-sandbox.v1:' + new URL('../../', import.meta.url).href.toLowerCase())
export function windowsShellSandbox(): WindowsShellSandbox {
  const owner = process as unknown as Record<symbol, WindowsShellSandbox | undefined>
  return owner[ownerKey] ??= new WindowsShellSandbox()
}
export function withWindowsSandboxLease<T>(work: () => Promise<T>): Promise<T> { return windowsShellSandbox().withLease(work) }
export function shellSandboxManager(): ShellSandbox {
  return process.platform === 'win32' ? windowsShellSandbox() : directShellSandbox()
}
