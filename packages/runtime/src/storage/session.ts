import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { AgentRecord, ArtifactRecord, EffectRecord, JsonValue, LaneRecord, MergeProposal, PrivacyLabel, PrivacyMetadata, ResultRecord, RuntimeEvent, RuntimeEventInput, RuntimeState, WaitRecord, ToolCallCorrelation } from '../core/types.js'
import { privacyRank } from '../core/types.js'
import { createRuntimeState } from '../core/types.js'
import { normalizeRuntimeEvent } from '../core/events.js'

export interface SessionSnapshot {
  schemaVersion: 1
  state: {
    now: number
    agents: Array<[string, Omit<AgentRecord, 'globalVersions' | 'globalPrivacy'> & { globalVersions: Array<[number, JsonValue]>; globalPrivacy?: Array<[number, PrivacyMetadata]> }]>
    lanes: Array<[string, Omit<LaneRecord, 'children' | 'ownedEffectIds' | 'visibleResultRefs'> & { children: string[]; ownedEffectIds: string[]; visibleResultRefs?: string[] }]>
    effects: Array<[string, EffectRecord]>
    waits: Array<[string, WaitRecord]>
    results: Array<[string, ResultRecord]>
    artifacts?: Array<[string, ArtifactRecord]>
    toolCallCorrelations?: Array<[string, ToolCallCorrelation]>
    mergeProposals: Array<[string, MergeProposal]>
    events: RuntimeEvent[]
    eventsCompactedThrough?: number
    nextIds: RuntimeState['nextIds']
    maxTotalLanes: number
    maxQueuedEffects: number
    maxRunning: Record<'llm' | 'tool' | 'agent' | 'none', number | 'Infinity'>
    forkAffinity?: 'off' | 'advise' | 'coalesce'
    historySoftTokens?: number
    historyHardTokens?: number
    maxResultSummaryBytes?: number
    trustedSanitizerIds?: string[]
  }
}

export interface RuntimeWarmStartSnapshot {
  schemaVersion: 1
  sessionId: string
  agent: {
    rootLaneId: string
    latestGlobalVersion: number
    globalVersions: Array<[number, JsonValue]>
    globalPrivacy?: Array<[number, PrivacyMetadata]>
  }
  visibleResultRefs: string[]
  results: Array<[string, ResultRecord]>
}

export interface RuntimeSessionStore {
  get(sessionId: string): RuntimeWarmStartSnapshot | undefined
  put(snapshot: RuntimeWarmStartSnapshot): void
}

export interface RuntimeSessionRevision {
  snapshot: RuntimeWarmStartSnapshot
  revision: number
}

export interface VersionedRuntimeSessionStore extends RuntimeSessionStore {
  getWithRevision(sessionId: string): RuntimeSessionRevision | undefined
  putIfRevision(snapshot: RuntimeWarmStartSnapshot, expectedRevision?: number): number
}

export class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly snapshots = new Map<string, RuntimeSessionRevision>()
  get(sessionId: string): RuntimeWarmStartSnapshot | undefined { return this.getWithRevision(sessionId)?.snapshot }
  put(snapshot: RuntimeWarmStartSnapshot): void { this.putIfRevision(snapshot) }
  getWithRevision(sessionId: string): RuntimeSessionRevision | undefined {
    const entry = this.snapshots.get(sessionId)
    return entry === undefined ? undefined : { revision: entry.revision, snapshot: structuredClone(entry.snapshot) }
  }
  putIfRevision(snapshot: RuntimeWarmStartSnapshot, expectedRevision?: number): number {
    validateWarmStartSnapshot(snapshot)
    const current = this.snapshots.get(snapshot.sessionId)
    if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new Error('RUNTIME_SESSION_STORE_CONFLICT')
    const revision = (current?.revision ?? 0) + 1
    this.snapshots.set(snapshot.sessionId, { revision, snapshot: structuredClone(snapshot) })
    return revision
  }
}

interface FileRuntimeSessionEntry extends RuntimeSessionRevision { sessionId: string }
interface FileRuntimeSessionEnvelope { schemaVersion: 1; sessions: FileRuntimeSessionEntry[] }

function validateWarmStartSnapshot(snapshot: RuntimeWarmStartSnapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.sessionId !== 'string' || snapshot.sessionId.length === 0 || !snapshot.agent || !Number.isInteger(snapshot.agent.latestGlobalVersion) || !Array.isArray(snapshot.agent.globalVersions) || !Array.isArray(snapshot.visibleResultRefs) || !Array.isArray(snapshot.results)) throw new Error('INVALID_RUNTIME_SESSION_SNAPSHOT')
}

function emptyRuntimeSessionEnvelope(): FileRuntimeSessionEnvelope { return { schemaVersion: 1, sessions: [] } }

/** Durable synchronous Session Store for hosts that need createAgent() to remain synchronous. */
export class FileRuntimeSessionStore implements VersionedRuntimeSessionStore {
  constructor(readonly filePath: string) {}

  get(sessionId: string): RuntimeWarmStartSnapshot | undefined { return this.getWithRevision(sessionId)?.snapshot }

  getWithRevision(sessionId: string): RuntimeSessionRevision | undefined {
    const entry = this.readEnvelope().sessions.find((candidate) => candidate.sessionId === sessionId)
    return entry === undefined ? undefined : { revision: entry.revision, snapshot: structuredClone(entry.snapshot) }
  }

  put(snapshot: RuntimeWarmStartSnapshot): void { this.putIfRevision(snapshot) }

  putIfRevision(snapshot: RuntimeWarmStartSnapshot, expectedRevision?: number): number {
    validateWarmStartSnapshot(snapshot)
    return this.withLock(() => {
      const envelope = this.readEnvelope()
      const current = envelope.sessions.find((candidate) => candidate.sessionId === snapshot.sessionId)
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new Error('RUNTIME_SESSION_STORE_CONFLICT')
      const revision = (current?.revision ?? 0) + 1
      const next: FileRuntimeSessionEntry = { sessionId: snapshot.sessionId, revision, snapshot: structuredClone(snapshot) }
      envelope.sessions = current === undefined ? [...envelope.sessions, next] : envelope.sessions.map((candidate) => candidate.sessionId === snapshot.sessionId ? next : candidate)
      this.writeEnvelope(envelope)
      return revision
    })
  }

  private readEnvelope(): FileRuntimeSessionEnvelope {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as FileRuntimeSessionEnvelope
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) throw new Error('INVALID_RUNTIME_SESSION_STORE')
      for (const entry of parsed.sessions) {
        if (!entry || typeof entry.sessionId !== 'string' || !Number.isInteger(entry.revision) || entry.revision < 1) throw new Error('INVALID_RUNTIME_SESSION_STORE')
        validateWarmStartSnapshot(entry.snapshot)
      }
      return parsed
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return emptyRuntimeSessionEnvelope()
      if (cause instanceof Error && (cause.message === 'INVALID_RUNTIME_SESSION_STORE' || cause.message === 'INVALID_RUNTIME_SESSION_SNAPSHOT')) throw cause
      throw new Error('INVALID_RUNTIME_SESSION_STORE')
    }
  }

  private writeEnvelope(envelope: FileRuntimeSessionEnvelope): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString()}`
    let handle: number | undefined
    try {
      handle = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(handle, JSON.stringify(envelope), 'utf8')
      fsyncSync(handle)
      closeSync(handle)
      handle = undefined
      renameSync(temporaryPath, this.filePath)
    } finally {
      if (handle !== undefined) closeSync(handle)
      rmSync(temporaryPath, { force: true })
    }
  }

  private withLock<T>(work: () => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lockPath = `${this.filePath}.lock`
    const deadline = Date.now() + 30_000
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    let lock: number | undefined
    while (lock === undefined) {
      try { lock = openSync(lockPath, 'wx', 0o600) }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        const lockStat = statSync(lockPath, { throwIfNoEntry: false })
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { rmSync(lockPath, { force: true }); continue }
        if (Date.now() >= deadline) throw new Error('RUNTIME_SESSION_STORE_LOCK_TIMEOUT')
        Atomics.wait(sleeper, 0, 0, 5)
      }
    }
    try { return work() } finally { closeSync(lock); rmSync(lockPath, { force: true }) }
  }
}

interface RuntimeSessionSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): unknown
}

interface RuntimeSessionSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): RuntimeSessionSqliteStatement
  close(): void
}

type RuntimeSessionSqliteDatabaseConstructor = new (path: string) => RuntimeSessionSqliteDatabase

/** Durable SQLite Session Store with transaction-scoped revision CAS. */
export class SqliteRuntimeSessionStore implements VersionedRuntimeSessionStore {
  private database: RuntimeSessionSqliteDatabase | undefined
  constructor(readonly filePath: string) {}

  get(sessionId: string): RuntimeWarmStartSnapshot | undefined { return this.getWithRevision(sessionId)?.snapshot }

  getWithRevision(sessionId: string): RuntimeSessionRevision | undefined {
    const row = this.open().prepare('SELECT revision, snapshot FROM runtime_sessions WHERE session_id = ?').get(sessionId)
    if (!row || typeof row.revision !== 'number' || typeof row.snapshot !== 'string') return undefined
    const snapshot = JSON.parse(row.snapshot) as RuntimeWarmStartSnapshot
    validateWarmStartSnapshot(snapshot)
    return { revision: row.revision, snapshot: structuredClone(snapshot) }
  }

  put(snapshot: RuntimeWarmStartSnapshot): void { this.putIfRevision(snapshot) }

  putIfRevision(snapshot: RuntimeWarmStartSnapshot, expectedRevision?: number): number {
    validateWarmStartSnapshot(snapshot)
    const database = this.open()
    database.exec('BEGIN IMMEDIATE')
    try {
      const current = database.prepare('SELECT revision FROM runtime_sessions WHERE session_id = ?').get(snapshot.sessionId)
      const currentRevision = current && typeof current.revision === 'number' ? current.revision : undefined
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) throw new Error('RUNTIME_SESSION_STORE_CONFLICT')
      const revision = (currentRevision ?? 0) + 1
      database.prepare('INSERT INTO runtime_sessions (session_id, revision, snapshot) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, snapshot = excluded.snapshot').run(snapshot.sessionId, revision, JSON.stringify(snapshot))
      database.exec('COMMIT')
      return revision
    } catch (cause) {
      try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw cause
    }
  }

  close(): void { this.database?.close(); this.database = undefined }

  private open(): RuntimeSessionSqliteDatabase {
    if (this.database) return this.database
    mkdirSync(dirname(this.filePath), { recursive: true })
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: RuntimeSessionSqliteDatabaseConstructor }
    this.database = new DatabaseSync(this.filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS runtime_sessions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL)')
    return this.database
  }
}

export interface SessionLogExportOptions { maxPrivacy?: PrivacyLabel }
export type SessionLogResult = Omit<ResultRecord, 'value' | 'summary'> & { value?: JsonValue; summary?: JsonValue; redacted?: boolean }
export type SessionLogArtifact = Omit<ArtifactRecord, 'contentBase64'> & { contentBase64?: string; redacted?: boolean }
export interface SessionLogExport {
  schemaVersion: 1
  maxPrivacy: PrivacyLabel
  events: RuntimeEvent[]
  results: SessionLogResult[]
  artifacts: SessionLogArtifact[]
}

export interface RuntimeLogSink {
  append(log: SessionLogExport): Promise<void> | void
}

/** A durable JSONL audit sink. Each successfully returned append is fsync'd. */
export class FileRuntimeLogSink implements RuntimeLogSink {
  private pending: Promise<void> = Promise.resolve()
  constructor(readonly filePath: string) {}
  async append(log: SessionLogExport): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const handle = await open(this.filePath, 'a', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(log)}\n`, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}

export interface HttpRuntimeLogSinkOptions {
  endpoint: string
  headers?: Record<string, string>
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/** Sends privacy-filtered audit exports to a host-owned collector. */
export class HttpRuntimeLogSink implements RuntimeLogSink {
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetcher: typeof globalThis.fetch
  constructor(options: HttpRuntimeLogSinkOptions) {
    if (!options.endpoint) throw new Error('RUNTIME_LOG_ENDPOINT_REQUIRED')
    this.endpoint = options.endpoint
    this.headers = { 'content-type': 'application/json', ...(options.headers ?? {}) }
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('INVALID_RUNTIME_LOG_TIMEOUT')
    this.fetcher = options.fetch ?? globalThis.fetch
  }
  async append(log: SessionLogExport): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(this.endpoint, { method: 'POST', headers: this.headers, body: JSON.stringify(log), signal: controller.signal })
      if (!response.ok) throw new Error(`RUNTIME_LOG_HTTP_${response.status}`)
    } catch (cause) {
      if (controller.signal.aborted) throw new Error('RUNTIME_LOG_HTTP_TIMEOUT')
      throw cause
    } finally { clearTimeout(timer) }
  }
}

function encodeNumber(value: number): number | 'Infinity' { return Number.isFinite(value) ? value : 'Infinity' }
function decodeNumber(value: unknown): number {
  if (value === 'Infinity') return Number.POSITIVE_INFINITY
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error('INVALID_SESSION_SNAPSHOT')
  return value
}

export function exportRuntimeState(state: RuntimeState): SessionSnapshot {
  return {
    schemaVersion: 1,
    state: {
      now: state.now,
      agents: [...state.agents.entries()].map(([id, agent]) => [id, { ...agent, globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, JsonValue]), ...(agent.globalPrivacy === undefined ? {} : { globalPrivacy: [...agent.globalPrivacy.entries()].map(([version, metadata]) => [version, structuredClone(metadata)] as [number, PrivacyMetadata]) }) }] as [string, Omit<AgentRecord, 'globalVersions' | 'globalPrivacy'> & { globalVersions: Array<[number, JsonValue]>; globalPrivacy?: Array<[number, PrivacyMetadata]> }]),
      lanes: [...state.lanes.entries()].map(([id, lane]) => [id, { ...structuredClone(lane), children: [...lane.children], ownedEffectIds: [...lane.ownedEffectIds], ...(lane.visibleResultRefs === undefined ? {} : { visibleResultRefs: [...lane.visibleResultRefs] }) }] as [string, Omit<LaneRecord, 'children' | 'ownedEffectIds' | 'visibleResultRefs'> & { children: string[]; ownedEffectIds: string[]; visibleResultRefs?: string[] }]),
      effects: [...state.effects.entries()].map(([id, effect]) => [id, structuredClone(effect)]),
      waits: [...state.waits.entries()].map(([id, wait]) => [id, structuredClone(wait)]),
      results: [...state.results.entries()].map(([id, result]) => [id, structuredClone(result)]),
      artifacts: [...state.artifacts.entries()].map(([ref, artifact]) => [ref, structuredClone(artifact)]),
      toolCallCorrelations: [...state.toolCallCorrelations.entries()].map(([id, correlation]) => [id, structuredClone(correlation)]),
      mergeProposals: [...state.mergeProposals.entries()].map(([id, proposal]) => [id, structuredClone(proposal)]),
      events: state.events.map((event) => normalizeRuntimeEvent(event as unknown as RuntimeEventInput, event.seq, { sessionId: event.sessionId, timestamp: event.timestamp })),
      ...(state.eventsCompactedThrough === undefined ? {} : { eventsCompactedThrough: state.eventsCompactedThrough }),
      nextIds: { ...state.nextIds },
      maxTotalLanes: state.maxTotalLanes,
      maxQueuedEffects: state.maxQueuedEffects,
      maxRunning: { llm: encodeNumber(state.maxRunning.llm), tool: encodeNumber(state.maxRunning.tool), agent: encodeNumber(state.maxRunning.agent), none: encodeNumber(state.maxRunning.none) },
      forkAffinity: state.forkAffinity,
      historySoftTokens: state.historySoftTokens,
      historyHardTokens: state.historyHardTokens,
      maxResultSummaryBytes: state.maxResultSummaryBytes,
      trustedSanitizerIds: [...state.trustedSanitizerIds].sort(),
    },
  }
}

export function exportWarmStartSession(state: RuntimeState, sessionId: string): RuntimeWarmStartSnapshot {
  const agent = state.agents.get(sessionId)
  if (!agent) throw new Error(`WARM_START_SOURCE_NOT_FOUND:${sessionId}`)
  const root = state.lanes.get(agent.rootLaneId)
  const laneIds = new Set([...state.lanes.values()].filter((lane) => lane.agentId === sessionId).map((lane) => lane.id))
  const effectIds = new Set([...state.effects.values()].filter((effect) => effect.agentId === sessionId).map((effect) => effect.id))
  const results = [...state.results.entries()].filter(([ref, result]) => (root?.visibleResultRefs?.has(ref) ?? false) || (result.effectId !== undefined && effectIds.has(result.effectId)) || (result.producer?.kind === 'lane' && laneIds.has(result.producer.id)) || (result.producer?.kind === 'effect' && effectIds.has(result.producer.id))).map(([ref, result]) => [ref, structuredClone(result)] as [string, ResultRecord])
  return {
    schemaVersion: 1,
    sessionId,
    agent: {
      rootLaneId: agent.rootLaneId,
      latestGlobalVersion: agent.latestGlobalVersion,
      globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, JsonValue]),
      ...(agent.globalPrivacy === undefined ? {} : { globalPrivacy: [...agent.globalPrivacy.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, PrivacyMetadata]) }),
    },
    visibleResultRefs: [...(root?.visibleResultRefs ?? [])],
    results,
  }
}

function relatedEventPrivacy(state: RuntimeState, event: RuntimeEvent): PrivacyLabel {
  const labels: PrivacyLabel[] = []
  const effect = event.effectId === undefined ? undefined : state.effects.get(event.effectId)
  if (effect?.input && typeof effect.input === 'object' && !Array.isArray(effect.input)) {
    const inputPrivacy = (effect.input as Record<string, JsonValue>).privacy
    if (inputPrivacy === 'public' || inputPrivacy === 'cloud_allowed' || inputPrivacy === 'local_only') labels.push(inputPrivacy)
  }
  const resultRefs: string[] = []
  if (effect?.outcome?.resultRef !== undefined) resultRefs.push(effect.outcome.resultRef)
  if (event.type === 'lane.succeeded' && typeof event.data === 'string') resultRefs.push(event.data)
  if (event.type === 'privacy.downgraded' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const outputRef = (event.data as Record<string, JsonValue>).outputRef
    if (typeof outputRef === 'string') resultRefs.push(outputRef)
  }
  for (const ref of resultRefs) {
    const result = state.results.get(ref)
    if (result) labels.push(result.privacy)
  }
  return labels.length === 0 ? 'local_only' : labels.reduce<PrivacyLabel>((current, next) => privacyRank(next) > privacyRank(current) ? next : current, 'public')
}

function redactEvent(event: RuntimeEvent, privacy: PrivacyLabel): RuntimeEvent {
  return { ...structuredClone(event), payload: { redacted: true, privacy }, data: { redacted: true, privacy } }
}

/** Export audit/log data with an explicit privacy ceiling; this is not a recovery snapshot. */
export function exportRuntimeLog(state: RuntimeState, options: SessionLogExportOptions = {}): SessionLogExport {
  const maxPrivacy = options.maxPrivacy ?? 'public'
  const allowed = (privacy: PrivacyLabel): boolean => privacyRank(privacy) <= privacyRank(maxPrivacy)
  const results = [...state.results.values()].map((result) => {
    const copy = structuredClone(result)
    if (allowed(copy.privacy)) return copy
    const { value: _value, summary: _summary, ...metadata } = copy
    return { ...metadata, redacted: true }
  })
  const artifacts = [...state.artifacts.values()].map((artifact) => {
    const copy = structuredClone(artifact)
    if (allowed(copy.privacy)) return copy
    const { contentBase64: _content, ...metadata } = copy
    return { ...metadata, redacted: true }
  })
  const events = state.events.map((event) => {
    const privacy = relatedEventPrivacy(state, event)
    return allowed(privacy) ? structuredClone(event) : redactEvent(event, privacy)
  })
  return { schemaVersion: 1, maxPrivacy, events, results, artifacts }
}

/** Applies the privacy ceiling before handing an audit export to its sink. */
export async function exportRuntimeLogTo(state: RuntimeState, sink: RuntimeLogSink, options: SessionLogExportOptions = {}): Promise<SessionLogExport> {
  const log = exportRuntimeLog(state, options)
  await sink.append(log)
  return log
}

export function serializeRuntimeState(state: RuntimeState): JsonValue { return exportRuntimeState(state) as unknown as JsonValue }

export function importRuntimeState(snapshot: SessionSnapshot | JsonValue): RuntimeState {
  const value = snapshot as SessionSnapshot
  if (!value || value.schemaVersion !== 1 || !value.state || !Array.isArray(value.state.agents) || !Array.isArray(value.state.lanes) || !Array.isArray(value.state.effects) || !Array.isArray(value.state.waits) || !Array.isArray(value.state.results) || !Array.isArray(value.state.events) || (value.state.eventsCompactedThrough !== undefined && (!Number.isInteger(value.state.eventsCompactedThrough) || value.state.eventsCompactedThrough < 0))) throw new Error('INVALID_SESSION_SNAPSHOT')
  const state = createRuntimeState(value.state.maxTotalLanes, { maxQueuedEffects: value.state.maxQueuedEffects, maxRunning: { llm: decodeNumber(value.state.maxRunning.llm), tool: decodeNumber(value.state.maxRunning.tool), agent: decodeNumber(value.state.maxRunning.agent), none: decodeNumber(value.state.maxRunning.none) }, forkAffinity: value.state.forkAffinity ?? 'advise', ...(value.state.historySoftTokens === undefined ? {} : { historySoftTokens: value.state.historySoftTokens }), ...(value.state.historyHardTokens === undefined ? {} : { historyHardTokens: value.state.historyHardTokens }), ...(value.state.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: value.state.maxResultSummaryBytes }), ...(value.state.trustedSanitizerIds === undefined ? {} : { trustedSanitizerIds: value.state.trustedSanitizerIds }) })
  state.now = value.state.now
  state.nextIds = { ...value.state.nextIds, artifact: value.state.nextIds.artifact ?? 1, proposal: value.state.nextIds.proposal ?? 1 }
  for (const [id, agent] of value.state.agents) {
    const { globalVersions, globalPrivacy, ...agentValue } = agent
    state.agents.set(id, { ...agentValue, globalVersions: new Map(globalVersions.map(([version, context]) => [version, structuredClone(context)] as [number, JsonValue])), ...(globalPrivacy === undefined ? {} : { globalPrivacy: new Map(globalPrivacy.map(([version, metadata]) => [version, structuredClone(metadata)] as [number, PrivacyMetadata])) }) })
  }
  for (const [id, lane] of value.state.lanes) {
    const { visibleResultRefs, ...laneValue } = lane
    state.lanes.set(id, { ...laneValue, children: new Set(lane.children), ownedEffectIds: new Set(lane.ownedEffectIds), ...(visibleResultRefs === undefined ? {} : { visibleResultRefs: new Set(visibleResultRefs) }) })
  }
  for (const [id, effect] of value.state.effects) state.effects.set(id, structuredClone(effect))
  for (const [id, wait] of value.state.waits) state.waits.set(id, structuredClone(wait))
  for (const [id, result] of value.state.results) state.results.set(id, { ...structuredClone(result), storageState: result.storageState ?? 'memory', pinCount: result.pinCount ?? 0 })
  for (const [ref, artifact] of value.state.artifacts ?? []) state.artifacts.set(ref, structuredClone(artifact))
  for (const [id, correlation] of value.state.toolCallCorrelations ?? []) state.toolCallCorrelations.set(id, structuredClone(correlation))
  for (const [id, proposal] of value.state.mergeProposals ?? []) state.mergeProposals.set(id, structuredClone(proposal))
  state.events = value.state.events.map((event) => normalizeRuntimeEvent(event as unknown as RuntimeEventInput, (event as RuntimeEvent).seq, { sessionId: (event as RuntimeEvent).sessionId, timestamp: (event as RuntimeEvent).timestamp }))
  if (value.state.eventsCompactedThrough !== undefined) state.eventsCompactedThrough = value.state.eventsCompactedThrough
  return state
}
