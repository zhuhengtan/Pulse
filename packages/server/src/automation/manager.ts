import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { BrowserBackend } from './browser.js'
import { DesktopBackend } from './desktop.js'
import { automationActionSchema, automationError, type AutomationBackend, type AutomationConfig, type AutomationSessionView, type BackendObservation } from './types.js'

interface Session { view: AutomationSessionView; backend: AutomationBackend; observation?: BackendObservation; lease?: string; leaseUntil?: number; tail: Promise<unknown>; releaseLock: () => Promise<void>; actionIds: Map<string, unknown>; lastFrame?: string; unchanged: number; hash?: string; recovering?: boolean; resource: string; activeController?: AbortController }
export type BackendFactory = (kind: 'browser' | 'computer', config: AutomationConfig, workspace: string, profile: string) => AutomationBackend

async function acquireLock(resource: string): Promise<() => Promise<void>> {
  const root = join(tmpdir(), `pulse-automation-${createHash('sha256').update(userInfo().username).digest('hex').slice(0, 16)}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, createHash('sha256').update(resource).digest('hex') + '.lock'), nonce = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.close()
      return async () => { const value = await readFile(path, 'utf8').catch(() => ''); if (value.includes(nonce)) await unlink(path).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const value = await readFile(path, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
      if (!value || !Number.isInteger(value.pid)) throw automationError('AUTOMATION_RESOURCE_BUSY')
      try { process.kill(value.pid, 0); throw automationError('AUTOMATION_RESOURCE_BUSY') } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause }
      // Elect one stale-owner reclaimer. A second claimant must not unlink a
      // fresh owner's lock between the dead-pid check and our next open().
      const reclaimPath = path + '.reclaim'
      const reclaim = await open(reclaimPath, 'wx', 0o600).catch(() => { throw automationError('AUTOMATION_RESOURCE_BUSY') })
      try {
        const current = await readFile(path, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
        if (current?.nonce !== value.nonce || current?.pid !== value.pid) throw automationError('AUTOMATION_RESOURCE_BUSY')
        await unlink(path)
      } finally { await reclaim.close(); await unlink(reclaimPath).catch(() => undefined) }
    }
  }
  throw automationError('AUTOMATION_RESOURCE_BUSY')
}

export class AutomationSessionManager {
  private readonly sessions = new Map<string, Session>()
  private initialized: Promise<void> | undefined
  private controls: Promise<unknown> = Promise.resolve()
  constructor(readonly dataDir: string, private config: AutomationConfig = {}, private allowNetwork = false, private readonly factory?: BackendFactory, private networkHosts?: string[]) {}
  configure(config: AutomationConfig, allowNetwork: boolean, networkHosts?: string[]): void { this.config = structuredClone(config); this.allowNetwork = allowNetwork; this.networkHosts = networkHosts }
  private backend(kind: 'browser' | 'computer', config: AutomationConfig, workspace: string, profile: string): AutomationBackend { return this.factory ? this.factory(kind, config, workspace, profile) : kind === 'browser' ? new BrowserBackend(config.browser ?? {}, workspace, profile, this.allowNetwork, this.networkHosts) : new DesktopBackend(config.computer?.helperPath, config.computer?.displayId) }
  init(): Promise<void> { return this.initialized ??= this.load() }
  private async load(): Promise<void> {
    const directory = join(this.dataDir, 'automation', 'sessions')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      const stored = await readFile(join(directory, name), 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
      const view = stored?.view as AutomationSessionView | undefined
      if (stored?.version !== 1 || !view || name !== view.id + '.json' || !['browser', 'computer'].includes(view.kind) || typeof view.owner !== 'string' || typeof view.workspace !== 'string' || typeof stored.resource !== 'string' || !Array.isArray(stored.receipts) || view.state === 'closed') continue
      const profile = this.profile(view.workspace, view.conversationId)
      const config = structuredClone(this.config)
      if (view.kind === 'browser') config.browser = { ...config.browser, mode: view.mode === 'existing' ? 'existing' : 'dedicated' }
      delete view.frameId; delete view.controller; delete view.tabs
      view.reconnectRequired = true
      if (view.kind === 'browser' && view.conversationId) view.owner = `conversation:${view.conversationId}`
      view.state = stored.receipts.some((entry: any) => entry?.[1]?.status === 'unknown') ? 'unknown' : 'paused'
      this.sessions.set(view.id, { view, backend: this.backend(view.kind, config, view.workspace, profile), tail: Promise.resolve(), releaseLock: async () => undefined, actionIds: new Map(stored.receipts), unchanged: 0, recovering: true, resource: stored.resource })
    }
  }
  private async save(session: Session): Promise<void> {
    const directory = join(this.dataDir, 'automation', 'sessions')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, session.view.id + '.json'), temporary = path + '.' + randomUUID()
    await writeFile(temporary, JSON.stringify({ version: 1, view: session.view, resource: session.resource, receipts: [...session.actionIds] }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  }
  list(owner?: string): AutomationSessionView[] { return [...this.sessions.values()].filter(session => owner === undefined || session.view.owner === owner).map(session => { this.expire(session); return { ...session.view } }) }
  private session(id: string, owner?: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.view.state === 'closed') throw automationError('AUTOMATION_SESSION_NOT_FOUND')
    if (owner !== undefined && session.view.owner !== owner) throw automationError('AUTOMATION_SESSION_NOT_OWNED')
    this.expire(session)
    return session
  }
  private expire(session: Session): void {
    if (session.view.state === 'human' && (session.leaseUntil ?? 0) < Date.now()) { session.view.state = 'paused'; delete session.view.controller; delete session.lease; void session.backend.release() }
  }
  private async serial<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const work = session.tail.catch(() => undefined).then(operation)
    session.tail = work
    return work
  }
  private profile(workspace: string, conversationId?: string): string {
    const base = this.config.browser?.profileDir ?? join(this.dataDir, 'automation', 'profiles')
    return resolve(conversationId ? join(base, createHash('sha256').update(workspace + '\0' + conversationId).digest('hex').slice(0, 20)) : this.config.browser?.profileDir ?? join(base, createHash('sha256').update(workspace).digest('hex').slice(0, 20)))
  }
  async open(kind: 'browser' | 'computer', owner: string, workspace: string, mode?: 'dedicated' | 'existing', scope?: { conversationId: string; projectId?: string }): Promise<AutomationSessionView> {
    await this.init()
    if (!['browser', 'computer'].includes(kind) || !owner) throw automationError('INVALID_AUTOMATION_SESSION')
    workspace = resolve(workspace)
    if (kind === 'browser' && scope) {
      const existing = [...this.sessions.values()].find(item => item.view.kind === 'browser' && item.view.conversationId === scope.conversationId && item.view.state !== 'closed')
      if (existing) {
        if (existing.view.workspace !== workspace || mode && existing.view.mode !== mode) throw automationError('AUTOMATION_SESSION_SCOPE_CONFLICT')
        if (existing.view.owner !== owner && !existing.view.owner.startsWith('conversation:') && !existing.view.owner.startsWith('device:')) throw automationError('AUTOMATION_RESOURCE_BUSY')
        if (!owner.startsWith('device:') && existing.view.state !== 'human') await this.control(existing.view.id, 'resume', owner)
        existing.view.owner = owner
        await this.save(existing)
        return { ...existing.view }
      }
    }
    const config = structuredClone(this.config)
    if (kind === 'browser' && mode) config.browser = { ...config.browser, mode }
    const profile = this.profile(workspace, scope?.conversationId)
    const resource = kind === 'computer' ? `desktop:${process.env.XDG_SESSION_ID ?? 'local'}` : config.browser?.mode === 'existing' ? 'browser:existing' : `browser:${profile}`
    const releaseLock = await acquireLock(resource)
    try {
      await mkdir(join(this.dataDir, 'automation', 'frames'), { recursive: true, mode: 0o700 })
      if (kind === 'browser' && config.browser?.mode !== 'existing') await mkdir(profile, { recursive: true, mode: 0o700 })
      const view: AutomationSessionView = { id: randomUUID(), kind, owner, workspace, ...(scope ?? {}), mode: kind === 'browser' ? config.browser?.mode ?? 'dedicated' : 'desktop', state: owner.startsWith('device:') || [...this.sessions.values()].some(session => session.view.state === 'human') ? 'paused' : 'ai', actionCount: 0 }
      const session: Session = { view, backend: this.backend(kind, config, workspace, profile), tail: Promise.resolve(), releaseLock, actionIds: new Map(), unchanged: 0, resource }
      this.sessions.set(view.id, session)
      await this.save(session)
      return { ...view }
    } catch (error) { await releaseLock(); throw error }
  }
  async observe(id: string, owner?: string, signal?: AbortSignal, includeImage = true): Promise<Record<string, unknown>> {
    const session = this.session(id, owner)
    if (session.recovering) throw automationError('AUTOMATION_RECONNECT_REQUIRED')
    return this.serial(session, async () => {
      const controller = session.activeController = new AbortController()
      let observation: BackendObservation
      try { observation = await session.backend.observe(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) } finally { delete session.activeController }
      const bytes = Buffer.from(observation.image.data, 'base64')
      if (!['image/png', 'image/jpeg'].includes(observation.image.mediaType) || bytes.length > 3 * 1024 * 1024 || bytes.length < 16 || !Number.isInteger(observation.width) || !Number.isInteger(observation.height) || observation.width < 1 || observation.height < 1) throw automationError('INVALID_AUTOMATION_IMAGE')
      if ((observation.image.mediaType === 'image/png' && bytes.readUInt32BE(0) !== 0x89504e47) || (observation.image.mediaType === 'image/jpeg' && bytes.readUInt16BE(0) !== 0xffd8)) throw automationError('INVALID_AUTOMATION_IMAGE')
      const frameId = randomUUID()
      await writeFile(join(this.dataDir, 'automation', 'frames', frameId), bytes, { mode: 0o600, flag: 'wx' })
      if (session.lastFrame) await unlink(join(this.dataDir, 'automation', 'frames', session.lastFrame)).catch(() => undefined)
      session.lastFrame = frameId
      const hash = createHash('sha256').update(bytes).digest('hex')
      session.unchanged = session.hash === hash ? session.unchanged : 0
      session.hash = hash; session.observation = observation
      Object.assign(session.view, { frameId, frameWidth: observation.width, frameHeight: observation.height, title: observation.title, url: observation.url, observedAt: new Date().toISOString(), ...(observation.tabs ? { tabs: observation.tabs } : {}) })
      return { ...session.view, text: observation.text ?? '', geometry: observation.geometry ?? '', ...(includeImage ? { pulseImage: observation.image } : {}) }
    })
  }
  async frame(id: string): Promise<{ bytes: Buffer; mediaType: string }> {
    const session = this.session(id)
    if (!session.view.frameId || !session.observation) throw automationError('AUTOMATION_FRAME_MISSING')
    return { bytes: await readFile(join(this.dataDir, 'automation', 'frames', session.view.frameId)), mediaType: session.observation.image.mediaType }
  }
  screenshotPath(id: string): string | undefined { const session = this.session(id); return session.view.frameId ? join(this.dataDir, 'automation', 'frames', session.view.frameId) : undefined }
  async command(id: string, method: string, params: Record<string, unknown>, owner?: string, signal?: AbortSignal): Promise<unknown> {
    const session = this.session(id, owner)
    return this.serial(session, async () => {
      if (session.view.state !== 'ai') throw automationError('AUTOMATION_PAUSED')
      const controller = session.activeController = new AbortController()
      let result: unknown
      try { result = await session.backend.call(method, params, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) } finally { delete session.activeController }
      if (method === 'tabs') session.view.tabs = result as NonNullable<AutomationSessionView['tabs']>
      else { delete session.view.frameId; delete session.observation; delete session.view.tabs }
      return result
    })
  }
  async act(id: string, frameId: string, input: unknown, requestId: string, owner?: string, lease?: string, signal?: AbortSignal): Promise<unknown> {
    const session = this.session(id, owner)
    const action = automationActionSchema.parse(input)
    return this.serial(session, async () => {
      if (session.actionIds.has(requestId)) return session.actionIds.get(requestId)
      if (owner !== undefined ? session.view.state !== 'ai' : session.view.state !== 'human' || lease !== session.lease) throw automationError('AUTOMATION_CONTROL_REQUIRED')
      if (!session.observation || frameId !== session.view.frameId) throw automationError('STALE_AUTOMATION_FRAME')
      if (session.view.actionCount >= 200 || session.unchanged >= 3) { session.view.state = 'paused'; throw automationError('AUTOMATION_PROGRESS_LIMIT') }
      const observation = session.observation
      if (session.view.kind === 'computer' || session.view.kind === 'browser') {
        const controller = session.activeController = new AbortController()
        let current: BackendObservation
        try { current = await session.backend.observe(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) } finally { delete session.activeController }
        if (controller.signal.aborted || (owner !== undefined ? session.view.state !== 'ai' : session.view.state !== 'human' || lease !== session.lease)) throw automationError('AUTOMATION_CANCELLED')
        if (current.geometry !== observation.geometry) { delete session.view.frameId; throw automationError('AUTOMATION_GEOMETRY_CHANGED') }
      }
      const receipt = { requestId, status: 'unknown' }
      session.actionIds.set(requestId, receipt)
      await this.save(session)
      if (signal?.aborted || (owner !== undefined ? session.view.state !== 'ai' : session.view.state !== 'human' || lease !== session.lease)) {
        session.actionIds.set(requestId, { requestId, status: 'cancelled' }); await this.save(session)
        throw automationError('AUTOMATION_CANCELLED')
      }
      session.view.actionCount++; session.unchanged++
      try {
        const controller = session.activeController = new AbortController()
        try { await session.backend.act(action, observation, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) } finally { delete session.activeController }
        const applied = { requestId, status: 'applied' }
        session.actionIds.set(requestId, applied)
        await this.save(session)
        if (session.view.state === 'human') session.leaseUntil = Date.now() + 30000
        delete session.view.frameId; delete session.observation
        return applied
      } catch (error) {
        session.view.state = 'unknown'; session.view.error = 'ACTION_RESULT_UNKNOWN'; await this.save(session); await session.backend.release(); throw error
      }
    })
  }
  control(id: string, action: 'pause' | 'takeover' | 'resume' | 'close', device: string): Promise<Record<string, unknown>> {
    if (action === 'pause' || action === 'close') { const session = this.session(id); session.view.state = 'paused'; session.activeController?.abort() }
    const operation = this.controls.catch(() => undefined).then(() => this.changeControl(id, action, device))
    this.controls = operation
    return operation
  }
  private async changeControl(id: string, action: 'pause' | 'takeover' | 'resume' | 'close', device: string): Promise<Record<string, unknown>> {
    const session = this.session(id)
    for (const other of this.sessions.values()) this.expire(other)
    if (action === 'resume' && [...this.sessions.values()].some(other => other !== session && other.view.state === 'human')) throw automationError('AUTOMATION_CONTROL_BUSY')
    if (session.view.state === 'human' && session.view.controller !== device && action === 'takeover') throw automationError('AUTOMATION_CONTROL_BUSY')
    if (action === 'takeover') {
      if ([...this.sessions.values()].some(other => other !== session && other.view.state === 'human')) throw automationError('AUTOMATION_CONTROL_BUSY')
      for (const other of this.sessions.values()) if (other !== session && other.view.state === 'ai') { other.view.state = 'paused'; other.activeController?.abort(); await this.save(other) }
    }
    // Block further AI commands before waiting for an in-flight operation.
    if (action !== 'resume') session.view.state = 'paused'
    if (action !== 'resume') session.activeController?.abort()
    return this.serial(session, async () => {
      if (session.recovering && ['takeover', 'resume'].includes(action)) {
        session.releaseLock = await acquireLock(session.resource)
        const config = structuredClone(this.config)
        if (session.view.kind === 'browser') config.browser = { ...config.browser, mode: session.view.mode === 'existing' ? 'existing' : 'dedicated' }
        const profile = this.profile(session.view.workspace, session.view.conversationId)
        session.backend = this.backend(session.view.kind, config, session.view.workspace, profile)
        session.recovering = false
        delete session.view.reconnectRequired
      }
      await session.backend.release()
      if (action === 'takeover') { session.view.state = 'human'; session.view.controller = device; session.lease = randomUUID(); session.leaseUntil = Date.now() + 30000 }
      else if (action === 'resume') { session.view.state = 'ai'; delete session.lease; delete session.view.controller; session.unchanged = 0; delete session.view.frameId; delete session.observation }
      else if (action === 'close') { await session.backend.close(); await session.releaseLock(); session.view.state = 'closed'; delete session.lease }
      await this.save(session)
      return { ...session.view, ...(session.lease ? { lease: session.lease } : {}) }
    })
  }
  async releaseOwner(owner: string): Promise<void> {
    for (const view of this.list(owner).filter(item => item.state !== 'closed')) {
      if (view.kind !== 'browser' || !view.conversationId) { await this.control(view.id, 'close', owner); continue }
      const session = this.session(view.id, owner)
      if (session.view.state !== 'human') await this.control(view.id, 'pause', owner)
      session.view.owner = `conversation:${view.conversationId}`
      await this.save(session)
    }
  }
  async closeOwner(owner: string): Promise<void> { await Promise.all(this.list(owner).filter(session => session.state !== 'closed').map(session => this.control(session.id, 'close', owner))) }
  heartbeat(id: string, device: string, lease: string): void { const session = this.session(id); if (session.view.controller !== device || session.lease !== lease || session.view.state !== 'human') throw automationError('AUTOMATION_CONTROL_REQUIRED'); session.leaseUntil = Date.now() + 30000 }
  async wait(id: string, owner: string, signal?: AbortSignal): Promise<void> {
    const session = this.session(id, owner)
    if (session.view.state === 'ai') return
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => { clearInterval(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      const abort = () => done(automationError('AUTOMATION_CANCELLED'))
      const timer = setInterval(() => { this.expire(session); if (session.view.state === 'ai') done(); else if (session.view.state === 'closed') done(automationError('AUTOMATION_SESSION_CLOSED')) }, 100)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  async manualCommand(id: string, method: string, params: Record<string, unknown>, device: string, lease: string): Promise<unknown> {
    if (!['navigate', 'newTab', 'closeTab', 'selectTab', 'reload', 'back', 'tabs', 'selectWindow', 'windows', 'displays', 'downloads'].includes(method)) throw automationError('AUTOMATION_METHOD_NOT_ALLOWED')
    this.heartbeat(id, device, lease)
    const session = this.session(id)
    return this.serial(session, async () => {
      this.heartbeat(id, device, lease)
      const result = await session.backend.call(method, params)
      if (method === 'tabs') session.view.tabs = result as NonNullable<AutomationSessionView['tabs']>
      else { delete session.view.frameId; delete session.observation; delete session.view.tabs }
      return result
    })
  }
  async suspend(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.view.state === 'closed' || session.recovering) continue
      session.view.state = 'paused'
      await this.serial(session, async () => {
        await session.backend.close(); await session.releaseLock(); session.recovering = true
        delete session.view.controller; delete session.lease; delete session.view.frameId; delete session.observation
        await this.save(session)
      })
    }
  }
  async close(): Promise<void> { for (const session of this.list()) if (session.state !== 'closed') await this.control(session.id, 'close', 'shutdown') }
}
