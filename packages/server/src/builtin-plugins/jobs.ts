import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { resolveProviderApiKey } from '../providers/credentials.js'
import { within } from '../security.js'
import { replaceStateFile } from '../atomic-file.js'
import { cancelGeneration, pollGeneration, startGeneration, type MediaInput, type RemoteTicket } from './adapters.js'
import { connections, pluginEnabled, pluginFor, readMergedHostConfig, resolveConnection, type MediaKind, type PluginHostConfig, type PluginId, type ResolvedConnection } from './config.js'
import { materialize, pluginError, pluginNetworkGate, safeError, type PluginNetworkAction } from './http.js'

export interface GeneratedArtifact { jobId: string; path: string; hash: string; bytes: number; mediaType: string; label: string }
export interface MediaJob {
  id: string; pluginId: PluginId; kind: MediaKind; runId: string; root: string; createdAt: number; deadline: number
  state: 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  connection: Omit<ResolvedConnection, 'apiKey'>; ticket?: RemoteTicket; output?: GeneratedArtifact; error?: string; remoteCancellation?: 'requested' | 'unsupported' | 'failed'
  /** Explicit decision for this job when its plugin or network was turned off. Never inferred from a raw config edit. */
  networkGrant?: 'finish' | 'cancel'
  ownerPid?: number
}
const active = (job: MediaJob) => ['submitting', 'running', 'unknown'].includes(job.state)
export class BuiltinPluginJobs {
  constructor(readonly dataDir: string, private readonly fallback: () => PluginHostConfig, private readonly configPath: () => string | undefined, private readonly networkOverride: () => boolean | undefined = () => undefined) {}
  get directory(): string { return join(this.dataDir, 'builtin-plugin-jobs') }
  private withOverride(value: PluginHostConfig): PluginHostConfig {
    const override = this.networkOverride()
    return override === undefined ? value : { ...value, allowNetwork: override }
  }
  /** Merged host layers, read on each call. A corrupt explicit file fails closed and does not inherit other layers. */
  config(): PluginHostConfig {
    const path = this.configPath()
    if (!path) return this.withOverride(this.fallback())
    const read = readMergedHostConfig(path)
    if (read.explicitInvalid) return { allowNetwork: false }
    if (read.explicitMissing && read.layerCount === 0) return this.withOverride(this.fallback())
    return this.withOverride(read.config as PluginHostConfig)
  }
  /** Effective config if the explicit file were replaced by `explicit`, before that file is committed. */
  private viewed(explicit: PluginHostConfig): PluginHostConfig {
    const read = readMergedHostConfig(this.configPath(), explicit as Record<string, unknown>)
    if (read.explicitInvalid) return { allowNetwork: false }
    return this.withOverride(read.config as PluginHostConfig)
  }
  private hardOff(): boolean { return this.networkOverride() === false }
  private grantPath(id: string): string { return this.file(id).replace(/\.json$/, '.grant') }
  private grant(id: string): MediaJob['networkGrant'] {
    try {
      const value = readFileSync(this.grantPath(id), 'utf8').trim()
      return value === 'finish' || value === 'cancel' ? value : undefined
    } catch { return undefined }
  }
  /** Immediate check for every request, download and socket. finish continues a known job; cancel only reaches its known task; --no-network blocks both. */
  private bindNetwork(job: MediaJob): (action: PluginNetworkAction) => void {
    return action => {
      const grant = this.grant(job.id)
      if (grant) job.networkGrant = grant
      const cancelRequested = existsSync(join(this.directory, job.id + '.cancel')) || job.networkGrant === 'cancel'
      if (this.hardOff()) throw pluginError('PLUGIN_NETWORK_DISABLED')
      if (action === 'cancel') {
        if (this.config().allowNetwork === true || cancelRequested) return
        throw pluginError('PLUGIN_NETWORK_DISABLED')
      }
      if (cancelRequested) throw pluginError('PLUGIN_CANCELLED')
      if (!this.allows(job, action === 'submit')) throw pluginError('PLUGIN_NETWORK_DISABLED')
    }
  }
  /** New submissions follow the effective switch. finish only continues an already submitted job, and --no-network blocks both. */
  private allows(job: MediaJob, submit: boolean): boolean {
    if (this.hardOff()) return false
    if (this.config().allowNetwork === true) return true
    return !submit && job.networkGrant === 'finish'
  }
  enabled(id: PluginId): boolean { return pluginEnabled(this.config(), id) }
  configured(kind: MediaKind): boolean { return connections(this.config().builtinPlugins ?? {}).some(c => c.kind === kind) }
  async lock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, 'admission.lock'), deadline = Date.now() + 10_000
    let lock: Awaited<ReturnType<typeof open>> | undefined
    while (!lock) {
      try { lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const pid = Number(await readFile(path, 'utf8').catch(() => ''))
        if (pid > 0) try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path, { force: true }); continue } }
        if (Date.now() > deadline) throw pluginError('PLUGIN_BUSY')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    try { return await operation() } finally { await lock.close(); await rm(path, { force: true }) }
  }
  private file(id: string): string { if (!/^[a-f0-9]{64}$/.test(id)) throw pluginError('PLUGIN_JOB_INVALID'); return join(this.directory, id + '.json') }
  async read(id: string): Promise<MediaJob | undefined> {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')) as MediaJob } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  private async save(job: MediaJob): Promise<void> {
    const path = this.file(job.id), temp = path + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(job), { flag: 'wx', mode: 0o600 })
    try { await replaceStateFile(temp, path) }
    // Acknowledged remote work must not be reported as a transport failure
    // when its local receipt cannot be replaced.
    catch { throw pluginError('PLUGIN_STATE_PERSIST_FAILED') }
    finally { await rm(temp, { force: true }) }
  }
  async list(): Promise<MediaJob[]> {
    const names = await readdir(this.directory).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })
    const result = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.read(name.slice(0, -5))))
    return result.filter((j): j is MediaJob => Boolean(j)).sort((a, b) => b.createdAt - a.createdAt)
  }
  async publicJobs() { return (await this.list()).map(({ id, pluginId, kind, runId, state, createdAt, error, remoteCancellation }) => ({ id, pluginId, kind, runId, state, createdAt, error, remoteCancellation })) }
  /** Called under the shared admission lock, immediately before committing config. */
  async disabling(previous: PluginHostConfig, next: PluginHostConfig, decisions: Partial<Record<PluginId, 'cancel' | 'finish'>> = {}): Promise<MediaJob[]> {
    const before = this.viewed(previous), after = this.viewed(next)
    const jobs = (await this.list()).filter(job => active(job) && pluginEnabled(before, job.pluginId) && !pluginEnabled(after, job.pluginId))
    if (jobs.some(job => !['cancel', 'finish'].includes(decisions[job.pluginId] ?? ''))) throw pluginError('PLUGIN_ACTIVE_JOBS')
    for (const job of jobs) {
      const decision = decisions[job.pluginId]
      if (decision !== 'finish' && decision !== 'cancel') continue
      await writeFile(this.grantPath(job.id), decision, { mode: 0o600 })
      job.networkGrant = decision
      await this.save(job)
    }
    return jobs.filter(job => decisions[job.pluginId] === 'cancel')
  }
  async cancel(jobs: MediaJob[]): Promise<string[]> {
    const failed: string[] = []
    for (const job of jobs) {
      try {
        await writeFile(join(this.directory, job.id + '.cancel'), '', { mode: 0o600 })
        // Unknown submissions have no waiter left to consume the cancellation marker.
        // Their remote status remains unknown; stopping locally must not imply a refund.
        if (job.state === 'unknown') {
          job.state = 'cancelled'; job.error = 'PLUGIN_CANCELLED'; job.remoteCancellation = 'unsupported'
          await this.save(job)
        }
      } catch { failed.push(job.id) }
    }
    return failed
  }
  /** Recover remote IDs after a dead process; never replay an uncertain POST. */
  async recoverPending(): Promise<() => void> {
    const lifecycle = new AbortController()
    for (const job of await this.list()) {
      if (!active(job) || job.state === 'unknown') continue
      if (job.ownerPid) { try { process.kill(job.ownerPid, 0); continue } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue } }
      if (!job.ticket) { job.state = 'unknown'; job.error = 'PLUGIN_SUBMISSION_UNKNOWN'; await this.save(job); continue }
      const grant = this.grant(job.id) ?? job.networkGrant
      if (grant) job.networkGrant = grant
      if (grant === 'cancel' || existsSync(join(this.directory, job.id + '.cancel'))) { await this.settleCancel(job); continue }
      if (!this.allows(job, false)) continue
      void this.run(job, lifecycle.signal, () => {}).catch(() => {})
    }
    return () => lifecycle.abort(pluginError('PLUGIN_HOST_SHUTDOWN'))
  }
  private async settleCancel(job: MediaJob): Promise<void> {
    await writeFile(join(this.directory, job.id + '.cancel'), '', { mode: 0o600 }).catch(() => undefined)
    job.state = 'cancelled'; job.error = 'PLUGIN_CANCELLED'; job.remoteCancellation = 'unsupported'; delete job.ownerPid
    if (job.ticket && !this.hardOff()) {
      const connection = await this.authorizedConnection(job)
      try { job.remoteCancellation = await cancelGeneration(connection, job.ticket, AbortSignal.timeout(5000)) ? 'requested' : 'unsupported' } catch { job.remoteCancellation = 'failed' }
    }
    await this.save(job)
  }
  private async authorizedConnection(job: MediaJob): Promise<ResolvedConnection> {
    const connection: ResolvedConnection = { ...job.connection }
    if (connection.credentialRef || connection.apiKeyEnv || connection.credentialProvider) {
      connection.apiKey = await resolveProviderApiKey({ provider: connection.credentialProvider ?? 'builtin-plugin', ...(connection.credentialRef ? { credentialRef: connection.credentialRef } : {}), ...(connection.apiKeyEnv ? { apiKeyEnv: connection.apiKeyEnv } : {}) }, this.configPath() ?? join(this.dataDir, 'config.json'))
    }
    return connection
  }
  id(runId: string, effectId: string): string { return createHash('sha256').update(runId + ':' + effectId).digest('hex') }
  async generate(root: string, runId: string, effectId: string, kind: MediaKind, input: MediaInput, signal: AbortSignal, emit: (state: string) => void, readReference?: (path: string) => Promise<import('./adapters.js').ReferenceImage>): Promise<GeneratedArtifact> {
    const id = this.id(runId, effectId)
    let fresh = false
    const job = await this.lock(async () => {
      const config = this.config()
      if (!pluginEnabled(config, pluginFor(kind))) throw pluginError('PLUGIN_DISABLED')
      const saved = await this.read(id)
      if (saved) return saved
      const c = await resolveConnection(config, kind, this.configPath() ?? join(this.dataDir, 'config.json'))
      const { apiKey: _secret, ...connection } = c
      const job: MediaJob = { id, kind, pluginId: pluginFor(kind), runId, root, createdAt: Date.now(), deadline: Date.now() + (c.timeoutMs ?? (kind === 'image' ? 180_000 : kind === 'video' ? 1_800_000 : 600_000)), state: 'submitting', connection: { ...connection, source: 'standalone' } }
      await this.save(job); fresh = true; return job
    })
    if (job.output) return job.output
    if (!fresh && job.state === 'submitting' && !job.ticket) throw pluginError('PLUGIN_SUBMISSION_UNKNOWN')
    if (['cancelled', 'failed', 'unknown'].includes(job.state)) throw pluginError(job.error ?? 'PLUGIN_SUBMISSION_UNKNOWN')
    return this.run(job, signal, emit, fresh ? input : undefined, readReference)
  }
  async reconcile(id: string, signal: AbortSignal): Promise<GeneratedArtifact | undefined> {
    const job = await this.read(id)
    if (!job) return undefined
    if (job.output) return job.output
    if (job.ticket && job.state === 'running') return this.run(job, signal, () => {})
    return undefined
  }
  private async run(job: MediaJob, parent: AbortSignal, emit: (state: string) => void, input?: MediaInput, readReference?: (path: string) => Promise<import('./adapters.js').ReferenceImage>): Promise<GeneratedArtifact> {
    const c = await this.authorizedConnection(job)
    const controller = new AbortController()
    const cancel = () => controller.abort(parent.reason?.code === 'PLUGIN_HOST_SHUTDOWN' ? parent.reason : pluginError('PLUGIN_CANCELLED'))
    const refreshGrant = () => { const grant = this.grant(job.id); if (grant) job.networkGrant = grant; return job.networkGrant }
    parent.addEventListener('abort', cancel, { once: true }); if (parent.aborted) cancel()
    const timer = setTimeout(() => controller.abort(pluginError('PLUGIN_TIMEOUT')), Math.max(1, job.deadline - Date.now()))
    const watch = setInterval(() => {
      const grant = refreshGrant()
      if (existsSync(join(this.directory, job.id + '.cancel')) || grant === 'cancel') cancel()
      else if (!this.allows(job, false)) controller.abort(pluginError('PLUGIN_NETWORK_DISABLED'))
    }, 250)
    return pluginNetworkGate.run(this.bindNetwork(job), async () => { try {
      job.ownerPid = process.pid; await this.save(job)
      refreshGrant()
      if (existsSync(join(this.directory, job.id + '.cancel')) || job.networkGrant === 'cancel') cancel()
      else if (!this.allows(job, Boolean(input))) controller.abort(pluginError('PLUGIN_NETWORK_DISABLED'))
      controller.signal.throwIfAborted()
      let result
      if (input) {
        const images = await Promise.all((input.referenceImages ?? []).map(async path => {
          if (readReference && path.startsWith('attachment:')) return readReference(path)
          const safe = await within(job.root, path), info = await readFile(safe)
          if (info.length > 20 * 1024 * 1024 || !/\.(?:png|jpg|jpeg|webp)$/i.test(path)) throw pluginError('PLUGIN_REFERENCE_INVALID')
          return { bytes: info, mediaType: /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg' }
        }))
        result = await startGeneration(c, job.kind, input, images, controller.signal)
        if (result.ticket) { job.ticket = result.ticket; job.state = 'running'; await this.save(job) }
      } else if (job.ticket) result = await pollGeneration(c, job.ticket, job.kind, controller.signal)
      else throw pluginError('PLUGIN_SUBMISSION_UNKNOWN')
      while (!result.asset) {
        emit(result.state ?? 'running')
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(t); reject(controller.signal.reason) }
          const t = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 2000)
          controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort()
        })
        result = await pollGeneration(c, job.ticket!, job.kind, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      }
      const media = await materialize(c, result.asset, controller.signal)
      const group = media.mediaType.split('/')[0]
      if (group !== (job.kind === 'image' ? 'image' : job.kind === 'video' ? 'video' : 'audio')) throw pluginError('PLUGIN_MEDIA_TYPE_INVALID')
      const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' }
      const ext = extensions[media.mediaType]
      if (!ext) throw pluginError('PLUGIN_MEDIA_TYPE_INVALID')
      if (!/^[A-Za-z0-9_-]+$/.test(job.runId)) throw pluginError('PLUGIN_JOB_INVALID')
      let directory = job.root
      for (const part of ['.pulse-generated', job.runId, job.id]) {
        directory = join(directory, part); await within(job.root, directory); await mkdir(directory, { recursive: true }); await within(job.root, directory)
      }
      const path = join(directory, 'output.' + ext)
      await within(job.root, path)
      await writeFile(path, media.bytes, { flag: 'wx', mode: 0o600 }).catch(async e => {
        if (e.code !== 'EEXIST' || !media.bytes.equals(await readFile(path))) throw e
      })
      job.output = { jobId: job.id, path: relative(job.root, path).replaceAll('\\', '/'), hash: createHash('sha256').update(media.bytes).digest('hex'), bytes: media.bytes.length, mediaType: media.mediaType, label: job.kind + ' generation' }
      job.state = 'succeeded'; await this.save(job); emit('succeeded'); return job.output
    } catch (e) {
      const cancelled = controller.signal.aborted || ['PLUGIN_NETWORK_DISABLED', 'PLUGIN_CANCELLED'].includes(safeError(e))
      job.error = controller.signal.aborted ? safeError(controller.signal.reason) : safeError(e)
      if (job.error === 'PLUGIN_HOST_SHUTDOWN') { job.state = job.ticket ? 'running' : 'unknown'; delete job.ownerPid; await this.save(job); throw pluginError(job.error) }
      job.state = cancelled ? 'cancelled' : !job.ticket && job.state === 'submitting' && ['PLUGIN_NETWORK_ERROR', 'PLUGIN_SUBMISSION_UNKNOWN'].includes(job.error) ? 'unknown' : 'failed'
      if (job.state === 'unknown') job.error = 'PLUGIN_SUBMISSION_UNKNOWN'
      if (cancelled && !job.ticket) job.remoteCancellation = 'unsupported'
      if (cancelled && job.ticket) job.remoteCancellation = 'unsupported'
      const grantedCancel = job.networkGrant === 'cancel' || existsSync(join(this.directory, job.id + '.cancel'))
      if (cancelled && job.ticket && !this.hardOff() && (this.config().allowNetwork === true || grantedCancel)) {
        try { job.remoteCancellation = await cancelGeneration(c, job.ticket, AbortSignal.timeout(5000)) ? 'requested' : 'unsupported' } catch { job.remoteCancellation = 'failed' }
      }
      await this.save(job); throw pluginError(job.error)
    } finally { clearInterval(watch); clearTimeout(timer); parent.removeEventListener('abort', cancel) } })
  }
}
