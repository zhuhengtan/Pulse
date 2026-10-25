import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { componentSchema, compatible, compareVersion, indexSchema, releaseId, type ComponentManifest, type ComponentMetadata, type InstalledComponent, type Selection, type UpdateState } from './contracts.js'
import { assertUpdateUrl, fetchBytes, readJson, sha256, signedValue, trustedKeys, verifyFiles } from './security.js'
import { atomicJson, atomicWrite, readState, scopeId, statePath, updateRoot, withUpdateLock } from './store.js'
import { downloadArtifact, extractArtifact } from './archive.js'
import { backendModuleVersions, bundledFrontendVersion } from './versions.js'

export interface UpdateOptions {
  root?: string; dataDir: string; backendVersion: string; runtimeDirectory?: string; frontendDirectory?: string;
  shellVersion?: string; chromium?: number; development?: boolean; indexUrl?: string; keys?: Record<string, string>;
}
export const defaultIndexUrl = 'https://zhuhengtan.github.io/Pulse/updates/stable.json'
export class UpdateManager {
  readonly root: string
  private timer: NodeJS.Timeout | undefined
  private attempts = 0
  private checking: Promise<void> | undefined
  private downloading: Promise<void> | undefined
  private downloadProgress: UpdateState['progress']
  private verifiedFrontends = new Map<string, ComponentManifest['files']>()
  private registeredShell: string | undefined
  private shellRegistration: Promise<void> | undefined
  private moduleVersions: ReturnType<typeof backendModuleVersions> | undefined
  constructor(readonly options: UpdateOptions) { this.root = resolve(options.root ?? updateRoot()) }
  private keys(): Record<string, string> { return this.options.keys ?? trustedKeys }
  context(backend = this.options.backendVersion, remembered?: UpdateState['shell']) {
    const shell = this.options.shellVersion ?? remembered?.version, chromium = this.options.chromium ?? remembered?.chromium
    return { backend, data: 1, ...(shell ? { shell } : {}), ...(chromium ? { chromium } : {}) }
  }
  async registerShell(version: string, chromium: number): Promise<void> {
    this.options.shellVersion = version; this.options.chromium = chromium
    const identity = `${version}:${chromium}`
    if (this.registeredShell === identity) return
    if (!this.shellRegistration) this.shellRegistration = this.mutate(async state => { state.shell = { version, chromium } }).then(() => { this.registeredShell = identity }).finally(() => { this.shellRegistration = undefined })
    return this.shellRegistration
  }
  async status(local = true) {
    const state = await readState(this.root, this.options.dataDir)
    const frontend = state.active.frontend
    const publicState = { frontend: frontend ? releaseId(frontend.manifest) : 'bundled', frontendVersion: frontend?.manifest.version ?? await bundledFrontendVersion(this.options.frontendDirectory), protocols: { http: 1, events: 1 } }
    if (!local) return publicState
    return { ...state, ...publicState, progress: this.downloadProgress ?? state.progress,
      lastBackend: state.lastBackend ? { version: state.lastBackend.manifest.version } : undefined,
      running: { backend: this.options.backendVersion, shell: this.options.shellVersion ?? state.shell?.version, runtimeDirectory: this.options.runtimeDirectory },
      modules: await (this.moduleVersions ??= backendModuleVersions()),
      environment: { node: process.versions.node, chromium: this.options.chromium ?? state.shell?.chromium },
      enabled: !this.options.development, trusted: Object.keys(this.keys()).length > 0,
      // Paths, envelopes and key material are not needed in the management UI.
      active: this.summary(state.active), previous: state.previous ? this.summary(state.previous) : undefined,
      staged: state.staged ? this.summary(state.staged) : undefined,
      available: state.available.map(({ component, version, notes, artifact, requires }) => ({ component, version, notes, downloadUrl: artifact.url, bytes: artifact.bytes, requires })),
    }
  }
  private summary(selection: Selection) { return Object.fromEntries(Object.entries(selection).map(([key, item]) => [key, { version: item.manifest.version, id: releaseId(item.manifest) }])) }
  async settings(autoDownload: boolean): Promise<void> {
    await this.mutate(async state => { state.autoDownload = autoDownload })
  }
  private async mutate(work: (state: UpdateState) => Promise<void>): Promise<void> {
    await withUpdateLock(this.root, async () => { const state = await readState(this.root, this.options.dataDir); await work(state); await atomicJson(statePath(this.root, this.options.dataDir), state) })
  }
  async check(): Promise<void> {
    if (this.checking) return this.checking
    this.checking = this.runCheck().finally(() => { this.checking = undefined })
    return this.checking
  }
  private async runCheck(): Promise<void> {
    await this.mutate(async state => {
      if (this.options.development && !this.options.indexUrl) throw new Error('UPDATE_DEVELOPMENT_DISABLED')
      state.phase = 'checking'; delete state.error
      await atomicJson(statePath(this.root, this.options.dataDir), state)
      try {
        const bytes = await fetchBytes(this.options.indexUrl ?? defaultIndexUrl, 4 * 1024 ** 2, this.options.development)
        const index = signedValue(JSON.parse(bytes.toString()), indexSchema, this.keys()).value
        if (index.sequence < state.sequence || Date.parse(index.expiresAt) < Date.now()) throw new Error('UPDATE_INDEX_STALE')
        const manifests: ComponentMetadata[] = []
        for (const ref of index.releases) {
          if (ref.platform !== 'any' && ref.platform !== process.platform || ref.arch !== 'any' && ref.arch !== process.arch) continue
          const cache = join(this.root, 'updates', 'metadata', ref.sha256 + '.json')
          const data = await readFile(cache).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return fetchBytes(ref.url, 32 * 1024 ** 2, this.options.development) })
          if (createHash('sha256').update(data).digest('hex') !== ref.sha256) throw new Error('UPDATE_MANIFEST_DIGEST_INVALID')
          const { value: manifest } = signedValue(JSON.parse(data.toString()), componentSchema, this.keys())
          assertUpdateUrl(manifest.artifact.url, this.options.development)
          if ((['component', 'version', 'platform', 'arch'] as const).some(key => manifest[key] !== ref[key])) throw new Error('UPDATE_MANIFEST_IDENTITY_INVALID')
          // Keep the signed envelope next to its immutable manifest; never trust index URLs alone.
          await atomicJson(join(this.root, 'updates', 'manifests', releaseId(manifest) + '.json'), JSON.parse(data.toString()))
          await atomicWrite(cache, data)
          const { files: _files, ...metadata } = manifest
          manifests.push(metadata)
        }
        state.available = manifests.sort((a, b) => compareVersion(b.version, a.version)); state.sequence = index.sequence
        state.checkedAt = new Date().toISOString(); state.phase = state.pending ? 'waiting' : state.staged ? 'ready' : 'idle'; this.attempts = 0
      } catch (error) { state.phase = state.pending ? 'waiting' : 'failed'; state.error = error instanceof Error ? error.message : 'UPDATE_CHECK_FAILED' }
    })
  }
  /** Resolve the newest compatible backend/frontend pair, including a frontend-only release. */
  select(state: UpdateState): ComponentMetadata[] {
    const baseBackend = state.active.backend?.manifest.version ?? this.options.backendVersion
    const candidates = state.available.filter(m => !state.failed.includes(releaseId(m)))
    const backends = candidates.filter(m => m.component === 'backend' && compareVersion(m.version, baseBackend) > 0 && !compatible(m, this.context(undefined, state.shell)).length)
    const backend = backends[0], backendVersion = backend?.version ?? baseBackend
    const currentFrontend = state.active.frontend?.manifest.version ?? '0.0.0'
    const frontend = candidates.find(m => m.component === 'frontend' && compareVersion(m.version, currentFrontend) > 0 && !compatible(m, this.context(backendVersion, state.shell)).length)
    state.blocked = [...new Set(candidates.filter(m => m.component !== 'shell').flatMap(m => compatible(m, this.context(backendVersion, state.shell))))]
    return [backend, frontend].filter((m): m is ComponentMetadata => Boolean(m))
  }
  async download(retry = false): Promise<void> {
    if (this.downloading) return this.downloading
    this.downloading = this.runDownload(retry).finally(() => { this.downloading = undefined })
    return this.downloading
  }
  private async runDownload(retry: boolean): Promise<void> {
    await this.mutate(async state => {
      if (state.phase === 'applying') throw new Error('UPDATE_BUSY')
      if (state.pending) throw new Error('UPDATE_ALREADY_SCHEDULED')
      if (retry) state.failed = []
      const selection: Selection = {}; state.phase = 'downloading'
      await atomicJson(statePath(this.root, this.options.dataDir), state)
      try {
        for (const metadata of this.select(state)) {
          const id = releaseId(metadata), destination = join(this.root, 'updates', 'components', id)
          const envelope = await readJson(join(this.root, 'updates', 'manifests', id + '.json'), undefined)
          const verified = signedValue(envelope, componentSchema, this.keys())
          const manifest = verified.value
          const { files: _files, ...signedMetadata } = manifest
          if (JSON.stringify(signedMetadata) !== JSON.stringify(metadata)) throw new Error('UPDATE_MANIFEST_IDENTITY_INVALID')
          if (!await verifyFiles(destination, manifest).then(() => true, () => false)) {
            // A corrupt existing version may still be mapped by a process. Do not replace it.
            if (await access(destination).then(() => true, () => false)) throw new Error('UPDATE_COMPONENT_DAMAGED')
            const temp = join(this.root, 'updates', 'staging', randomUUID()), archive = temp + '.zip'
            await mkdir(temp, { recursive: true, mode: 0o700 })
            try {
              await downloadArtifact(archive, manifest, received => { this.downloadProgress = { component: manifest.component, received, total: manifest.artifact.bytes } }, Boolean(this.options.development))
              await extractArtifact(archive, temp, manifest)
              await atomicJson(join(temp, 'component.json'), verified.envelope)
              await mkdir(dirname(destination), { recursive: true }); await rename(temp, destination)
            } finally { await rm(temp, { recursive: true, force: true }); await rm(archive, { force: true }) }
          }
          selection[manifest.component as 'backend' | 'frontend'] = { directory: destination, manifest: metadata }
        }
        if (Object.keys(selection).length) { state.staged = { ...state.active, ...selection }; state.phase = 'ready' }
        else state.phase = state.staged ? 'ready' : 'idle'
        delete state.error
      } catch (error) { state.phase = 'failed'; state.error = error instanceof Error ? error.message : 'UPDATE_DOWNLOAD_FAILED' }
      finally { this.downloadProgress = undefined }
    })
  }
  async requestApply(rollback = false): Promise<void> {
    await this.mutate(async state => {
      if (rollback) {
        if (!state.previous) throw new Error('UPDATE_NO_PREVIOUS_VERSION')
        for (const item of Object.values(state.previous)) if (compatible(item.manifest, this.context(state.previous.backend?.manifest.version, state.shell)).length) throw new Error('UPDATE_ROLLBACK_INCOMPATIBLE')
        for (const [component, item] of Object.entries(state.active)) if (state.previous[component as 'backend' | 'frontend']?.directory !== item.directory) state.failed = [...new Set([...state.failed, releaseId(item.manifest)])]
        state.staged = state.previous
      }
      if (!state.staged) throw new Error('UPDATE_NOT_DOWNLOADED')
      for (const item of Object.values(state.staged)) if (compatible(item.manifest, this.context(state.staged.backend?.manifest.version, state.shell)).length) throw new Error('UPDATE_INCOMPATIBLE')
      state.pending = true; state.phase = 'waiting'
    })
  }
  async recordBlocked(reasons: string[]): Promise<void> {
    const state = await readState(this.root, this.options.dataDir)
    if (state.pending && JSON.stringify(state.blocked) !== JSON.stringify(reasons)) await this.mutate(async state => { state.blocked = reasons })
  }
  async applyFrontend(): Promise<boolean> {
    let applied = false
    await this.mutate(async state => {
      if (!state.pending || !state.staged || state.staged.backend?.directory !== state.active.backend?.directory) return
      for (const item of Object.values(state.staged)) { await this.verifyInstalled(item); if (compatible(item.manifest, this.context(state.staged.backend?.manifest.version, state.shell)).length) throw new Error('UPDATE_INCOMPATIBLE') }
      state.previous = state.active; state.active = state.staged; delete state.staged; state.pending = false; state.phase = 'idle'; state.blocked = []; applied = true
    })
    return applied
  }
  async verifyInstalled(item: InstalledComponent): Promise<ComponentManifest> {
    if (resolve(item.directory) !== join(this.root, 'updates', 'components', releaseId(item.manifest))) throw new Error('UPDATE_SELECTION_INVALID')
    const manifest = signedValue(await readJson(join(item.directory, 'component.json'), undefined), componentSchema, this.keys()).value
    const { files: _files, ...metadata } = manifest
    if (JSON.stringify(metadata) !== JSON.stringify(item.manifest)) throw new Error('UPDATE_SELECTION_INVALID')
    await verifyFiles(item.directory, manifest)
    return manifest
  }
  async frontend(id?: string): Promise<{ directory: string; id: string; version: string; files: ComponentManifest['files'] } | undefined> {
    const state = await readState(this.root, this.options.dataDir)
    let item = state.active.frontend
    if (id) {
      if (!/^frontend-\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(id)) return undefined
      const directory = join(this.root, 'updates', 'components', id)
      const envelope = await readJson(join(directory, 'component.json'), undefined)
      if (!envelope) return undefined
      const manifest = signedValue(envelope, componentSchema, this.keys()).value
      if (releaseId(manifest) !== id || manifest.component !== 'frontend') throw new Error('UPDATE_SELECTION_INVALID')
      const { files: _files, ...metadata } = manifest
      item = { directory, manifest: metadata }
    }
    if (!item) return undefined
    let files = this.verifiedFrontends.get(item.directory)
    if (!files) { files = (await this.verifyInstalled(item)).files; this.verifiedFrontends.set(item.directory, files) }
    return { directory: item.directory, id: releaseId(item.manifest), version: item.manifest.version, files }
  }
  start(onPending: () => Promise<void>): void {
    if (this.options.development && !this.options.indexUrl) return
    let nextCheck = 0
    const tick = async () => {
      try {
        if (Date.now() >= nextCheck) {
          await this.check(); const state = await readState(this.root, this.options.dataDir)
          nextCheck = Date.now() + (state.error ? Math.min(6 * 3600000, 60000 * 2 ** Math.min(this.attempts++, 8)) : 6 * 3600000)
          if (!state.error && state.autoDownload && !state.pending) { await this.download(); const ready = await readState(this.root, this.options.dataDir); if (ready.staged && !ready.error) await this.requestApply() }
        }
        if ((await readState(this.root, this.options.dataDir)).pending) await onPending()
      } catch { /* A failed update never prevents the running backend from serving. */ }
      finally { if (this.timer) { this.timer = setTimeout(() => { void tick() }, 15000); this.timer.unref() } }
    }
    this.timer = setTimeout(() => { void tick() }, 1000); this.timer.unref()
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
}
