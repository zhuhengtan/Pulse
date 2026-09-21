import { commitMutationTransaction, MutationLog } from '../storage/mutation-log.js'
import { buildAgent } from '../core/factory.js'
import { validateStep } from '../transitions/validate.js'
import { PriorityInheritance, ReadyQueue, readyItemFromLane, VirtualClock, type RuntimeClock } from './index.js'
import type { ArtifactRecord, EffectRecord, EffectSubmission, EffectState, JsonValue, LaneRecord, LaneStepOutput, Outcome, ResumeInput, RuntimeState, RuntimeError, RuntimeEventInput, TargetRef, WaitRecord, ToolCallCorrelation, SeriesLaneSpec, ForkAffinityMode, PrivacyLabel, PrivacyTaint, PrivacyMetadata, ProvenanceRef, ResumePoint, ResultRecord } from '../core/types.js'
import { createRuntimeState, effectivePrivacy, isSideEffectful, privacyMetadataForDerivedRef, privacyTaintsForDerivedRefs, provenanceRefId, provenanceRefKind, strictestPrivacy, validatePrivacyTaints } from '../core/types.js'
import { QuarantineScope } from '../lifecycle/scopes.js'
import { PulseSession } from '../dsl/session.js'
import { assertProgramPure, withPureStepGuard } from '../dsl/program.js'
import type { ProgramRef } from '../dsl/templates.js'
import { FactInbox, ObservationInbox } from '../core/inbox.js'
import { observeProgress, type ProgressObservation } from '../lifecycle/watchdog.js'
import { EffectOutbox } from '../storage/outbox.js'
import { exportRuntimeCheckpoint, exportRuntimePersistence, externalizeRuntimeResultBodies, externalizeRuntimeSnapshotBodies, hydrateRuntimeResultBodies, hydrateRuntimeSnapshotBodies, importRuntimePersistence, withRuntimePersistenceIntegrity, type RuntimePersistenceBackend, type RuntimePersistenceCompatibility, type RuntimePersistenceSnapshot } from '../storage/persistence.js'
import { exportRuntimeLog, exportRuntimeLogTo, exportWarmStartSession, type RuntimeLogSink, type RuntimeSessionStore, type SessionLogExport, type SessionLogExportOptions } from '../storage/session.js'
import { ResourceLockManager } from './locks.js'
import { appendRuntimeEvent } from '../core/events.js'
import { apply, type Mutation } from '../core/mutations.js'
import { ContextMerger, type MergePlan } from '../context/merger.js'
import { appendHistory, contentHash, historyPressure, stableSerialize } from '../context/builder.js'
import { assignRuntimeToolCallIds, InMemoryModelRegistry, ModelRouter, validateAdapterResult, validateJsonSchema, type ModelCapabilities, type ModelHostPolicy, type ModelRegistry, type ModelRouteRequirements } from '../models/router.js'
import { SessionStoragePolicy, type StoragePolicyConfig } from '../storage/policy.js'
import { collectRuntimeTelemetry, type RuntimeTelemetryExporter, type RuntimeTelemetrySnapshot } from './telemetry.js'
import { advanceArtifactId, markArtifactPersisted, pinArtifact, prepareArtifactPublication, readArtifact, unpinArtifact, type ArtifactPublication } from '../storage/artifacts.js'
import { prepareFindingPublication, type FindingPublication } from '../storage/findings.js'
import { runtimeErrorFromCause } from '../core/errors.js'
import { RuntimeToolRegistry } from '../tools/registry.js'

export interface LaneStepContext { lane: Readonly<LaneRecord>; state: Readonly<RuntimeState>; resumeInput?: ResumeInput; now: number; observe?: (event: { type: 'progress' | 'chunk' | 'trace' | 'warning' | 'diagnostic'; data: JsonValue }) => void }
export interface LaneProgram {
  id: string
  version: string
  entry?: string
  step: (context: LaneStepContext) => LaneStepOutput
  errorBoundary?: (error: RuntimeError, context: LaneStepContext) => LaneStepOutput
  seriesMember?: ResumePoint
  seriesMemberProgram?: LaneProgram
  seriesKeys?: string[]
  seriesOnMemberFailure?: 'continue' | 'abort'
}
export interface EffectObservation { type: 'progress' | 'chunk' | 'trace' | 'warning' | 'diagnostic'; data: JsonValue }
export type EffectObservationEmitter = (observation: EffectObservation) => void
export interface EffectArtifactOutput { mediaType: string; content: Uint8Array | string; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; derivedFrom?: ProvenanceRef[] }
export interface EffectExecution { value: JsonValue; normalized?: JsonValue; artifact?: EffectArtifactOutput; summary?: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; sideEffectState?: 'none' | 'applied' | 'known' | 'unknown'; executionRef?: JsonValue; executionState?: 'succeeded' | 'failed' | 'remote_unknown'; status?: 'succeeded' | 'failed' | 'cancelled'; error?: RuntimeError; rejectedOutput?: { value: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; derivedFrom?: ProvenanceRef[] }; metadata?: JsonValue; observations?: EffectObservation[] }
export type EffectExecutor = (effect: Readonly<EffectRecord>, signal: AbortSignal, emitObservation?: EffectObservationEmitter) => Promise<EffectExecution>
export interface EffectHandle { id: string; status(): EffectState; requestCancel(reason: string): void }
export type HostCommand =
  | { type: 'reply'; agentId: string; effectId: string; value: JsonValue }
  | { type: 'cancel'; agentId: string; reason: string }
  | { type: 'cancel_effect'; agentId: string; effectId: string; reason: string }
  | { type: 'set_lane_priority'; laneId: string; priority: number }

export interface RuntimeConfig {
  maxLaneStepsPerTick?: number
  agingIntervalMs?: number
  agingCap?: number
  maxTotalLanes?: number
  maxQueuedEffects?: number
  maxRunning?: Partial<Record<'llm' | 'tool' | 'agent' | 'none', number>>
  forkAffinity?: ForkAffinityMode
  historySoftTokens?: number
  historyHardTokens?: number
  maxResultSummaryBytes?: number
  maxConsecutiveControlErrors?: number
  maxRuntimeMs?: number
  sessionId?: string
  maxAgentDepth?: number
  watchdogNoProgressThreshold?: number
  watchdogRepeatedActionThreshold?: number
  maxPreparingLLMs?: number
  maxPreparedLLMs?: number
  maxObservationEntries?: number
  maxObservationBytes?: number
  clock?: RuntimeClock
  trustedSanitizerIds?: string[]
  storagePolicy?: StoragePolicyConfig
  persistence?: RuntimePersistenceSnapshot
  programs?: LaneProgram[]
  models?: ModelRegistry
  hostPolicy?: ModelHostPolicy
  modelRouter?: ModelRouter
  tools?: RuntimeToolRegistry
  toolVersions?: Record<string, string>
  policyVersion?: string
  routerVersion?: string
  effectExecutor?: EffectExecutor
  effectSubmissionPreparer?: (submission: EffectSubmission) => EffectSubmission
  telemetryExporter?: RuntimeTelemetryExporter
  auditLogSink?: RuntimeLogSink
  auditLogPrivacy?: PrivacyLabel
  persistenceBackend?: RuntimePersistenceBackend
  sessionStore?: RuntimeSessionStore
  /** Internal restore CAS baseline; differs from the hydrated envelope digest. */
  persistenceExpectedDigest?: string
  budget?: RuntimeBudgetConfig
}

export interface RuntimeBudgetConfig { maxTotalAttempts?: number; maxLLMAttempts?: number; maxToolAttempts?: number; maxCostByCurrency?: Record<string, number> }
/**
 * A warm start adopts the final Global Context from an explicit PulseSession.
 * `agentId` remains a source-compatible alias for the pre-session API.
 */
export interface WarmStartSpec { sessionId?: string; agentId?: string; globalVersion?: number | 'latest' | 'final'; include?: 'facts' | 'facts_and_findings'; relevanceRefs?: string[] }
export type AgentPriority = 'background' | 'normal' | 'high' | 'urgent'
export interface AgentPolicyRef { id: string }
export interface AgentLimits { id?: string; timeoutMs?: number; maxActiveLanes?: number }
export interface AgentCreateRequest { goal: string; program: LaneProgram | ProgramRef; agentId?: string; priority?: number | AgentPriority; policy?: AgentPolicyRef; policyId?: string; limits?: AgentLimits; limitsId?: string; maxActiveLanes?: number; warmStart?: WarmStartSpec; parentAgentId?: string; inheritedFloor?: number }
export interface BackgroundAgentInfo { agentId: string; rootLaneId: string; state: NonNullable<import('../core/types.js').AgentRecord['state']>; detached: true }

function resultMetadata(value: JsonValue): { sizeBytes: number; contentHash: string } { return { sizeBytes: Buffer.byteLength(stableSerialize(value), 'utf8'), contentHash: contentHash(value) } }

function asJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('MODEL_OUTPUT_NOT_SERIALIZABLE')
  try { return JSON.parse(serialized) as JsonValue } catch { throw new Error('MODEL_OUTPUT_NOT_SERIALIZABLE') }
}

function strictJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('TOOL_OUTPUT_NOT_SERIALIZABLE'); return value }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('TOOL_OUTPUT_NOT_SERIALIZABLE')
    seen.add(value)
    try { return value.map((item) => strictJsonValue(item, seen)) } finally { seen.delete(value) }
  }
  if (typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('TOOL_OUTPUT_NOT_SERIALIZABLE')
    if (seen.has(value)) throw new Error('TOOL_OUTPUT_NOT_SERIALIZABLE')
    seen.add(value)
    try { return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, strictJsonValue(item, seen)])) } finally { seen.delete(value) }
  }
  throw new Error('TOOL_OUTPUT_NOT_SERIALIZABLE')
}

function artifactOutput(value: unknown): EffectArtifactOutput {
  if (value instanceof Uint8Array) return { mediaType: 'application/octet-stream', content: new Uint8Array(value) }
  if (value instanceof ArrayBuffer) return { mediaType: 'application/octet-stream', content: new Uint8Array(value) }
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return { mediaType: 'application/json', content: serialized }
  } catch { /* fall through to a bounded textual representation */ }
  return { mediaType: 'text/plain', content: String(value) }
}

function priorityScore(priority: AgentCreateRequest['priority']): number | undefined {
  if (priority === undefined) return undefined
  if (typeof priority === 'number') {
    if (!Number.isFinite(priority)) throw new Error('INVALID_AGENT_PRIORITY')
    return priority
  }
  return { background: -1, normal: 0, high: 1, urgent: 2 }[priority]
}

function invalidConfig(field: string): never { throw new Error(`INVALID_RUNTIME_CONFIG:${field}`) }
function optionalNonNegativeInteger(value: unknown, field: string): void { if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) invalidConfig(field) }
function optionalNonNegativeNumber(value: unknown, field: string): void { if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) invalidConfig(field) }
function validateRuntimeConfig(config: RuntimeConfig): void {
  optionalNonNegativeInteger(config.maxLaneStepsPerTick, 'maxLaneStepsPerTick')
  if (config.agingIntervalMs !== undefined && (!Number.isFinite(config.agingIntervalMs) || config.agingIntervalMs <= 0)) invalidConfig('agingIntervalMs')
  if (config.agingCap !== undefined && (config.agingCap !== Number.POSITIVE_INFINITY && (typeof config.agingCap !== 'number' || !Number.isFinite(config.agingCap) || config.agingCap < 0))) invalidConfig('agingCap')
  optionalNonNegativeInteger(config.maxTotalLanes, 'maxTotalLanes')
  optionalNonNegativeInteger(config.maxQueuedEffects, 'maxQueuedEffects')
  if (config.maxRunning !== undefined) for (const [key, value] of Object.entries(config.maxRunning)) if (!['llm', 'tool', 'agent', 'none'].includes(key) || (key === 'none' ? value !== Number.POSITIVE_INFINITY && (!Number.isInteger(value) || value < 0) : (!Number.isInteger(value) || value < 0))) invalidConfig(`maxRunning.${key}`)
  if (config.forkAffinity !== undefined && !['off', 'advise', 'coalesce'].includes(config.forkAffinity)) invalidConfig('forkAffinity')
  optionalNonNegativeInteger(config.historySoftTokens, 'historySoftTokens')
  optionalNonNegativeInteger(config.historyHardTokens, 'historyHardTokens')
  if (config.historySoftTokens !== undefined && config.historyHardTokens !== undefined && config.historyHardTokens < config.historySoftTokens) invalidConfig('historyHardTokens')
  optionalNonNegativeInteger(config.maxResultSummaryBytes, 'maxResultSummaryBytes')
  optionalNonNegativeInteger(config.maxConsecutiveControlErrors, 'maxConsecutiveControlErrors')
  optionalNonNegativeNumber(config.maxRuntimeMs, 'maxRuntimeMs')
  optionalNonNegativeInteger(config.maxAgentDepth, 'maxAgentDepth')
  optionalNonNegativeInteger(config.watchdogNoProgressThreshold, 'watchdogNoProgressThreshold')
  optionalNonNegativeInteger(config.watchdogRepeatedActionThreshold, 'watchdogRepeatedActionThreshold')
  optionalNonNegativeInteger(config.maxPreparingLLMs, 'maxPreparingLLMs')
  optionalNonNegativeInteger(config.maxPreparedLLMs, 'maxPreparedLLMs')
  optionalNonNegativeInteger(config.maxObservationEntries, 'maxObservationEntries')
  optionalNonNegativeInteger(config.maxObservationBytes, 'maxObservationBytes')
  if (config.trustedSanitizerIds !== undefined && (!Array.isArray(config.trustedSanitizerIds) || new Set(config.trustedSanitizerIds).size !== config.trustedSanitizerIds.length || config.trustedSanitizerIds.some((id) => typeof id !== 'string' || id.length === 0))) invalidConfig('trustedSanitizerIds')
  if (config.sessionId !== undefined && (typeof config.sessionId !== 'string' || config.sessionId.length === 0)) invalidConfig('sessionId')
  if (config.toolVersions !== undefined && (typeof config.toolVersions !== 'object' || config.toolVersions === null || Array.isArray(config.toolVersions) || Object.entries(config.toolVersions).some(([name, version]) => !name || typeof version !== 'string' || version.length === 0))) invalidConfig('toolVersions')
  if (config.policyVersion !== undefined && (typeof config.policyVersion !== 'string' || config.policyVersion.length === 0)) invalidConfig('policyVersion')
  if (config.routerVersion !== undefined && (typeof config.routerVersion !== 'string' || config.routerVersion.length === 0)) invalidConfig('routerVersion')
  if (config.persistenceExpectedDigest !== undefined && (typeof config.persistenceExpectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(config.persistenceExpectedDigest))) invalidConfig('persistenceExpectedDigest')
  if (config.auditLogPrivacy !== undefined && !['public', 'cloud_allowed', 'local_only'].includes(config.auditLogPrivacy)) invalidConfig('auditLogPrivacy')
  if (config.hostPolicy !== undefined && (config.hostPolicy === null || typeof config.hostPolicy !== 'object' || Array.isArray(config.hostPolicy))) invalidConfig('hostPolicy')
  if (config.hostPolicy?.allowCloud !== undefined && typeof config.hostPolicy.allowCloud !== 'boolean') invalidConfig('hostPolicy.allowCloud')
  if (config.storagePolicy !== undefined) try { new SessionStoragePolicy(config.storagePolicy) } catch { invalidConfig('storagePolicy') }
  if (config.budget !== undefined) {
    optionalNonNegativeInteger(config.budget.maxTotalAttempts, 'budget.maxTotalAttempts')
    optionalNonNegativeInteger(config.budget.maxLLMAttempts, 'budget.maxLLMAttempts')
    optionalNonNegativeInteger(config.budget.maxToolAttempts, 'budget.maxToolAttempts')
    if (config.budget.maxCostByCurrency !== undefined && (typeof config.budget.maxCostByCurrency !== 'object' || config.budget.maxCostByCurrency === null || Array.isArray(config.budget.maxCostByCurrency) || Object.entries(config.budget.maxCostByCurrency).some(([currency, limit]) => !currency || typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0))) invalidConfig('budget.maxCostByCurrency')
  }
}

export class ProgramRegistry {
  private readonly records = new Map<string, LaneProgram>()

  register(program: LaneProgram): void {
    const pending = new Map<string, LaneProgram>()
    const visiting = new Set<string>()
    const visit = (candidate: LaneProgram): void => {
      const key = `${candidate.id}@${candidate.version}`
      if (visiting.has(key)) throw new Error(`PROGRAM_REGISTRATION_CYCLE:${key}`)
      if (pending.has(key)) return
      visiting.add(key)
      assertProgramPure(candidate)
      pending.set(key, candidate)
      if (candidate.seriesMemberProgram) visit(candidate.seriesMemberProgram)
      visiting.delete(key)
    }
    visit(program)
    for (const [key, candidate] of pending) this.records.set(key, candidate)
  }

  get(programId: string, programVersion?: string): LaneProgram | undefined {
    return this.records.get(programVersion === undefined ? programId : `${programId}@${programVersion}`)
  }

  resolve(ref: ProgramRef): LaneProgram {
    const program = this.get(ref.programId, ref.programVersion)
    if (!program) throw new Error(`PROGRAM_NOT_REGISTERED:${ref.programId}@${ref.programVersion}`)
    return program
  }

  has(programId: string, programVersion?: string): boolean {
    return this.records.has(programVersion === undefined ? programId : `${programId}@${programVersion}`)
  }

  entries(): IterableIterator<[string, LaneProgram]> { return this.records.entries() }
}

function warmStartGlobal(value: JsonValue, include: 'facts' | 'facts_and_findings', relevanceRefs: string[] | undefined): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value)
  const output = structuredClone(value) as Record<string, JsonValue>
  if (include === 'facts') { delete output.findings }
  else if (relevanceRefs !== undefined && Array.isArray(output.findings)) {
    const refs = new Set(relevanceRefs)
    output.findings = output.findings.filter((finding) => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false
      const record = finding as Record<string, JsonValue>
      if (typeof record.ref === 'string' || typeof record.id === 'string') return refs.has((record.ref ?? record.id) as string)
      return Array.isArray(record.derivedFrom) && record.derivedFrom.some((ref) => typeof ref === 'string' && refs.has(ref))
    })
  }
  return output
}

function outcomeForLane(lane: LaneRecord): Outcome | undefined {
  const unresolvedEffectIds = lane.unresolvedEffectIds === undefined || lane.unresolvedEffectIds.length === 0 ? {} : { unresolvedEffectIds: [...lane.unresolvedEffectIds] }
  if (lane.status === 'succeeded') return { status: 'succeeded', ...(lane.resultRef === undefined ? {} : { resultRef: lane.resultRef }), ...unresolvedEffectIds }
  if (lane.status === 'failed') return { status: 'failed', ...(lane.failure === undefined ? {} : { error: lane.failure.error }), ...unresolvedEffectIds }
  if (lane.status === 'cancelled') return { status: 'cancelled', reason: lane.cancelReason ?? 'CANCELLED', ...unresolvedEffectIds }
  return undefined
}

function runOutcome(lane: LaneRecord | undefined, unresolvedEffectIds: string[]): Outcome {
  const outcome = lane === undefined ? undefined : outcomeForLane(lane)
  const unresolved = [...new Set([...(outcome?.unresolvedEffectIds ?? []), ...unresolvedEffectIds])]
  if (outcome) return { ...outcome, unresolvedEffectIds: unresolved }
  return { status: 'failed', error: { code: 'RUNTIME_IDLE_BLOCKED', message: 'Runtime stopped before the root Lane reached a terminal state.' }, unresolvedEffectIds: unresolved }
}

function outcomeForSeriesMember(state: RuntimeState, lane: LaneRecord, key: string): Outcome | undefined {
  const aggregate = outcomeForLane(lane)
  if (!aggregate || lane.series === undefined || lane.resultRef === undefined) return aggregate
  const value = state.results.get(lane.resultRef)?.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return aggregate
  const results = value.results
  if (!results || typeof results !== 'object' || Array.isArray(results)) return aggregate
  const member = results[key]
  if (!member || typeof member !== 'object' || Array.isArray(member)) return aggregate
  const record = member as Record<string, JsonValue>
  const status = record.status
  if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') return aggregate
  return {
    status,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? { error: record.error as unknown as RuntimeError } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  }
}

export class PulseRuntime {
  readonly state: RuntimeState
  /** Host-facing read-only effect inspection. Returned records are detached snapshots. */
  readonly effects = {
    inspect: (effectId: string): EffectRecord | undefined => {
      const effect = this.state.effects.get(effectId)
      return effect === undefined ? undefined : structuredClone(effect)
    },
  }
  /** Host-facing read-only result lookup. Returned records are detached snapshots. */
  readonly results = {
    get: (resultRef: string): ResultRecord | undefined => {
      const result = this.state.results.get(resultRef)
      return result === undefined ? undefined : structuredClone(result)
    },
  }
  private shuttingDown = false
  private readonly telemetryExporter: RuntimeTelemetryExporter | undefined
  private readonly auditLogSink: RuntimeLogSink | undefined
  private readonly auditLogPrivacy: PrivacyLabel | undefined
  private readonly persistenceBackend: RuntimePersistenceBackend | undefined
  private readonly sessionStore: RuntimeSessionStore | undefined
  private readonly enforcingRecoveryPrograms: boolean
  private readonly toolVersions: Readonly<Record<string, string>>
  private readonly recoveryCompatibility: RuntimePersistenceCompatibility | undefined
  private readonly policyVersion: string | undefined
  private readonly routerVersion: string | undefined
  private readonly budget: RuntimeBudgetConfig
  private persistenceDigest: string | undefined
  private readonly budgetCost = new Map<string, number>()
  private persistencePending: Promise<void> = Promise.resolve()
  private persistenceScheduled = false
  private persistenceDirty = false
  private dispatchPersistencePending = false
  private readonly executionYieldPending = new Set<string>()
  readonly mutationLog: MutationLog
  readonly outbox: EffectOutbox
  readonly clock: RuntimeClock
  readonly ready: ReadyQueue
  readonly quarantine = new QuarantineScope()
  readonly priorityInheritance = new PriorityInheritance()
  readonly resourceLocks = new ResourceLockManager()
  readonly storagePolicy: SessionStoragePolicy
  readonly factInbox: FactInbox<HostCommand>
  readonly observationInbox: ObservationInbox
  readonly programs = new ProgramRegistry()
  readonly models: ModelRegistry
  readonly modelRouter: ModelRouter
  readonly tools: RuntimeToolRegistry
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void>; timeoutTimer?: string; deadlineTimer?: string; cancelTimer?: string }>()
  private readonly lockReleases = new Map<string, Array<() => void>>()
  private readonly waitDeadlineTimers = new Map<string, string>()
  private readonly lockBlocked = new Set<string>()
  private readonly executor: EffectExecutor
  private readonly customExecutor: boolean
  private enqueueSeq = 1
  private readonly maxSteps: number
  private readonly maxConsecutiveControlErrors: number
  private readonly maxRuntimeAt?: number
  private readonly watchdogNoProgressThreshold: number
  private readonly watchdogRepeatedActionThreshold: number
  private readonly maxAgentDepth: number
  private readonly maxPreparingLLMs: number
  private readonly maxPreparedLLMs: number
  private readonly effectSubmissionPreparer: ((submission: EffectSubmission) => EffectSubmission) | undefined
  private readonly preparingLLMs = new Set<string>()
  private readonly sessionId: string
  private hostCommandSeq = 1
  private factWaiters: Array<() => void> = []

  static async restore(backend: RuntimePersistenceBackend, config: Omit<RuntimeConfig, 'persistence'> = {}): Promise<PulseRuntime> {
    const loaded = await backend.load()
    if (loaded?.snapshotBodies === 'external' && backend.snapshotStore === undefined) throw new Error('RUNTIME_SNAPSHOT_STORE_REQUIRED')
    const withSnapshots = loaded === undefined || backend.snapshotStore === undefined ? loaded : await hydrateRuntimeSnapshotBodies(loaded, backend.snapshotStore)
    const snapshot = withSnapshots === undefined || backend.resultStore === undefined ? withSnapshots : await hydrateRuntimeResultBodies(withSnapshots, backend.resultStore)
    if (snapshot?.resultBodies === 'external' && backend.resultStore === undefined) throw new Error('RUNTIME_RESULT_STORE_REQUIRED')
    const restoredConfig = snapshot === undefined ? config : { ...config, persistence: snapshot, ...(config.persistenceBackend === undefined || loaded?.integrity?.digest === undefined ? {} : { persistenceExpectedDigest: loaded.integrity.digest }) }
    return new PulseRuntime(restoredConfig.sessionStore === undefined && backend.sessionStore === undefined ? restoredConfig : { ...restoredConfig, ...(restoredConfig.sessionStore === undefined ? { sessionStore: backend.sessionStore } : {}) })
  }

  constructor(config: RuntimeConfig = {}) {
    validateRuntimeConfig(config)
    const restored = config.persistence === undefined ? undefined : importRuntimePersistence(config.persistence)
    this.enforcingRecoveryPrograms = restored !== undefined
    this.observationInbox = new ObservationInbox(config.maxObservationEntries ?? 4096, config.maxObservationBytes ?? 1_000_000)
    this.models = config.models ?? config.modelRouter?.registry ?? new InMemoryModelRegistry()
    if (config.modelRouter && config.hostPolicy?.allowCloud === false && config.modelRouter.hostPolicy.allowCloud) throw new Error('HOST_POLICY_ROUTER_MISMATCH')
    this.modelRouter = config.modelRouter ?? new ModelRouter(this.models, config.hostPolicy)
    this.tools = config.tools ?? new RuntimeToolRegistry()
    this.toolVersions = { ...(config.toolVersions ?? {}) }
    this.policyVersion = config.policyVersion
    this.routerVersion = config.routerVersion
    this.state = restored?.state ?? createRuntimeState(config.maxTotalLanes ?? 64, { ...(config.maxQueuedEffects === undefined ? {} : { maxQueuedEffects: config.maxQueuedEffects }), ...(config.maxRunning === undefined ? {} : { maxRunning: config.maxRunning }), ...(config.forkAffinity === undefined ? {} : { forkAffinity: config.forkAffinity }), ...(config.historySoftTokens === undefined ? {} : { historySoftTokens: config.historySoftTokens }), ...(config.historyHardTokens === undefined ? {} : { historyHardTokens: config.historyHardTokens }), ...(config.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: config.maxResultSummaryBytes }), ...(config.trustedSanitizerIds === undefined ? {} : { trustedSanitizerIds: config.trustedSanitizerIds }) })
    if (config.trustedSanitizerIds) for (const sanitizerId of config.trustedSanitizerIds) this.state.trustedSanitizerIds.add(sanitizerId)
    this.sessionId = config.sessionId ?? 'session-local'
    this.storagePolicy = restored?.storagePolicy ?? new SessionStoragePolicy(config.storagePolicy)
    this.persistenceDigest = config.persistenceExpectedDigest ?? config.persistence?.integrity?.digest
    this.mutationLog = restored?.mutationLog ?? new MutationLog()
    this.outbox = restored?.outbox ?? new EffectOutbox()
    this.factInbox = restored?.factInbox === undefined ? new FactInbox<HostCommand>() : FactInbox.fromSnapshot<HostCommand>(restored.factInbox as unknown as import('../core/inbox.js').FactInboxSnapshot<HostCommand>)
    for (const program of config.programs ?? []) this.register(program)
    this.recoveryCompatibility = restored?.compatibility
    const restoredCommandIds = this.factInbox.snapshot().seen.map((eventId) => /^host-command-(\d+)$/.exec(eventId)?.[1]).filter((value): value is string => value !== undefined).map(Number)
    if (restoredCommandIds.length) this.hostCommandSeq = Math.max(...restoredCommandIds) + 1
    if (restored?.quarantine) this.quarantine.restore(restored.quarantine)
    if (restored) {
      const recovery = this.outbox.recover(this.state)
      for (const id of recovery.requeued) this.emit({ type: 'outbox.requeued', data: id })
      for (const id of recovery.unknown) this.emit({ type: 'outbox.discarded', data: id })
    }
    this.clock = config.clock ?? new VirtualClock()
    if (!restored && config.clock) this.state.now = this.clock.now()
    this.ready = new ReadyQueue(config.agingIntervalMs ?? 1000, config.agingCap ?? Number.POSITIVE_INFINITY)
    if (restored) {
      this.clock.set(this.state.now)
      for (const lane of this.state.lanes.values()) if (lane.status === 'ready') this.ready.enqueue(readyItemFromLane(lane))
      for (const effect of this.state.effects.values()) {
        const outboxEntry = this.outbox.get(`${effect.id}:${effect.attemptId}`)
        if (effect.state === 'running' && (outboxEntry === undefined || outboxEntry.state === 'pending')) {
          const recovered = structuredClone(effect)
          const recoveryReason = isSideEffectful(effect.sideEffectPolicy) ? 'recovery_in_doubt' : 'recovery_requeue'
          if (isSideEffectful(effect.sideEffectPolicy)) { recovered.state = 'reconcile_required'; recovered.executionState = 'remote_unknown'; recovered.sideEffectState = 'unknown' }
          else { recovered.state = 'queued'; recovered.executionState = 'local' }
          commitMutationTransaction(this.state, this.mutationLog, `recovery:${effect.id}:${effect.attemptId}:${recoveryReason}`, [{ op: 'setEffect', effectId: effect.id, record: recovered }], this.state.now, this.sessionId)
          if (isSideEffectful(effect.sideEffectPolicy)) this.quarantine.add(effect.id, this.state.now, 'recovery_in_doubt')
        }
        if (effect.state === 'retry_wait' && effect.retryAt !== undefined) {
          const attemptId = effect.attemptId
          this.clock.timers.schedule(effect.retryAt, () => this.readyRetryEffect(effect.id, attemptId))
        }
      }
      for (const effect of [...this.state.effects.values()].sort((left, right) => left.id.localeCompare(right.id))) if (effect.state === 'reconcile_required' && effect.sideEffectState === 'unknown') {
        const releases = [...(effect.locks ?? [])].sort((left, right) => left.resource.localeCompare(right.resource) || left.mode.localeCompare(right.mode)).map((lock, index) => this.resourceLocks.restoreHeld(lock.resource, lock.mode, `${effect.id}:${effect.attemptId}:recovery:${index}`))
        if (releases.length) this.lockReleases.set(effect.id, releases)
        if (!this.quarantine.has(effect.id)) this.quarantine.add(effect.id, this.state.now, 'recovery_in_doubt')
      }
      for (const wait of this.state.waits.values()) if (wait.state === 'pending') this.scheduleWaitDeadline(wait)
    }
    this.maxSteps = config.maxLaneStepsPerTick ?? 32
    this.maxConsecutiveControlErrors = config.maxConsecutiveControlErrors ?? 2
    this.watchdogNoProgressThreshold = config.watchdogNoProgressThreshold ?? 3
    this.watchdogRepeatedActionThreshold = config.watchdogRepeatedActionThreshold ?? 3
    this.maxAgentDepth = config.maxAgentDepth ?? 1
    this.maxPreparingLLMs = config.maxPreparingLLMs ?? 2
    this.maxPreparedLLMs = config.maxPreparedLLMs ?? 8
    this.effectSubmissionPreparer = config.effectSubmissionPreparer ?? ((submission) => this.prepareRegisteredToolSubmission(submission))
    this.telemetryExporter = config.telemetryExporter
    this.auditLogSink = config.auditLogSink
    this.auditLogPrivacy = config.auditLogPrivacy
    this.persistenceBackend = config.persistenceBackend
    this.sessionStore = config.sessionStore ?? config.persistenceBackend?.sessionStore
    this.budget = config.budget ?? {}
    if (restored) for (const event of this.state.events) if (event.type === 'effect.execution_metadata') this.recordBudgetMetadata(event.data ?? event.payload)
    this.customExecutor = config.effectExecutor !== undefined
    this.executor = config.effectExecutor ?? this.executeRegisteredEffect.bind(this)
    if (restored) this.clock.set(this.state.now)
    if (config.maxRuntimeMs !== undefined) {
      if (!Number.isFinite(config.maxRuntimeMs) || config.maxRuntimeMs < 0) throw new Error('INVALID_MAX_RUNTIME')
      this.maxRuntimeAt = this.clock.now() + config.maxRuntimeMs
    }
    this.syncStoragePolicy()
  }

  register(program: LaneProgram): void { this.programs.register(program) }
  createAgent(request: AgentCreateRequest): { agentId: string; laneId: string }
  createAgent(goal: string, program: LaneProgram, agentId?: string): { agentId: string; laneId: string }
  createAgent(goalOrRequest: string | AgentCreateRequest, program?: LaneProgram, agentId?: string): { agentId: string; laneId: string } {
    if (this.shuttingDown) throw new Error('RUNTIME_SHUTTING_DOWN')
    const request: AgentCreateRequest = typeof goalOrRequest === 'string' ? { goal: goalOrRequest, program: program!, ...(agentId === undefined ? {} : { agentId }) } : goalOrRequest
    const programRef = 'programId' in request.program ? request.program : undefined
    const rootProgram: LaneProgram = programRef === undefined ? request.program as LaneProgram : this.programs.resolve(programRef)
    const rootPriority = priorityScore(request.priority)
    const policyId = request.policy?.id ?? request.policyId
    const limitsId = request.limits?.id ?? request.limitsId
    if (request.policy !== undefined && !request.policy.id) throw new Error('INVALID_AGENT_POLICY')
    const timeoutMs = request.limits?.timeoutMs
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error('INVALID_AGENT_TIMEOUT')
    const maxActiveLanes = request.limits?.maxActiveLanes ?? request.maxActiveLanes
    if (maxActiveLanes !== undefined && (!Number.isInteger(maxActiveLanes) || maxActiveLanes < 1)) throw new Error('INVALID_AGENT_LIMITS')
    const warmStart = request.warmStart
    let initialGlobal: JsonValue | undefined
    let initialGlobalPrivacy: PrivacyMetadata | undefined
    let warmStartResultRefs: string[] = []
    let warmStartResults: import('../core/types.js').ResultRecord[] = []
    if (warmStart) {
      const sourceSessionId = warmStart.sessionId ?? warmStart.agentId
      if (!sourceSessionId) throw new Error('WARM_START_SESSION_REQUIRED')
      const source = this.state.agents.get(sourceSessionId)
      const stored = source === undefined ? this.sessionStore?.get(sourceSessionId) : undefined
      if (!source && !stored) throw new Error(`WARM_START_SOURCE_NOT_FOUND:${sourceSessionId}`)
      const sourceLatestVersion = source?.latestGlobalVersion ?? stored!.agent.latestGlobalVersion
      const version = warmStart.globalVersion === 'latest' || warmStart.globalVersion === 'final' || warmStart.globalVersion === undefined ? sourceLatestVersion : warmStart.globalVersion
      const value = source?.globalVersions.get(version) ?? stored!.agent.globalVersions.find(([candidate]) => candidate === version)?.[1]
      if (value === undefined) throw new Error(`WARM_START_VERSION_NOT_FOUND:${version}`)
      initialGlobal = warmStartGlobal(value, warmStart.include ?? 'facts', warmStart.relevanceRefs)
      initialGlobalPrivacy = source?.globalPrivacy?.get(version) === undefined
        ? stored?.agent.globalPrivacy?.find(([candidate]) => candidate === version)?.[1]
        : structuredClone(source.globalPrivacy.get(version))
      warmStartResultRefs = [...new Set(warmStart.relevanceRefs ?? [])]
      const visibleResultRefs = source?.rootLaneId === undefined ? new Set(stored!.visibleResultRefs) : this.state.lanes.get(source.rootLaneId)?.visibleResultRefs ?? new Set<string>()
      const storedResults = new Map(stored?.results ?? [])
      for (const ref of warmStartResultRefs) {
        if (!visibleResultRefs.has(ref)) throw new Error(`WARM_START_RESULT_NOT_VISIBLE:${ref}`)
        if (!this.state.results.has(ref)) {
          const result = storedResults.get(ref)
          if (!result) throw new Error(`WARM_START_RESULT_NOT_FOUND:${ref}`)
          warmStartResults.push(structuredClone(result))
        }
      }
    }
    if (programRef === undefined) this.register(rootProgram)
    if (this.state.lanes.size >= this.state.maxTotalLanes) throw new Error('MAX_TOTAL_LANES')
    if (request.agentId !== undefined && this.state.agents.has(request.agentId)) throw new Error(`AGENT_ID_EXISTS:${request.agentId}`)
    const parent = request.parentAgentId === undefined ? undefined : this.state.agents.get(request.parentAgentId)
    if (request.parentAgentId !== undefined && !parent) throw new Error(`PARENT_AGENT_NOT_FOUND:${request.parentAgentId}`)
    const rootResume = programRef === undefined
      ? { programId: rootProgram.id, programVersion: rootProgram.version, step: (rootProgram as LaneProgram & { entry?: string }).entry ?? 'start', locals: {} }
      : { programId: rootProgram.id, programVersion: rootProgram.version, step: programRef.step ?? (rootProgram as LaneProgram & { entry?: string }).entry ?? 'start', locals: programRef.locals ?? {} }
    const { agent, root, nextIds } = buildAgent(this.state, request.goal, rootResume, { ...(request.agentId === undefined ? {} : { agentId: request.agentId }), ...(maxActiveLanes === undefined ? {} : { maxActiveLanes }), ...(rootPriority === undefined ? {} : { priority: rootPriority }), ...(initialGlobal === undefined ? {} : { initialGlobal }), ...(initialGlobalPrivacy === undefined ? {} : { initialGlobalPrivacy }), ...(request.parentAgentId === undefined ? {} : { parentAgentId: request.parentAgentId, depth: (parent?.depth ?? 0) + 1 }), ...(request.inheritedFloor === undefined ? {} : { inheritedFloor: request.inheritedFloor }), ...(policyId === undefined ? {} : { policyId }), ...(limitsId === undefined ? {} : { limitsId }), ...(timeoutMs === undefined ? {} : { deadlineAt: this.state.now + timeoutMs }) })
    if (warmStartResultRefs.length) root.visibleResultRefs = new Set(warmStartResultRefs)
    if (rootProgram.seriesKeys?.length && programRef === undefined) root.resume.locals = { $sdk: { series: { keys: [...rootProgram.seriesKeys], index: 0 } } }
    root.enqueueSeq = this.enqueueSeq++
    agent.state = 'running'
    const importedResultIds = new Set(warmStartResults.map((result) => result.id))
    const nextIdsWithWarmStart = { ...nextIds }
    for (const ref of importedResultIds) {
      const match = /^result-(\d+)$/.exec(ref)
      if (match) nextIdsWithWarmStart.result = Math.max(nextIdsWithWarmStart.result, Number(match[1]) + 1)
    }
    const mutations: Mutation[] = [
      { op: 'setAgent', agentId: agent.id, record: agent },
      { op: 'setLane', laneId: root.id, record: root },
      ...warmStartResults.map((result) => ({ op: 'publishResult' as const, record: result })),
      { op: 'setNextIds', nextIds: nextIdsWithWarmStart },
    ]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `agent:${agent.id}:created`, mutations, this.state.now, this.sessionId)
    const committedRoot = this.state.lanes.get(root.id)!
    this.ready.enqueue(readyItemFromLane(committedRoot))
    this.syncStoragePolicy()
    this.schedulePersistence()
    return { agentId: agent.id, laneId: root.id }
  }
  start(agentId: string): PulseSession { if (!this.state.agents.has(agentId)) throw new Error(`UNKNOWN_AGENT:${agentId}`); return new PulseSession(this, agentId) }
  requestCancel(agentId: string, reason = 'USER_REQUESTED'): void {
    if (!agentId) throw new Error('INVALID_AGENT_ID')
    if (!reason) throw new Error('INVALID_CANCEL_REASON')
    this.enqueueHostCommand({ type: 'cancel', agentId, reason })
  }
  setLanePriority(laneId: string, priority: number): void {
    if (!laneId) throw new Error('INVALID_LANE_ID')
    if (!Number.isFinite(priority)) throw new Error('INVALID_LANE_PRIORITY')
    this.enqueueHostCommand({ type: 'set_lane_priority', laneId, priority })
  }
  effectHandle(effectId: string): EffectHandle {
    const effect = this.state.effects.get(effectId)
    if (!effect) throw new Error(`UNKNOWN_EFFECT:${effectId}`)
    return {
      id: effectId,
      status: () => {
        const current = this.state.effects.get(effectId)
        if (!current) throw new Error(`UNKNOWN_EFFECT:${effectId}`)
        return current.state
      },
      requestCancel: (reason) => {
        if (!reason) throw new Error('INVALID_CANCEL_REASON')
        this.enqueueHostCommand({ type: 'cancel_effect', agentId: effect.agentId, effectId, reason })
      },
    }
  }
  inspectLane(laneId: string): JsonValue {
    if (!laneId) throw new Error('INVALID_LANE_ID')
    return this.explain(laneId)
  }
  detachAgent(agentId: string): BackgroundAgentInfo {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    const event = { type: 'agent.detached' as const, agentId, data: { agentId } }
    const nextAgent = structuredClone(agent)
    nextAgent.detached = true
    const mutations: Mutation[] = [{ op: 'setAgent', agentId, record: nextAgent }, { op: 'appendEvent', event }]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `agent:${agentId}:detached`, mutations, this.state.now, this.sessionId)
    Object.assign(agent, nextAgent)
    this.state.agents.set(agentId, agent)
    this.schedulePersistence()
    return { agentId, rootLaneId: agent.rootLaneId, state: agent.state ?? 'created', detached: true }
  }
  attachAgent(agentId: string): void {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    if (!agent.detached) return
    const event = { type: 'agent.attached' as const, agentId, data: { agentId } }
    const nextAgent = structuredClone(agent)
    delete nextAgent.detached
    const mutations: Mutation[] = [{ op: 'setAgent', agentId, record: nextAgent }, { op: 'appendEvent', event }]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `agent:${agentId}:attached`, mutations, this.state.now, this.sessionId)
    Object.assign(agent, nextAgent)
    delete agent.detached
    this.state.agents.set(agentId, agent)
    this.schedulePersistence()
  }
  backgroundAgents(): BackgroundAgentInfo[] {
    return [...this.state.agents.values()].filter((agent) => agent.detached === true).map((agent) => ({ agentId: agent.id, rootLaneId: agent.rootLaneId, state: agent.state ?? 'created', detached: true }))
  }
  exportPersistence(): RuntimePersistenceSnapshot { return exportRuntimePersistence(this.state, this.mutationLog, this.outbox, this.quarantine, this.storagePolicy, this.factInbox.snapshot(), this.persistenceCompatibility()) }
  async persist(backend: RuntimePersistenceBackend): Promise<void> {
    const persistedPolicy = this.storagePolicy.clone()
    persistedPolicy.markPersisted()
    const exported = exportRuntimePersistence(this.persistenceState(), this.mutationLog, this.outbox, this.quarantine, persistedPolicy, this.factInbox.snapshot(), this.persistenceCompatibility())
    const withResults = backend.resultStore === undefined ? exported : await externalizeRuntimeResultBodies(exported, backend.resultStore)
    const snapshot = backend.snapshotStore === undefined ? withResults : await externalizeRuntimeSnapshotBodies(withResults, backend.snapshotStore)
    await backend.save(snapshot, backend === this.persistenceBackend ? this.persistenceDigest : undefined)
    if (backend === this.persistenceBackend) this.persistenceDigest = snapshot.integrity?.digest
    this.storagePolicy.markPersisted()
    this.markArtifactsPersisted()
    this.syncStoragePolicy()
  }
  async flushPersistence(): Promise<void> {
    if (!this.persistenceBackend) return
    this.schedulePersistence()
    while (true) {
      await this.persistencePending
      if (!this.persistenceDirty) return
      this.schedulePersistence()
    }
  }
  async checkpoint(backend: RuntimePersistenceBackend, options: { compactEventsThrough?: number } = {}): Promise<RuntimePersistenceSnapshot> {
    const persistedPolicy = this.storagePolicy.clone()
    persistedPolicy.markPersisted()
    const eventWatermark = options.compactEventsThrough ?? this.state.events.at(-1)?.seq
    if (backend.eventArchive !== undefined && eventWatermark !== undefined) {
      const fromSeq = (this.state.eventsCompactedThrough ?? 0) + 1
      const events = this.state.events.filter((event) => event.seq >= fromSeq && event.seq <= eventWatermark)
      if (events.length) await backend.eventArchive.append(events)
    }
    const exported = exportRuntimeCheckpoint(this.persistenceState(), this.mutationLog, this.outbox, this.quarantine, persistedPolicy, eventWatermark === undefined ? {} : { compactEventsThrough: eventWatermark }, this.factInbox.snapshot(), this.persistenceCompatibility())
    const archived = backend.eventArchive === undefined || eventWatermark === undefined ? exported : withRuntimePersistenceIntegrity({ ...exported, eventArchive: { through: eventWatermark } })
    const withResults = backend.resultStore === undefined ? archived : await externalizeRuntimeResultBodies(archived, backend.resultStore)
    const snapshot = backend.snapshotStore === undefined ? withResults : await externalizeRuntimeSnapshotBodies(withResults, backend.snapshotStore)
    await backend.save(snapshot, backend === this.persistenceBackend ? this.persistenceDigest : undefined)
    if (backend === this.persistenceBackend) this.persistenceDigest = snapshot.integrity?.digest
    this.storagePolicy.markPersisted()
    this.markArtifactsPersisted()
    this.syncStoragePolicy()
    const watermark = snapshot.checkpoint?.logWatermark ?? 0
    if (watermark > 0 && this.mutationLog.lastSequence >= watermark) this.mutationLog.truncateThrough(watermark)
    if (eventWatermark !== undefined) {
      this.state.events = this.state.events.filter((event) => event.seq > eventWatermark)
      this.state.eventsCompactedThrough = Math.max(this.state.eventsCompactedThrough ?? 0, eventWatermark)
    }
    this.schedulePersistence()
    return snapshot
  }
  mergeProposals(agentId: string, proposalIds?: string[]): MergePlan {
    const plan = new ContextMerger(this.state).plan(agentId, proposalIds)
    if (plan.conflicts.length || plan.mutations.length === 0) return plan
    commitMutationTransaction(this.state, this.mutationLog, `context-merge:${agentId}:${plan.version ?? this.state.now}`, plan.mutations, this.state.now, this.sessionId)
    this.schedulePersistence()
    return plan
  }

  private emit(event: import('../core/types.js').RuntimeEventInput): import('../core/types.js').RuntimeEvent {
    const candidate = structuredClone(this.state)
    appendRuntimeEvent(candidate, event, { sessionId: this.sessionId, timestamp: candidate.now })
    const policy = this.storagePolicy.clone()
    this.syncStoragePolicy(policy, candidate)
    const emitted = appendRuntimeEvent(this.state, event, { sessionId: this.sessionId, timestamp: this.state.now })
    this.syncStoragePolicy()
    return emitted
  }
  private assertRecoveryPrograms(): void {
    if (!this.enforcingRecoveryPrograms) return
    if (this.recoveryCompatibility !== undefined) this.assertRecoveryCompatibility(this.recoveryCompatibility)
    for (const lane of this.state.lanes.values()) {
      if (['succeeded', 'failed', 'cancelled'].includes(lane.status)) continue
      const key = `${lane.resume.programId}@${lane.resume.programVersion}`
      if (!this.programs.has(key)) throw new Error(`PROGRAM_VERSION_UNAVAILABLE:${key}`)
    }
    for (const effect of this.state.effects.values()) {
      if (effect.outcome || ['succeeded', 'failed', 'cancelled'].includes(effect.state)) continue
      if (effect.kind !== 'tool' || effect.toolVersion === undefined) continue
      const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
      const name = input.name
      if (typeof name !== 'string' || this.currentToolVersions()[name] !== effect.toolVersion) throw new Error(`TOOL_VERSION_UNAVAILABLE:${typeof name === 'string' ? `${name}@${effect.toolVersion}` : effect.toolVersion}`)
    }
  }
  private persistenceCompatibility(): RuntimePersistenceCompatibility {
    const toolVersions = this.currentToolVersions()
    return {
      schemaVersion: 1,
      programVersions: Object.fromEntries([...this.programs.entries()].map(([key, program]) => [key, program.version])),
      toolVersions,
      ...(this.policyVersion === undefined ? {} : { policyVersion: this.policyVersion }),
      ...(this.routerVersion === undefined ? {} : { routerVersion: this.routerVersion }),
    }
  }
  private assertRecoveryCompatibility(expected: RuntimePersistenceCompatibility): void {
    for (const [key, version] of Object.entries(expected.programVersions)) {
      const program = this.programs.get(key)
      if (!program || program.version !== version) throw new Error(`PROGRAM_VERSION_UNAVAILABLE:${key}`)
    }
    const toolVersions = this.currentToolVersions()
    for (const [name, version] of Object.entries(expected.toolVersions)) if (toolVersions[name] !== version) throw new Error(`TOOL_VERSION_UNAVAILABLE:${name}@${version}`)
    if (expected.policyVersion !== undefined && this.policyVersion !== expected.policyVersion) throw new Error(`POLICY_VERSION_UNAVAILABLE:${expected.policyVersion}`)
    if (expected.routerVersion !== undefined && this.routerVersion !== expected.routerVersion) throw new Error(`ROUTER_VERSION_UNAVAILABLE:${expected.routerVersion}`)
  }

  private currentToolVersions(): Record<string, string> {
    return { ...this.toolVersions, ...Object.fromEntries(this.tools.list().map((manifest) => [manifest.name, manifest.version])) }
  }
  private tryEmit(event: import('../core/types.js').RuntimeEventInput): import('../core/types.js').RuntimeEvent | undefined {
    try {
      this.assertStorageAdmission([{ op: 'appendEvent', event }])
      return this.emit(event)
    } catch {
      return undefined
    }
  }
  private rejectHostCommand(eventId: string, code: string): void {
    const mutations: Mutation[] = [
      { op: 'appendEvent', event: { type: 'command.rejected', data: { eventId, code } } },
      { op: 'appendEvent', event: { type: 'command.applied', data: { eventId } } },
    ]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `host-command:${eventId}:rejected`, mutations, this.state.now, this.sessionId)
  }
  private prepareStepOutput(output: LaneStepOutput, lane?: Readonly<LaneRecord>): LaneStepOutput {
    const reasoningFloor = lane?.progressWatchdog?.interventionLevel !== undefined && lane.progressWatchdog.interventionLevel >= 2 ? 'high' : undefined
    return {
      ...output,
      actions: output.actions.map((action) => action.type === 'submit_effects' ? {
        ...action,
        effects: action.effects.map((effect) => {
          const prepared = this.effectSubmissionPreparer!(effect)
          if (reasoningFloor === undefined || prepared.kind !== 'llm' || !prepared.input || typeof prepared.input !== 'object' || Array.isArray(prepared.input)) return prepared
          const input = prepared.input as Record<string, JsonValue>
          const existing = input.requirements && typeof input.requirements === 'object' && !Array.isArray(input.requirements) ? input.requirements as Record<string, JsonValue> : {}
          const current = existing.reasoning
          if (current === 'high') return prepared
          return { ...prepared, input: { ...input, requirements: { ...existing, reasoning: reasoningFloor } } }
        }),
      } : action),
    }
  }

  private prepareRegisteredToolSubmission(submission: EffectSubmission): EffectSubmission {
    if (submission.kind === 'llm') {
      const input = submission.input && typeof submission.input === 'object' && !Array.isArray(submission.input) ? submission.input as Record<string, JsonValue> : {}
      const rawQuery = input.toolDiscovery
      if (rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery) && this.tools.list().length > 0) {
        const requestedId = typeof input.toolSetId === 'string' ? input.toolSetId : 'dynamic'
        const toolSet = this.tools.compileToolSet(requestedId, rawQuery as import('../tools/registry.js').RuntimeToolDiscoveryQuery)
        const tools = toolSet.tools.map((manifest) => ({ name: manifest.name, description: manifest.description, inputSchema: manifest.inputSchema as JsonValue }))
        return { ...submission, input: { ...input, toolSetId: `${toolSet.id}@${toolSet.version}`, tools: { tools } } }
      }
      return submission
    }
    if (submission.kind !== 'tool') return submission
    const input = submission.input && typeof submission.input === 'object' && !Array.isArray(submission.input) ? submission.input as Record<string, JsonValue> : {}
    if (typeof input.name !== 'string') return submission
    if (this.tools.get(input.name) === undefined) return submission
    const admission = this.tools.admission(input.name, input.arguments ?? {})
    return { ...submission, ...(submission.locks === undefined ? { locks: admission.locks } : {}), ...(submission.sideEffectPolicy === undefined ? { sideEffectPolicy: admission.sideEffectPolicy } : {}), ...(submission.attemptTimeoutMs === undefined ? { attemptTimeoutMs: admission.defaultTimeoutMs } : {}), ...(submission.toolVersion === undefined ? { toolVersion: admission.version } : {}) }
  }

  private async executeRegisteredEffect(effect: Readonly<EffectRecord>, signal: AbortSignal, emitObservation?: EffectObservationEmitter): Promise<EffectExecution> {
    if (effect.kind === 'tool') {
      const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
      const name = input.name
      if (typeof name !== 'string' || this.tools.get(name) === undefined) return { value: null }
      const observations: EffectObservation[] = []
      const emit = (event: { type: 'progress' | 'warning' | 'diagnostic'; data: JsonValue }): void => {
        if (signal.aborted) return
        const observation = { type: event.type, data: event.data } satisfies EffectObservation
        if (emitObservation) emitObservation(observation)
        else observations.push(observation)
      }
      const context = { toolCallId: effect.toolCallId ?? '', effectId: effect.id, attemptId: effect.attemptId, ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }), agentId: effect.agentId, laneId: effect.ownerLaneId, signal, emit }
      const definition = this.tools.get(name)!
      const argumentsValue = input.arguments ?? {}
      let executionRef: JsonValue | undefined
      try {
        executionRef = this.tools.executionRef(name, argumentsValue, context)
        const detailed = await this.tools.executeDetailed(name, argumentsValue, context)
        let value: JsonValue
        let artifact: EffectArtifactOutput | undefined
        try { value = strictJsonValue(detailed.output) } catch { value = null; artifact = artifactOutput(detailed.output) }
        return { value, ...(artifact === undefined ? {} : { artifact }), ...(detailed.normalized === undefined ? {} : { normalized: strictJsonValue(detailed.normalized) }), ...(detailed.summary === undefined ? {} : { summary: strictJsonValue(detailed.summary) }), sideEffectState: isSideEffectful(definition.manifest.sideEffectPolicy) ? 'applied' : 'none', executionState: 'succeeded', status: 'succeeded', ...(executionRef === undefined ? {} : { executionRef }), metadata: { toolVersion: detailed.manifest.version, retrySafety: detailed.manifest.retrySafety, defaultTimeoutMs: detailed.manifest.defaultTimeoutMs, observationCount: observations.length, ...(artifact === undefined ? {} : { artifactMediaType: artifact.mediaType }) }, ...(observations.length ? { observations } : {}) }
      } catch (cause) {
        if (signal.aborted && isSideEffectful(definition.manifest.sideEffectPolicy)) return { value: null, executionState: 'remote_unknown', sideEffectState: 'unknown', ...(executionRef === undefined ? {} : { executionRef }), metadata: { toolVersion: definition.manifest.version, reconcileRequired: true }, ...(cause instanceof Error ? { error: { code: 'TOOL_CANCELLED_UNKNOWN', message: cause.message } } : {}) }
        const error = runtimeErrorFromCause(cause, 'TOOL_EXECUTION_FAILED')
        return { value: null, status: signal.aborted ? 'cancelled' : 'failed', executionState: 'failed', sideEffectState: 'none', ...(executionRef === undefined ? {} : { executionRef }), ...(cause instanceof Error ? { error } : {}), ...(observations.length ? { observations } : {}) }
      }
    }
    if (effect.kind !== 'llm') return { value: null }
    const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    const task = input.task
    const request = input.request
    if (typeof task !== 'string' || !request || typeof request !== 'object' || Array.isArray(request)) return { value: null, status: 'failed', executionState: 'failed', error: { code: 'INVALID_LLM_EFFECT_INPUT', message: 'LLM effect requires task and request.' } }
    const projection = request as unknown as import('../core/types.js').LLMRequestProjection
    const dynamicRequirements = input.requirements && typeof input.requirements === 'object' && !Array.isArray(input.requirements) ? input.requirements as Record<string, JsonValue> : {}
    const structuredRequirement = dynamicRequirements.structuredOutput
    const structuredSchema = structuredRequirement && typeof structuredRequirement === 'object' && !Array.isArray(structuredRequirement) ? (structuredRequirement as Record<string, JsonValue>).schema : undefined
    if (structuredSchema !== undefined && (input.outputSchema === undefined || stableSerialize(structuredSchema) !== stableSerialize(input.outputSchema))) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'STRUCTURED_OUTPUT_CONTRACT_MISMATCH', message: 'requirements.structuredOutput.schema must equal outputSchema.' } }
    const requirements: ModelRouteRequirements = {
      ...(typeof dynamicRequirements.toolCalling === 'boolean' ? { toolCalling: dynamicRequirements.toolCalling } : {}),
      ...(typeof dynamicRequirements.structuredOutput === 'boolean' ? { structuredOutput: dynamicRequirements.structuredOutput } : structuredSchema === undefined ? {} : { structuredOutput: true }),
      ...(dynamicRequirements.reasoning === 'low' || dynamicRequirements.reasoning === 'medium' || dynamicRequirements.reasoning === 'high' ? { reasoning: dynamicRequirements.reasoning } : {}),
      ...(typeof dynamicRequirements.maxOutputTokens === 'number' ? { maxOutputTokens: dynamicRequirements.maxOutputTokens } : {}),
      ...(typeof dynamicRequirements.contextSize === 'number' ? { contextSize: dynamicRequirements.contextSize } : {}),
    }
    const candidates = this.modelRouter.routeProjection(task, projection, requirements)
    const routes = this.modelRouter.diagnostics(task, projection.privacy, requirements)
    const maxAttempts = effect.retryPolicy?.maxAttempts ?? candidates.length
    const attemptNo = effect.attemptNo
    const candidate = candidates[attemptNo - 1]
    const attemptId = effect.attemptId
    const metadata = (attempt: JsonValue): JsonValue => ({ selected: { id: candidate?.id ?? null, providerId: candidate?.providerId ?? null }, routes: asJsonValue(routes), attempts: [attempt] })
    const canFallback = candidate !== undefined && attemptNo < Math.max(0, maxAttempts) && candidates[attemptNo] !== undefined
    if (candidate === undefined) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: candidates.length === 0 ? 'NO_ELIGIBLE_MODEL' : 'MODEL_ATTEMPT_LIMIT_REACHED', message: candidates.length === 0 ? 'No model candidate satisfies the task, privacy, capability, and context requirements.' : 'No additional routed model candidate is available for this Effect.' }, metadata: { routes: asJsonValue(routes), attempts: [] } }
    const attemptBase = { attemptId, attemptNo, modelId: candidate.id, providerId: candidate.providerId }
    if (candidate.adapter === undefined) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'MODEL_ADAPTER_NOT_BOUND', message: `No adapter is bound to routed model ${candidate.id}.`, ...(canFallback ? { retryable: true } : {}) }, metadata: metadata(attemptBase) }
    const startedAt = Date.now()
    try {
      const result = assignRuntimeToolCallIds(validateAdapterResult(await candidate.adapter.executeAttempt({ request: projection, signal, model: candidate.id, ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }), ...(typeof requirements.maxOutputTokens === 'number' ? { maxOutputTokens: requirements.maxOutputTokens } : {}), ...(emitObservation === undefined ? {} : { onObservation: (chunk: string) => emitObservation({ type: 'chunk', data: chunk }) }) })), effect.id)
      const usage = result.usage === undefined ? { latencyMs: Math.max(0, Date.now() - startedAt) } : { ...result.usage, latencyMs: result.usage.latencyMs ?? Math.max(0, Date.now() - startedAt) }
      const attempt = { ...attemptBase, usage }
      if (result.finishReason === 'refusal') {
        this.modelRouter.recordFeedback({ modelId: candidate.id, providerId: candidate.providerId, outcome: 'refused', ...(result.usage === undefined ? {} : { usage: result.usage }) })
        return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'MODEL_REFUSAL', message: result.refusal ?? 'Model refused the request.', ...(canFallback ? { retryable: true } : {}) }, metadata: metadata(attempt) }
      }
      if (result.finishReason === 'error') {
        this.modelRouter.recordFeedback({ modelId: candidate.id, providerId: candidate.providerId, outcome: 'failed', ...(result.usage === undefined ? {} : { usage: result.usage }) })
        return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'MODEL_ERROR', message: 'Model adapter returned an error result.', ...(canFallback ? { retryable: true } : {}) }, metadata: metadata(attempt) }
      }
      const output = input.outputSchema === undefined ? result : result.structured ?? result.text
      if (input.outputSchema !== undefined && !validateJsonSchema(output, input.outputSchema)) {
        this.modelRouter.recordFeedback({ modelId: candidate.id, providerId: candidate.providerId, outcome: 'schema_rejected', ...(result.usage === undefined ? {} : { usage: result.usage }) })
        return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'OUTPUT_SCHEMA_VIOLATION', message: 'Provider output did not match the declared schema.', ...(canFallback ? { retryable: true } : {}) }, metadata: metadata(attempt), rejectedOutput: { value: asJsonValue(output), privacy: projection.privacy, derivedFrom: [...(effect.derivedFrom ?? [])] } }
      }
      this.modelRouter.recordFeedback({ modelId: candidate.id, providerId: candidate.providerId, outcome: 'succeeded', ...(result.usage === undefined ? {} : { usage: result.usage }) })
      return { value: asJsonValue(output), privacy: projection.privacy, sideEffectState: 'none', executionState: 'succeeded', metadata: metadata({ ...attempt, usage }) }
    } catch (cause) {
      this.modelRouter.recordFeedback({ modelId: candidate.id, providerId: candidate.providerId, outcome: 'failed' })
      const error = runtimeErrorFromCause(cause, 'MODEL_EXECUTION_FAILED')
      return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { ...error, ...(canFallback && error.retryable !== false ? { retryable: true } : {}) }, metadata: metadata({ ...attemptBase, error: error.message }) }
    }
  }
  private journalEffect(effect: EffectRecord, transactionId: string, result?: import('../core/types.js').ResultRecord, events: import('../core/types.js').RuntimeEvent[] = [], lane?: LaneRecord, correlation?: ToolCallCorrelation, artifact?: ArtifactRecord): void {
    const mutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: structuredClone(effect) }]
    if (artifact) mutations.push({ op: 'publishArtifact', record: structuredClone(artifact) })
    if (result) mutations.push({ op: 'publishResult', record: structuredClone(result) })
    if (lane) mutations.push({ op: 'setLane', laneId: lane.id, record: structuredClone(lane) })
    if (correlation) mutations.push({ op: 'setToolCallCorrelation', record: structuredClone(correlation) })
    for (const event of events) {
      if (event.txId === undefined) event.txId = transactionId
      const { seq: _seq, ...input } = event
      mutations.push({ op: 'appendEvent', event: input })
    }
    this.mutationLog.append(transactionId, mutations, this.state.now)
  }

  enqueueHostCommand(command: HostCommand): void {
    const eventId = `host-command-${this.hostCommandSeq}`
    const candidateInbox = FactInbox.fromSnapshot(this.factInbox.snapshot())
    if (!candidateInbox.enqueue(command, eventId)) return
    const candidatePolicy = this.storagePolicy.clone()
    this.syncStoragePolicy(candidatePolicy, this.state, candidateInbox)
    const envelope = this.factInbox.enqueue(command, eventId)
    if (!envelope) return
    this.hostCommandSeq++
    this.syncStoragePolicy()
    this.schedulePersistence()
    for (const resolve of this.factWaiters.splice(0)) resolve()
  }

  enqueueLane(laneId: string): void { const lane = this.state.lanes.get(laneId); if (lane && lane.status === 'ready') { lane.enqueueSeq = this.enqueueSeq++; lane.readySince = this.state.now; this.ready.enqueue(readyItemFromLane(lane)) } }

  private seriesStep(program: LaneProgram, context: LaneStepContext, series?: SeriesLaneSpec): LaneStepOutput {
    const locals = context.lane.resume.locals && typeof context.lane.resume.locals === 'object' && !Array.isArray(context.lane.resume.locals) ? context.lane.resume.locals as Record<string, JsonValue> : {}
    const sdkValue = locals.$sdk && typeof locals.$sdk === 'object' && !Array.isArray(locals.$sdk) ? locals.$sdk as Record<string, JsonValue> : {}
    const seriesValue = sdkValue.series && typeof sdkValue.series === 'object' && !Array.isArray(sdkValue.series) ? sdkValue.series as Record<string, JsonValue> : {}
    const keys = Array.isArray(seriesValue.keys) ? seriesValue.keys.filter((key): key is string => typeof key === 'string') : (series?.keys ?? program.seriesKeys ?? ['member'])
    const index = typeof seriesValue.index === 'number' && Number.isInteger(seriesValue.index) && seriesValue.index >= 0 ? seriesValue.index : 0
    const memberRef = series?.member ?? (program.seriesMember ? { programId: program.seriesMember.programId, programVersion: program.seriesMember.programVersion, step: program.seriesMember.step ?? 'start', locals: program.seriesMember.locals ?? {} } : undefined)
    const member = memberRef === undefined ? undefined : this.programs.get(`${memberRef.programId}@${memberRef.programVersion}`)
    if (!member || memberRef === undefined) return { actions: [{ type: 'fail', error: { code: 'PROGRAM_NOT_REGISTERED', message: memberRef ? `${memberRef.programId}@${memberRef.programVersion}` : 'series member' } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals } }
    if (index >= keys.length) return { actions: [{ type: 'complete', result: sdkValue.seriesResults ?? { results: {} } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals } }
    const memberLocals = sdkValue.memberLocals ?? memberRef.locals ?? {}
    const memberLane = structuredClone(context.lane) as LaneRecord
    memberLane.resume = { programId: member.id, programVersion: member.version, step: typeof sdkValue.memberStep === 'string' ? sdkValue.memberStep : memberRef.step ?? (member as LaneProgram & { entry?: string }).entry ?? 'start', locals: structuredClone(memberLocals) }
    memberLane.goal = series?.goals?.[keys[index]!] ?? `${context.lane.goal} [series:${keys[index]}]`
    const seriesResults = sdkValue.seriesResults && typeof sdkValue.seriesResults === 'object' && !Array.isArray(sdkValue.seriesResults) ? sdkValue.seriesResults as Record<string, JsonValue> : {}
    const nextLocals = (nextSdk: Record<string, JsonValue>): JsonValue => ({ ...locals, $sdk: nextSdk })
    const nextAfterMember = (nextIndex: number): LaneStepOutput => { const nextSdk: Record<string, JsonValue> = { ...sdkValue, series: { keys, index: nextIndex }, seriesResults }; delete nextSdk.memberStep; delete nextSdk.memberLocals; return nextIndex >= keys.length ? { actions: [{ type: 'complete', result: { results: seriesResults } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals(nextSdk) } } : { actions: [], next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals(nextSdk) } } }
    const memberDependencies = series?.members?.[keys[index]!]?.dependsOn ?? []
    const dependencyObservations = Object.fromEntries(memberDependencies.map((dependency) => {
      const record = seriesResults[dependency.key]
      const value = record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, JsonValue> : {}
      const status = value.status === 'succeeded' || value.status === 'failed' || value.status === 'cancelled' ? value.status : undefined
      const outcome: Outcome = status === undefined ? { status: 'failed', error: { code: 'SERIES_DEPENDENCY_MISSING', message: `Series dependency ${dependency.key} is not settled.` } } : { status, ...(value.result === undefined ? {} : { result: value.result }), ...(value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? { error: value.error as unknown as RuntimeError } : {}), ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
      return [dependency.key, { state: 'settled' as const, target: { kind: 'lane' as const, id: `series:${dependency.key}` }, outcome }]
    }))
    const blocked = memberDependencies.find((dependency) => dependency.condition === 'success' && dependencyObservations[dependency.key]?.outcome.status !== 'succeeded')
    if (blocked) {
      seriesResults[keys[index]!] = { status: 'failed', error: { code: 'DEPENDENCY_FAILED', message: `Series dependency ${blocked.key} did not succeed` } }
      if ((series?.onMemberFailure ?? program.seriesOnMemberFailure ?? 'continue') === 'abort') return { actions: [{ type: 'fail', error: { code: 'DEPENDENCY_FAILED', message: `Series dependency ${blocked.key} did not succeed` } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals({ ...sdkValue, series: { keys, index }, seriesResults }) } }
      return nextAfterMember(index + 1)
    }
    const output = member.step({ ...context, lane: memberLane, ...(memberDependencies.length && sdkValue.memberStep === undefined ? { resumeInput: { type: 'wait', resolution: { waitId: `series:${keys[index]}`, status: 'satisfied', dependencies: dependencyObservations } } } : {}) })
    const terminal = output.actions.find((action) => action.type === 'complete' || action.type === 'fail')
    if (terminal?.type === 'fail') {
      seriesResults[keys[index]!] = { status: 'failed', error: terminal.error as unknown as JsonValue }
      if ((series?.onMemberFailure ?? program.seriesOnMemberFailure ?? 'continue') === 'abort') return output
    } else if (terminal?.type === 'complete') {
      seriesResults[keys[index]!] = { status: 'succeeded', result: terminal.result }
    }
    if (terminal) {
      const nextIndex = index + 1
      return nextAfterMember(nextIndex)
    }
    const nextSdk: Record<string, JsonValue> = { ...sdkValue, series: { keys, index }, memberStep: output.next.step, memberLocals: output.next.locals }
    return { ...output, next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals(nextSdk) } }
  }

  tick(): number {
    this.assertRecoveryPrograms()
    this.state.now = this.clock.now()
    while (this.factInbox.size > 0) {
      const before = this.factInbox.snapshot()
      const envelope = this.factInbox.drain(1)[0]
      if (!envelope) break
      try {
        let commandApplied = false
        if (!this.state.events.some((event) => event.id === envelope.eventId && event.type === 'command.enqueued')) this.emit({ id: envelope.eventId, type: 'command.enqueued', data: envelope.fact as unknown as JsonValue })
      if (envelope.fact.type === 'reply') {
        const effect = this.state.effects.get(envelope.fact.effectId)
        if (effect?.agentId === envelope.fact.agentId && effect.kind === 'human' && !effect.outcome) commandApplied = this.completeEffect(envelope.fact.effectId, { value: envelope.fact.value }, 'succeeded', undefined, [{ op: 'appendEvent', event: { type: 'command.applied', data: { eventId: envelope.eventId } } }])
        else { this.rejectHostCommand(envelope.eventId, effect?.agentId !== envelope.fact.agentId ? 'EFFECT_NOT_OWNED' : 'EFFECT_NOT_REPLYABLE'); commandApplied = true }
      } else if (envelope.fact.type === 'cancel') commandApplied = this.cancelAgent(envelope.fact.agentId, envelope.fact.reason, [{ op: 'appendEvent', event: { type: 'command.applied', data: { eventId: envelope.eventId } } }], `host-command:${envelope.eventId}`)
      else if (envelope.fact.type === 'cancel_effect') {
        const effect = this.state.effects.get(envelope.fact.effectId)
        if (!effect || effect.agentId !== envelope.fact.agentId) { this.rejectHostCommand(envelope.eventId, 'EFFECT_NOT_OWNED'); commandApplied = true }
        else if (effect.outcome) { this.rejectHostCommand(envelope.eventId, 'EFFECT_ALREADY_SETTLED'); commandApplied = true }
        else commandApplied = this.cancelEffect(envelope.fact.effectId, 0, envelope.fact.reason, [{ op: 'appendEvent', event: { type: 'command.applied', data: { eventId: envelope.eventId } } }])
      } else {
        const lane = this.state.lanes.get(envelope.fact.laneId)
        if (!lane) { this.rejectHostCommand(envelope.eventId, 'LANE_NOT_FOUND'); commandApplied = true }
        else if (['succeeded', 'failed', 'cancelled'].includes(lane.status)) { this.rejectHostCommand(envelope.eventId, 'LANE_TERMINAL'); commandApplied = true }
        else {
          const nextLane = structuredClone(lane)
          nextLane.priority = envelope.fact.priority
          nextLane.version++
          const event = { type: 'lane.priority_changed' as const, laneId: lane.id, data: { previous: lane.priority, priority: nextLane.priority } }
          const appliedEvent = { type: 'command.applied' as const, data: { eventId: envelope.eventId } }
          const mutations: Mutation[] = [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }, { op: 'appendEvent', event: appliedEvent }]
          this.assertStorageAdmission(mutations)
          commitMutationTransaction(this.state, this.mutationLog, `host-command:${envelope.eventId}`, mutations, this.state.now, this.sessionId)
          Object.assign(lane, nextLane)
          this.state.lanes.set(lane.id, lane)
          if (lane.status === 'ready') this.ready.enqueue(readyItemFromLane(lane))
          commandApplied = true
        }
      }
      if (!commandApplied) this.emit({ type: 'command.applied', data: { eventId: envelope.eventId } })
      } catch (cause) {
        this.factInbox.restore(before)
        throw cause
      }
    }
    if (this.maxRuntimeAt !== undefined) for (const agent of this.state.agents.values()) if (agent.state === 'running' && this.state.now >= this.maxRuntimeAt) this.cancelAgent(agent.id, 'TIMEOUT')
    for (const agent of this.state.agents.values()) if (agent.state === 'running' && agent.deadlineAt !== undefined && this.state.now >= agent.deadlineAt) this.cancelAgent(agent.id, 'TIMEOUT')
    for (const timer of this.clock.timers.due(this.state.now)) timer.callback()
    let progressed = 0
    while (progressed < this.maxSteps) {
      const laneId = this.ready.dequeue(this.state.now)
      if (!laneId) break
      const lane = this.state.lanes.get(laneId)
      if (!lane || lane.status !== 'ready') continue
      const currentPressure = historyPressure(lane.context.history, this.state.historySoftTokens, this.state.historyHardTokens)
      const stepLane = structuredClone(lane)
      if (currentPressure) stepLane.historyPressure = currentPressure
      else delete stepLane.historyPressure
      const program = this.programs.get(`${lane.resume.programId}@${lane.resume.programVersion}`)
      if (!program) { this.failLane(lane, { code: 'PROGRAM_NOT_REGISTERED', message: `${lane.resume.programId}@${lane.resume.programVersion}` }); continue }
      let output: LaneStepOutput
      const stepContext: LaneStepContext = { lane: stepLane, state: structuredClone(this.state), ...(lane.pendingResumeInput ? { resumeInput: structuredClone(lane.pendingResumeInput) } : {}), now: this.state.now, observe: (event) => { this.observationInbox.enqueue({ ...event, agentId: lane.agentId, laneId: lane.id, timestamp: this.state.now }) } }
      try { output = withPureStepGuard(() => lane.series || program.seriesMember ? this.seriesStep(program, stepContext, lane.series) : program.step(stepContext)) }
      catch (cause) {
        const failure: RuntimeError = runtimeErrorFromCause(cause, 'STEP_FAILED')
        if (!program.errorBoundary) { this.failLane(lane, failure); continue }
        try { output = withPureStepGuard(() => program.errorBoundary!(failure, stepContext)) }
        catch (boundaryCause) { this.failLane(lane, { code: 'ERROR_BOUNDARY_FAILED', message: boundaryCause instanceof Error ? boundaryCause.message : String(boundaryCause) }); continue }
      }
      if (output && typeof output === 'object' && typeof (output as unknown as { then?: unknown }).then === 'function') {
        this.failLane(lane, { code: 'ASYNC_STEP_FORBIDDEN', message: 'LaneProgram.step() must return synchronously; external work belongs in an Effect.' })
        continue
      }
      let preparedOutput: LaneStepOutput
      try { preparedOutput = this.prepareStepOutput(output, lane) }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const candidate = cause && typeof cause === 'object' ? cause as { code?: unknown } : undefined
        const code = typeof candidate?.code === 'string' ? candidate.code : message.split(':', 1)[0] || 'STEP_OUTPUT_PREPARATION_FAILED'
        const rejection: RuntimeError = { code, message }
        const consecutive = (lane.consecutiveControlErrors ?? 0) + 1
        const controlInput: ResumeInput = { type: 'control_error', error: rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
        if (consecutive >= this.maxConsecutiveControlErrors) this.failLane(lane, { code: 'CONTROL_ERROR_LOOP', message: 'Lane exceeded the consecutive control error limit.', details: { lastError: rejection as unknown as JsonValue } })
        else this.commitLaneControlInput(lane, controlInput, { type: 'step.rejected', laneId: lane.id, data: rejection as unknown as JsonValue }, { consecutiveControlErrors: consecutive })
        progressed++
        continue
      }
      const result = validateStep(this.state, lane.id, preparedOutput)
      if ('rejection' in result) {
        const consecutive = (lane.consecutiveControlErrors ?? 0) + 1
        const controlInput: ResumeInput = { type: 'control_error', error: result.rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
        if (result.rejection.code === 'FORK_AFFINITY_COLLAPSIBLE') {
          this.commitLaneControlInput(lane, controlInput, { type: 'fork.affinity_advice', laneId: lane.id, data: result.rejection as unknown as JsonValue })
        } else {
          if (consecutive >= this.maxConsecutiveControlErrors) this.failLane(lane, { code: 'CONTROL_ERROR_LOOP', message: 'Lane exceeded the consecutive control error limit.', details: { lastError: result.rejection as unknown as JsonValue } })
          else this.commitLaneControlInput(lane, controlInput, { type: 'step.rejected', laneId: lane.id, data: result.rejection as unknown as JsonValue }, { consecutiveControlErrors: consecutive })
        }
      } else {
        let watchdogObservation: ProgressObservation | undefined
        if (preparedOutput.actions.some((action) => action.type === 'submit_effects')) {
          const observation = observeProgress(lane, preparedOutput, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold, repeatedActionThreshold: this.watchdogRepeatedActionThreshold, admission: true })
          if (observation.rejected) {
            if (observation.state.interventionLevel >= 3) this.failLane(lane, observation.rejected, { progressWatchdog: observation.state })
            else this.commitLaneControlInput(lane, { type: 'control_error', error: observation.rejected, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }, { type: 'progress.intervention_applied', laneId: lane.id, data: observation.rejected as unknown as JsonValue }, { progressWatchdog: observation.state })
            progressed++
            continue
          }
          watchdogObservation = observation
        }
        const watchdog = watchdogObservation ?? observeProgress(lane, preparedOutput, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold, repeatedActionThreshold: this.watchdogRepeatedActionThreshold })
        const stepMutations = result.mutations.map((mutation) => {
          if (mutation.op !== 'setLane' || mutation.laneId !== lane.id) return mutation
          const nextLane = structuredClone(mutation.record)
          delete nextLane.consecutiveControlErrors
          delete nextLane.pendingResumeInput
          nextLane.progressWatchdog = watchdog.state
          return { ...mutation, record: nextLane }
        })
        if (!watchdog.progressed) stepMutations.push({ op: 'appendEvent', event: { type: watchdog.state.interventionLevel >= 3 ? 'progress.no_progress_detected' : 'progress.intervention_applied', laneId: lane.id, data: { noProgressCount: watchdog.state.noProgressCount, interventionLevel: watchdog.state.interventionLevel } } })
        try { this.assertStorageAdmission(stepMutations) }
        catch (cause) {
          const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }
          this.failLane(lane, storageError)
          progressed++
          continue
        }
        commitMutationTransaction(this.state, this.mutationLog, `step:${lane.id}:${lane.version + 1}`, stepMutations, this.state.now, this.sessionId)
        for (const mutation of stepMutations) if (mutation.op === 'insertEffect') this.outbox.enqueue(mutation.record, this.state.now)
        for (const mutation of stepMutations) if (mutation.op === 'insertWait') this.scheduleWaitDeadline(mutation.record)
        const updated = this.state.lanes.get(lane.id)
        if (updated) {
          if (watchdog.state.interventionLevel >= 3 && !['succeeded', 'failed', 'cancelled'].includes(updated.status)) this.failLane(updated, { code: 'NO_PROGRESS_DETECTED', message: 'Lane made no observable progress within the watchdog threshold.' })
        }
        if (updated?.status === 'ready') this.enqueueLane(updated.id)
        this.enqueueNewReadyLanes()
        this.refreshWaits()
        this.propagateCancelledLanes()
        this.syncStoragePolicy()
      }
      this.dispatchQueuedEffects()
      progressed++
    }
    this.completeFinishedChildAgents()
    this.finalizeCancellations()
    this.syncStoragePolicy()
    this.schedulePersistence()
    return progressed
  }

  async run(): Promise<Outcome>
  async run(maxTicks: number): Promise<Outcome>
  async run(agentId: string, maxTicks?: number): Promise<Outcome>
  async run(agentOrMaxTicks: string | number = 10_000, requestedMaxTicks = 10_000): Promise<Outcome> {
    if (typeof agentOrMaxTicks === 'string') return this.runAgent(agentOrMaxTicks, requestedMaxTicks)
    for (let tick = 0; tick < agentOrMaxTicks; tick++) {
      const work = this.tick()
      await this.flushPersistence()
      if (this.executionYieldPending.size) { this.executionYieldPending.clear(); await new Promise<void>((resolve) => setImmediate(resolve)) }
      this.refreshWaits()
      if (this.ready.size === 0 && this.executions.size === 0) {
        if (this.preparingLLMs.size) { await Promise.resolve(); continue }
        if (this.factInbox.size > 0) continue
        if (this.hasPendingHostInteraction()) { await this.waitForFact(); continue }
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined) { if (nextAt > this.clock.now()) { if (this.clock.waitUntil) await this.clock.waitUntil(nextAt); else this.clock.set(nextAt) }; continue }
        break
      }
      if (work === 0 && this.executions.size) {
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined && nextAt > this.clock.now()) {
          if (this.clock.waitUntil) await Promise.race([this.clock.waitUntil(nextAt), ...[...this.executions.values()].map((execution) => execution.promise)])
          else this.clock.set(nextAt)
          continue
        }
        await Promise.race([...this.executions.values()].map((execution) => execution.promise))
      }
      else if (work === 0 && this.factInbox.size === 0 && this.hasPendingHostInteraction()) await this.waitForFact()
      else if (work === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const root = [...this.state.lanes.values()].find((lane) => lane.ownerLaneId === undefined)
    const status: 'succeeded' | 'failed' | 'cancelled' = root?.status === 'succeeded' ? 'succeeded' : root?.status === 'cancelled' ? 'cancelled' : 'failed'
    if (root && !['succeeded', 'failed', 'cancelled'].includes(root.status)) this.emit({ type: 'runtime.idle_blocked', laneId: root.id, data: { status: root.status } })
    const agent = root ? this.state.agents.get(root.agentId) : undefined
    if (agent && ['succeeded', 'failed', 'cancelled'].includes(root?.status ?? 'failed')) this.commitAgentState(agent.id, status, `agent:${agent.id}:run-settled:${root?.version ?? this.state.now}`)
    await this.flushPersistence()
    return runOutcome(root, this.quarantine.unresolvedEffectIds)
  }

  async runAgent(agentId: string, maxTicks = 10_000): Promise<Outcome> {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    for (let tick = 0; tick < maxTicks; tick++) {
      const work = this.tick()
      await this.flushPersistence()
      if (this.executionYieldPending.size) { this.executionYieldPending.clear(); await new Promise<void>((resolve) => setImmediate(resolve)) }
      this.refreshWaits()
      const root = this.state.lanes.get(agent.rootLaneId)
      if (root && ['succeeded', 'failed', 'cancelled'].includes(root.status)) {
        const status: 'succeeded' | 'failed' | 'cancelled' = root.status === 'succeeded' ? 'succeeded' : root.status === 'cancelled' ? 'cancelled' : 'failed'
        this.commitAgentState(agent.id, status, `agent:${agent.id}:run-agent-settled:${root.version}`)
        const effectIds = new Set([...this.state.effects.values()].filter((effect) => effect.agentId === agentId).map((effect) => effect.id))
        await this.flushPersistence()
        return runOutcome(root, this.quarantine.unresolvedEffectIds.filter((effectId) => effectIds.has(effectId)))
      }
      if (this.ready.size === 0 && this.executions.size === 0) {
        if (this.preparingLLMs.size) { await Promise.resolve(); continue }
        if (this.factInbox.size > 0) continue
        if (this.hasPendingHostInteraction(agentId)) { await this.waitForFact(); continue }
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined) { if (nextAt > this.clock.now()) { if (this.clock.waitUntil) await this.clock.waitUntil(nextAt); else this.clock.set(nextAt) }; continue }
        break
      }
      if (work === 0 && this.executions.size) {
        const executions = [...this.executions.entries()].filter(([effectId]) => this.state.effects.get(effectId)?.agentId === agentId).map(([, execution]) => execution.promise)
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined && nextAt > this.clock.now()) {
          if (this.clock.waitUntil) await Promise.race([this.clock.waitUntil(nextAt), ...executions])
          else this.clock.set(nextAt)
          continue
        }
        if (executions.length) await Promise.race(executions)
        else await Promise.resolve()
      } else if (work === 0 && this.factInbox.size === 0 && this.hasPendingHostInteraction(agentId)) await this.waitForFact()
      else if (work === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const root = this.state.lanes.get(agent.rootLaneId)
    if (root && !['succeeded', 'failed', 'cancelled'].includes(root.status)) this.emit({ type: 'runtime.idle_blocked', laneId: root.id, data: { status: root.status } })
    const effectIds = new Set([...this.state.effects.values()].filter((effect) => effect.agentId === agentId).map((effect) => effect.id))
    return runOutcome(root, this.quarantine.unresolvedEffectIds.filter((effectId) => effectIds.has(effectId)))
  }

  async waitForIdle(): Promise<void> { while (this.ready.size || this.executions.size || this.preparingLLMs.size) { this.tick(); if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise)); else if (this.preparingLLMs.size) await Promise.resolve() } }

  async shutdown(timeoutMs = 5_000): Promise<{ status: 'stopped' | 'timed_out'; unresolvedEffectIds: string[]; quarantine: string[] }> {
    this.shuttingDown = true
    for (const agent of this.state.agents.values()) if (agent.state === 'running' || agent.state === 'cancelling') this.cancelAgent(agent.id, 'USER_REQUESTED')
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while ((this.ready.size || this.executions.size) && Date.now() < deadline) {
      this.tick()
      if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise).concat([new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now()))))]))
    }
    await this.flushPersistence()
    const unresolved = [...this.state.effects.values()].filter((effect) => !effect.outcome && effect.state !== 'cancelled').map((effect) => effect.id)
    return { status: unresolved.length || this.executions.size ? 'timed_out' : 'stopped', unresolvedEffectIds: [...new Set([...unresolved, ...this.quarantine.unresolvedEffectIds])], quarantine: this.quarantine.unresolvedEffectIds }
  }

  inspect(): JsonValue { const explanation = this.explain() as Record<string, JsonValue>; return { ...explanation, quarantineEntries: this.quarantine.snapshot() as unknown as JsonValue, observationsPending: this.observationInbox.size } }

  telemetry(): RuntimeTelemetrySnapshot { return collectRuntimeTelemetry(this.state) }
  async exportTelemetry(timestamp = Date.now()): Promise<RuntimeTelemetrySnapshot> {
    const snapshot = this.telemetry()
    if (this.telemetryExporter) await this.telemetryExporter.publish({ schemaVersion: 1, timestamp, snapshot })
    return snapshot
  }

  async exportAuditLog(options: SessionLogExportOptions = {}): Promise<SessionLogExport> {
    const maxPrivacy = options.maxPrivacy ?? this.auditLogPrivacy
    const effective = maxPrivacy === undefined ? options : { ...options, maxPrivacy }
    return this.auditLogSink === undefined ? exportRuntimeLog(this.state, effective) : exportRuntimeLogTo(this.state, this.auditLogSink, effective)
  }

  private assertStorageAdmission(mutations: Mutation[]): void {
    const candidate = structuredClone(this.state)
    apply(candidate, mutations, { sessionId: this.sessionId, timestamp: candidate.now })
    const policy = this.storagePolicy.clone()
    this.syncStoragePolicy(policy, candidate)
  }

  private schedulePersistence(): void {
    if (!this.persistenceBackend) return
    this.persistenceDirty = true
    if (this.persistenceScheduled) return
    this.persistenceScheduled = true
    this.persistencePending = this.persistencePending.catch(() => undefined).then(async () => {
      while (this.persistenceDirty) {
        this.persistenceDirty = false
        await this.persist(this.persistenceBackend!)
      }
    }).finally(() => {
      this.persistenceScheduled = false
      if (this.persistenceDirty) this.schedulePersistence()
    })
  }

  private persistenceState(): RuntimeState {
    const state = structuredClone(this.state)
    for (const artifact of state.artifacts.values()) artifact.storageState = 'persisted'
    return state
  }

  private markArtifactsPersisted(): void {
    for (const artifact of this.state.artifacts.values()) artifact.storageState = 'persisted'
  }

  private syncStoragePolicy(policy = this.storagePolicy, state = this.state, factInbox = this.factInbox): void {
    const transactional = policy === this.storagePolicy
    const target = transactional ? policy.clone() : policy
    const residency = new Map<string, { storageState: 'memory' | 'persisted'; pinCount: number }>()
    const pinKeys = new Set<string>()
    for (const lane of state.lanes.values()) {
      const active = !['succeeded', 'failed', 'cancelled'].includes(lane.status)
      if (active) pinKeys.add(`snapshot:lane:${lane.id}:${lane.context.version}`)
      if (active) for (const ref of lane.visibleResultRefs ?? []) pinKeys.add(`result:${ref}`)
      for (const record of lane.context.history) for (const ref of record.resultRefs) pinKeys.add(`result:${ref}`)
      if (lane.activeWaitId) pinKeys.add(`snapshot:wait:${lane.activeWaitId}`)
      if (lane.pendingResumeInput) pinKeys.add(`snapshot:resume:${lane.id}:${lane.version}`)
    }
    for (const agent of state.agents.values()) for (const [version] of agent.globalVersions) if ([...state.lanes.values()].some((lane) => lane.agentId === agent.id && !['succeeded', 'failed', 'cancelled'].includes(lane.status) && lane.contextSnapshotVersion === version)) pinKeys.add(`snapshot:global:${agent.id}:${version}`)
    for (const wait of state.waits.values()) if (wait.state === 'pending') pinKeys.add(`snapshot:wait:${wait.id}`)
    for (const artifact of state.artifacts.values()) {
      if (artifact.pinCount > 0) pinKeys.add(`artifact:${artifact.ref}`)
    }
    for (const effect of state.effects.values()) {
      if (!effect.outcome && effect.kind === 'llm') pinKeys.add(`snapshot:request:${effect.id}:${effect.attemptId}`)
      if (!effect.outcome) for (const ref of effect.derivedFrom ?? []) pinKeys.add(`${provenanceRefKind(ref) === 'artifact' ? 'artifact' : 'result'}:${provenanceRefId(ref)}`)
    }
    for (const envelope of factInbox.snapshot().queue) pinKeys.add(`snapshot:fact:${envelope.eventId}`)
    target.replacePinSource('runtime', pinKeys)
    for (const lane of state.lanes.values()) {
      const snapshotKey = `snapshot:lane:${lane.id}:${lane.context.version}`
      target.put('snapshot', snapshotKey, { laneId: lane.id, version: lane.context.version, context: lane.context, resume: lane.resume } as unknown as JsonValue)
    }
    for (const agent of state.agents.values()) {
      for (const [version, value] of agent.globalVersions) {
        const key = `snapshot:global:${agent.id}:${version}`
        target.put('snapshot', key, { agentId: agent.id, version, value } as unknown as JsonValue)
      }
    }
    for (const wait of state.waits.values()) {
      const key = `snapshot:wait:${wait.id}`
      target.put('snapshot', key, wait as unknown as JsonValue)
    }
    for (const effect of state.effects.values()) {
      if (!effect.outcome && effect.kind === 'llm') {
        const key = `snapshot:request:${effect.id}:${effect.attemptId}`
        target.put('snapshot', key, { effectId: effect.id, attemptId: effect.attemptId, input: effect.input } as unknown as JsonValue)
      }
    }
    for (const result of state.results.values()) {
      const policyValue = structuredClone(result) as import('../core/types.js').ResultRecord
      delete policyValue.storageState
      delete policyValue.pinCount
      const stored = target.put('result', `result:${result.id}`, policyValue as unknown as JsonValue)
      residency.set(result.id, { storageState: stored.storageState === 'memory' ? 'memory' : 'persisted', pinCount: stored.pinCount })
    }
    for (const artifact of state.artifacts.values()) target.put('artifact', `artifact:${artifact.ref}`, artifact as unknown as JsonValue)
    for (const event of state.events) target.put('event', `event:${event.id}`, event as unknown as JsonValue)
    for (const lane of state.lanes.values()) if (lane.pendingResumeInput) target.put('snapshot', `snapshot:resume:${lane.id}:${lane.version}`, lane.pendingResumeInput as unknown as JsonValue)
    const factKeys = new Set(factInbox.snapshot().queue.map((envelope) => `snapshot:fact:${envelope.eventId}`))
    for (const envelope of factInbox.snapshot().queue) target.put('snapshot', `snapshot:fact:${envelope.eventId}`, envelope as unknown as JsonValue)
    for (const record of target.inspect()) if (record.key.startsWith('snapshot:fact:') && !factKeys.has(record.key)) target.remove(record.key)
    if (transactional) {
      policy.replaceSnapshot(target.snapshot())
      for (const [id, value] of residency) {
        const result = state.results.get(id)
        if (result) Object.assign(result, value)
      }
    } else {
      for (const [id, value] of residency) {
        const result = state.results.get(id)
        if (result) Object.assign(result, value)
      }
    }
    if (transactional && this.sessionStore) for (const agent of state.agents.values()) this.sessionStore.put(exportWarmStartSession(state, agent.id))
  }

  private hasPendingHostInteraction(agentId?: string): boolean { return [...this.state.effects.values()].some((effect) => effect.kind === 'human' && !effect.outcome && (agentId === undefined || effect.agentId === agentId)) }
  private waitForFact(): Promise<void> { return new Promise((resolve) => this.factWaiters.push(resolve)) }
  private completeFinishedChildAgents(): void {
    for (const effect of this.state.effects.values()) {
      if (effect.kind !== 'agent' || !effect.childAgentId || effect.outcome) continue
      const child = this.state.agents.get(effect.childAgentId)
      const root = child ? this.state.lanes.get(child.rootLaneId) : undefined
      if (!child || !root || !['succeeded', 'failed', 'cancelled'].includes(root.status)) continue
      const status = root.status === 'succeeded' ? 'succeeded' : root.status === 'cancelled' ? 'cancelled' : 'failed'
      const nextChild = structuredClone(child)
      nextChild.state = status
      this.completeEffect(effect.id, { value: { agentId: child.id, status } }, status, status === 'failed' ? { code: 'CHILD_AGENT_FAILED', message: 'Child Agent failed.' } : undefined, [{ op: 'setAgent', agentId: child.id, record: nextChild }])
    }
  }

  completeEffect(effectId: string, execution: EffectExecution, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', error?: RuntimeError, additionalMutations: Mutation[] = []): boolean {
    const storedEffect = this.state.effects.get(effectId)
    if (!storedEffect) return false
    if (storedEffect.outcome) { this.tryEmit({ type: 'attempt.late_emit', effectId, data: { status: storedEffect.outcome.status } }); return false }
    const effect = structuredClone(storedEffect)
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    if (execution.executionState === 'remote_unknown') { this.markRemoteUnknown(effectId, execution.sideEffectState ?? 'none'); return false }
    let effectiveExecution = execution
    let outputError = error ?? execution.error
    let resultDerivedFrom = [...(effect.derivedFrom ?? [])]
    let publishedArtifact: ArtifactRecord | undefined
    const rawInput = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    if (execution.artifact !== undefined) {
      try {
        const artifact = prepareArtifactPublication(this.state, { ...execution.artifact, laneId: effect.ownerLaneId, derivedFrom: [...(effect.derivedFrom ?? []), ...(execution.artifact.derivedFrom ?? [])] })
        publishedArtifact = artifact
        resultDerivedFrom = [...resultDerivedFrom, { kind: 'artifact', ref: artifact.ref }]
        effectiveExecution = { ...effectiveExecution, value: { artifactRef: artifact.ref }, privacy: artifact.privacy, ...(artifact.privacyTaints === undefined ? {} : { privacyTaints: artifact.privacyTaints }) }
      } catch (cause) {
        effectiveExecution = { ...effectiveExecution, status: 'failed', executionState: 'failed', error: runtimeErrorFromCause(cause, 'ARTIFACT_PUBLICATION_FAILED') }
        outputError = effectiveExecution.error
      }
    }
    const outputSchema = rawInput.outputSchema
    if ((execution.status ?? status) === 'succeeded' && effect.kind === 'llm' && outputSchema !== undefined && !validateJsonSchema(execution.value, outputSchema)) {
      effectiveExecution = { ...execution, status: 'failed', executionState: 'failed', rejectedOutput: { value: structuredClone(execution.value), ...(execution.privacy === undefined ? {} : { privacy: execution.privacy }), derivedFrom: [...(effect.derivedFrom ?? [])] } }
      outputError = { code: 'OUTPUT_SCHEMA_VIOLATION', message: 'LLM output did not satisfy the declared output schema.' }
    }
    const taintError = validatePrivacyTaints(effectiveExecution.privacyTaints) ?? validatePrivacyTaints(effectiveExecution.rejectedOutput?.privacyTaints)
    if (taintError) {
      effectiveExecution = { ...effectiveExecution, status: 'failed', executionState: 'failed', error: { code: taintError, message: 'Effect output contains invalid privacy taints.' } }
      outputError = effectiveExecution.error
    }
    const effectiveStatus = effect.cancelRequested && (effectiveExecution.status ?? status) === 'succeeded' ? 'cancelled' : (effectiveExecution.status ?? status)
    effect.state = effectiveStatus
    effect.executionState = effectiveStatus === 'succeeded' ? 'succeeded' : effectiveStatus === 'cancelled' ? 'failed' : 'failed'
    effect.sideEffectState = effectiveExecution.sideEffectState ?? 'none'
    if (effectiveExecution.executionRef !== undefined) effect.executionRef = structuredClone(effectiveExecution.executionRef)
    const attempt = effect.attempts?.at(-1)
    if (attempt) { attempt.executionState = effect.executionState; attempt.sideEffectState = effect.sideEffectState; if (effectiveExecution.executionRef !== undefined) attempt.sideEffectRef = structuredClone(effectiveExecution.executionRef); attempt.settledAt = this.state.now; if (outputError) attempt.error = outputError }
    const settledAttemptId = effect.attemptId
    if (effect.kind === 'llm' && effect.retryPolicy === undefined && effectiveStatus === 'failed') {
      const metadata = execution.metadata
      const routes = metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Array.isArray((metadata as Record<string, JsonValue>).routes) ? (metadata as Record<string, JsonValue>).routes as JsonValue[] : []
      const eligible = routes.filter((route) => route && typeof route === 'object' && !Array.isArray(route) && (route as Record<string, JsonValue>).accepted === true).length
      effect.retryPolicy = { maxAttempts: Math.max(1, eligible), initialBackoffMs: 0, maxBackoffMs: 0, jitter: false }
    }
    const attemptMetadata = execution.metadata && typeof execution.metadata === 'object' && !Array.isArray(execution.metadata) ? execution.metadata as Record<string, JsonValue> : undefined
    const selectedModel = attemptMetadata?.selected && typeof attemptMetadata.selected === 'object' && !Array.isArray(attemptMetadata.selected) ? attemptMetadata.selected as Record<string, JsonValue> : undefined
    if (attempt && typeof selectedModel?.id === 'string') attempt.modelId = selectedModel.id
    if (attempt && typeof selectedModel?.providerId === 'string') attempt.providerId = selectedModel.providerId
    if (effectiveStatus === 'failed' && this.scheduleRetry(effect, outputError)) {
      Object.assign(storedEffect, effect)
      this.releaseEffectLocks(effectId)
      this.outbox.ack(`${effect.id}:${settledAttemptId}`)
      this.refreshWaits()
      this.schedulePersistence()
      return false
    }
    let resultSequence = this.state.nextIds.result
    while (this.state.results.has(`result-${resultSequence}`)) resultSequence++
    const resultId = `result-${resultSequence}`
    const rejectedOutputId = effectiveStatus !== 'succeeded' && effectiveExecution.rejectedOutput ? resultId : undefined
    const outcome: Outcome = effectiveStatus === 'succeeded' ? { status: effectiveStatus, resultRef: resultId } : { status: effectiveStatus, ...(outputError ? { error: outputError } : {}), ...(effectiveStatus === 'cancelled' ? { reason: outputError?.message ?? outputError?.code ?? 'CANCELLED' } : {}), ...(rejectedOutputId ? { rejectedOutputRefs: [rejectedOutputId] } : {}) }
    effect.outcome = outcome
    const ownerLane = this.state.lanes.get(effect.ownerLaneId)
    const sourcePrivacy = effect.derivedFrom?.flatMap((ref) => {
      const result = provenanceRefKind(ref) === 'artifact' ? undefined : this.state.results.get(provenanceRefId(ref))
      if (result) return [effectivePrivacy(result.privacy, result.privacyTaints)]
      const source = ownerLane ? privacyMetadataForDerivedRef(this.state, ownerLane, ref) : undefined
      return source ? [effectivePrivacy(source.privacy, source.privacyTaints)] : []
    }) ?? []
    const sourceTaints = ownerLane ? privacyTaintsForDerivedRefs(this.state, ownerLane, effect.derivedFrom ?? []) : []
    const outputTaints = [...sourceTaints, ...(effectiveExecution.privacyTaints ?? [])]
    const rejectedTaints = [...sourceTaints, ...(effectiveExecution.rejectedOutput?.privacyTaints ?? [])]
    const summaryAllowed = effectiveExecution.summary === undefined || Buffer.byteLength(JSON.stringify(effectiveExecution.summary), 'utf8') <= this.state.maxResultSummaryBytes
    const result = effectiveStatus === 'succeeded' && !taintError ? { id: resultId, effectId, producer: { kind: 'effect' as const, id: effect.id }, value: effectiveExecution.value, ...resultMetadata(effectiveExecution.value), storageState: 'memory' as const, pinCount: 0, privacy: effectivePrivacy(strictestPrivacy([effectiveExecution.privacy ?? 'public', ...sourcePrivacy]), outputTaints), ...(outputTaints.length ? { privacyTaints: outputTaints } : {}), derivedFrom: resultDerivedFrom, ...(effectiveExecution.normalized === undefined ? {} : { normalized: effectiveExecution.normalized }), ...(summaryAllowed && effectiveExecution.summary !== undefined ? { summary: effectiveExecution.summary } : {}) } : rejectedOutputId && effectiveExecution.rejectedOutput && !taintError ? { id: rejectedOutputId, effectId, producer: { kind: 'effect' as const, id: effect.id }, kind: 'rejected_output' as const, value: effectiveExecution.rejectedOutput.value, ...resultMetadata(effectiveExecution.rejectedOutput.value), storageState: 'memory' as const, pinCount: 0, privacy: effectivePrivacy(strictestPrivacy([effectiveExecution.rejectedOutput.privacy ?? effectiveExecution.privacy ?? 'public', ...sourcePrivacy]), rejectedTaints), ...(rejectedTaints.length ? { privacyTaints: rejectedTaints } : {}), derivedFrom: [...(effectiveExecution.rejectedOutput.derivedFrom ?? effect.derivedFrom ?? [])] } : undefined
    let journalLane: LaneRecord | undefined
    if (ownerLane && result) {
      journalLane = structuredClone(ownerLane)
      if (journalLane.visibleResultRefs) journalLane.visibleResultRefs.add(result.id)
      else journalLane.visibleResultRefs = new Set([result.id])
      if (effect.kind === 'llm' && effectiveStatus === 'succeeded') {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        const request = input.request && typeof input.request === 'object' && !Array.isArray(input.request) ? input.request as Record<string, JsonValue> : undefined
        const contextSpec = request?.contextSpec && typeof request.contextSpec === 'object' && !Array.isArray(request.contextSpec) ? request.contextSpec as Record<string, JsonValue> : undefined
        const refs = Array.isArray(contextSpec?.resultRefs) ? contextSpec.resultRefs.filter((ref): ref is string => typeof ref === 'string') : (effect.derivedFrom ?? []).filter((ref): ref is string => typeof ref === 'string')
        const instruction = typeof contextSpec?.instruction === 'string' ? contextSpec.instruction : typeof input.instruction === 'string' ? input.instruction : typeof input.task === 'string' ? input.task : effect.key
        const selectedRefs = [...new Set(refs)]
        const resultSelection = selectedRefs.map((ref) => ({ ref, rule: 'explicit-context-result', hash: contentHash(this.state.results.get(ref)?.value ?? null) }))
        const findings = selectedRefs.filter((ref) => this.state.results.get(ref)?.kind === 'finding')
        journalLane = appendHistory(journalLane, { effectId: effect.id, instruction, resultRefs: selectedRefs, resultSelection, result: result.id, ...(findings.length ? { findings } : {}), output: structuredClone(effectiveExecution.value), privacy: result.privacy, ...(result.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(result.privacyTaints) }) })
        journalLane.visibleResultRefs!.add(result.id)
      }
    }
    let correlation: ToolCallCorrelation | undefined
    if (effect.kind === 'tool' && effect.toolCallId && result) {
      const existing = this.state.toolCallCorrelations.get(effect.toolCallId)
      if (existing) {
        correlation = { ...existing, toolEffectId: effect.id, resultRef: result.id }
      }
    }
    const publicationMutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: structuredClone(effect) }, ...additionalMutations.map((mutation) => structuredClone(mutation))]
    if (publishedArtifact) publicationMutations.push({ op: 'publishArtifact', record: structuredClone(publishedArtifact) })
    if (result) publicationMutations.push({ op: 'publishResult', record: structuredClone(result) })
    if (journalLane) publicationMutations.push({ op: 'setLane', laneId: journalLane.id, record: structuredClone(journalLane) })
    if (correlation) publicationMutations.push({ op: 'setToolCallCorrelation', record: structuredClone(correlation) })
    if (effectiveExecution.summary !== undefined && !summaryAllowed) publicationMutations.push({ op: 'appendEvent', event: { type: 'result.summary_rejected', effectId, data: { maxBytes: this.state.maxResultSummaryBytes, actualBytes: Buffer.byteLength(JSON.stringify(effectiveExecution.summary), 'utf8') } } })
    publicationMutations.push({ op: 'appendEvent', event: { type: 'effect.settled', effectId, data: outcome as unknown as JsonValue } })
    if (execution.metadata !== undefined) publicationMutations.push({ op: 'appendEvent', event: { type: 'effect.execution_metadata', effectId, data: execution.metadata } })
    try {
      this.assertStorageAdmission(publicationMutations)
    } catch (cause) {
      const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }
      effect.state = 'failed'
      effect.executionState = 'failed'
      effect.outcome = { status: 'failed', error: storageError }
      const failedAttempt = effect.attempts?.at(-1)
      if (failedAttempt) failedAttempt.error = storageError
      const failureEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.settled', effectId, data: effect.outcome as unknown as JsonValue }
      const commandAckMutations = additionalMutations.filter((mutation) => mutation.op === 'appendEvent' && mutation.event.type === 'command.applied').map((mutation) => structuredClone(mutation))
      const failureMutations: Mutation[] = [{ op: 'setEffect', effectId, record: structuredClone(effect) }, ...commandAckMutations]
      try {
        this.assertStorageAdmission([...failureMutations, { op: 'appendEvent', event: failureEvent }])
        failureMutations.push({ op: 'appendEvent', event: failureEvent })
      } catch {
        this.assertStorageAdmission(failureMutations)
      }
      commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${settledAttemptId}:storage-rejected`, failureMutations, this.state.now, this.sessionId)
      Object.assign(storedEffect, effect)
      this.state.effects.set(effectId, storedEffect)
      this.releaseEffectLocks(effectId)
      this.outbox.ack(`${effect.id}:${effect.attemptId}`)
      this.syncStoragePolicy()
      this.refreshWaits()
      this.schedulePersistence()
      return commandAckMutations.length > 0
    }
    this.releaseEffectLocks(effectId)
    this.outbox.ack(`${effect.id}:${effect.attemptId}`)
    for (const observation of effectiveExecution.observations ?? []) this.observationInbox.enqueue({ ...observation, agentId: effect.agentId, laneId: effect.ownerLaneId, timestamp: this.state.now })
    const settlementTransactionId = `effect:${effect.id}:${settledAttemptId}:settled`
    const settlementMutations = [...publicationMutations]
    commitMutationTransaction(this.state, this.mutationLog, settlementTransactionId, settlementMutations, this.state.now, this.sessionId)
    Object.assign(storedEffect, effect)
    this.state.effects.set(effectId, storedEffect)
    if (journalLane) { const liveLane = this.state.lanes.get(journalLane.id); if (liveLane) { Object.assign(liveLane, journalLane); this.state.lanes.set(journalLane.id, liveLane) } }
    this.recordBudgetMetadata(execution.metadata)
    this.syncStoragePolicy()
    this.refreshWaits()
    this.dispatchQueuedEffects()
    this.schedulePersistence()
    return true
  }

  markRemoteUnknown(effectId: string, sideEffectState: 'none' | 'applied' | 'known' | 'unknown'): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    const candidate = structuredClone(effect)
    candidate.executionState = 'remote_unknown'
    candidate.sideEffectState = sideEffectState
    const attempt = candidate.attempts?.at(-1)
    if (attempt) { attempt.executionState = 'remote_unknown'; attempt.sideEffectState = sideEffectState; attempt.settledAt = this.state.now }
    const lane = this.state.lanes.get(effect.ownerLaneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    if (sideEffectState === 'unknown') {
      candidate.state = 'reconcile_required'
      if (candidateLane) candidateLane.unresolvedEffectIds = [...new Set([...(candidateLane.unresolvedEffectIds ?? []), effectId])]
    } else {
      const unknownAttempts = candidate.attempts?.filter((item) => item.executionState === 'remote_unknown').length ?? 0
      const canRetry = candidate.duplicateExecutionPolicy === 'allow' && candidate.maxUnknownAttempts !== undefined && unknownAttempts <= candidate.maxUnknownAttempts
      if (canRetry) {
        const settledAttemptId = candidate.attemptId
        const running = this.executions.get(effectId)
        if (running) { running.controller.abort(); this.executions.delete(effectId) }
        if (this.scheduleRetry(candidate, { code: 'REMOTE_EXECUTION_UNKNOWN', message: 'Remote execution outcome is unknown.', details: { unknownAttempts } })) {
          const retried = this.state.effects.get(effectId)
          if (retried) { Object.assign(effect, retried); this.state.effects.set(effectId, effect) }
          this.releaseEffectLocks(effectId)
          this.outbox.ack(`${effect.id}:${settledAttemptId}`)
          this.refreshWaits()
          this.schedulePersistence()
          return
        }
      }
      candidate.state = 'failed'
      candidate.outcome = { status: 'failed', error: { code: 'REMOTE_UNKNOWN', message: 'Remote execution outcome is unknown but no side effect was recorded.' } }
    }
    const remoteEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.remote_unknown', effectId, data: { executionState: 'remote_unknown', sideEffectState } }
    const admission: Mutation[] = [{ op: 'setEffect', effectId, record: candidate }]
    if (candidateLane) admission.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    admission.push({ op: 'appendEvent', event: remoteEvent })
    this.assertStorageAdmission(admission)
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:remote-unknown`, admission, this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effectId, effect)
    if (candidateLane && lane) { Object.assign(lane, candidateLane); this.state.lanes.set(candidateLane.id, lane) }
    if (sideEffectState === 'unknown') this.quarantine.add(effect.id, this.state.now, 'in_doubt')
    else {
      this.releaseEffectLocks(effectId)
    }
    this.refreshWaits()
    this.schedulePersistence()
  }

  reconcileEffect(effectId: string, value: JsonValue, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return
    const safeValue = strictJsonValue(value)
    if (!['succeeded', 'failed', 'cancelled'].includes(status)) throw new Error('INVALID_RECONCILE_STATUS')
    this.quarantine.reconcile(effectId)
    this.completeEffect(effectId, { value: safeValue, sideEffectState: 'known' }, status)
  }

  async reconcileEffectWith(effectId: string, resolver: (executionRef: JsonValue | undefined, effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<{ status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: JsonValue; error?: RuntimeError }>, signal = new AbortController().signal): Promise<{ status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: JsonValue; error?: RuntimeError }> {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return { status: 'unknown', error: { code: 'RECONCILE_NOT_REQUIRED', message: 'Effect is not waiting for reconciliation.' } }
    let result: { status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: JsonValue; error?: RuntimeError }
    try { result = await resolver(effect.executionRef, effect, signal) } catch (cause) {
      return { status: 'unknown', error: runtimeErrorFromCause(cause, 'RECONCILE_FAILED') }
    }
    if (!result || typeof result !== 'object' || !['succeeded', 'failed', 'cancelled', 'unknown'].includes(result.status)) return { status: 'unknown', error: { code: 'INVALID_RECONCILE_RESULT', message: 'Reconcile resolver returned an invalid status.', retryable: false } }
    let output: JsonValue | undefined
    try { output = result.output === undefined ? undefined : strictJsonValue(result.output) } catch { return { status: 'unknown', error: { code: 'INVALID_RECONCILE_OUTPUT', message: 'Reconcile resolver returned a non-JSON output.', retryable: false } } }
    if (result.error !== undefined && (typeof result.error !== 'object' || result.error === null || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')) return { status: 'unknown', error: { code: 'INVALID_RECONCILE_ERROR', message: 'Reconcile resolver returned an invalid error.', retryable: false } }
    if (result.status === 'succeeded' || result.status === 'failed' || result.status === 'cancelled') this.reconcileEffect(effectId, output ?? null, result.status)
    return { status: result.status, ...(output === undefined ? {} : { output }), ...(result.error === undefined ? {} : { error: result.error }) }
  }

  async reconcileRegisteredEffect(effectId: string, signal = new AbortController().signal): Promise<{ status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: JsonValue; error?: RuntimeError }> {
    return this.reconcileEffectWith(effectId, async (executionRef, effect, resolverSignal) => {
      const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
      const name = input.name
      if (typeof name !== 'string') return { status: 'unknown' as const, error: { code: 'INVALID_TOOL_EFFECT_INPUT', message: 'Tool reconciliation requires a registered tool name.' } }
      if (executionRef === undefined) return { status: 'unknown' as const, error: { code: 'MISSING_TOOL_EXECUTION_REF', message: 'Tool reconciliation requires an execution reference.' } }
      try {
        const result = await this.tools.reconcileDetailed(name, executionRef, { toolCallId: effect.toolCallId ?? '', effectId: effect.id, attemptId: effect.attemptId, agentId: effect.agentId, laneId: effect.ownerLaneId, signal: resolverSignal })
        return { status: result.status, ...(result.output === undefined ? {} : { output: asJsonValue(result.output) }), ...(result.error === undefined ? {} : { error: result.error }) }
      } catch (cause) {
        const error = runtimeErrorFromCause(cause, 'TOOL_RECONCILE_FAILED')
        return { status: 'unknown' as const, error }
      }
    }, signal)
  }

  abandonEffect(effectId: string): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return
    if (!this.quarantine.has(effectId)) return
    const candidate = structuredClone(effect)
    candidate.state = 'failed'
    candidate.executionState = 'local_closed'
    candidate.sideEffectState = 'unknown'
    candidate.outcome = { status: 'failed', error: { code: 'RESOURCE_ABANDONED', message: 'Host abandoned reconciliation for an unknown side effect.' } }
    const lane = this.state.lanes.get(effect.ownerLaneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    if (candidateLane?.unresolvedEffectIds) candidateLane.unresolvedEffectIds = candidateLane.unresolvedEffectIds.filter((id) => id !== effectId)
    const abandonedEvent: import('../core/types.js').RuntimeEventInput = { type: 'resource.abandoned', effectId, data: { code: 'RESOURCE_ABANDONED' } }
    const admission: Mutation[] = [{ op: 'setEffect', effectId, record: candidate }]
    if (candidateLane) admission.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    admission.push({ op: 'appendEvent', event: abandonedEvent })
    this.assertStorageAdmission(admission)
    if (!this.quarantine.abandon(effectId)) return
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:abandoned`, admission, this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effectId, effect)
    if (candidateLane && lane) { Object.assign(lane, candidateLane); this.state.lanes.set(candidateLane.id, lane) }
    this.releaseEffectLocks(effectId)
    this.refreshWaits()
    this.schedulePersistence()
  }

  cancelEffect(effectId: string, graceMs = 0, reason = 'USER_REQUESTED', additionalMutations: Mutation[] = []): boolean {
    return this.requestEffectCancellation(effectId, reason, graceMs, additionalMutations)
  }

  publishArtifact(publication: ArtifactPublication): import('../core/types.js').ArtifactRecord {
    const record = prepareArtifactPublication(this.state, publication)
    this.assertStorageAdmission([{ op: 'publishArtifact', record }])
    commitMutationTransaction(this.state, this.mutationLog, `artifact:${record.ref}`, [{ op: 'publishArtifact', record }], this.state.now, this.sessionId)
    this.syncStoragePolicy()
    this.schedulePersistence()
    return record
  }

  publishFinding(publication: FindingPublication): import('../core/types.js').FindingRecord {
    const record = prepareFindingPublication(this.state, publication)
    this.assertStorageAdmission([{ op: 'publishFinding', record }])
    commitMutationTransaction(this.state, this.mutationLog, `finding:${record.id}`, [{ op: 'publishFinding', record }], this.state.now, this.sessionId)
    this.syncStoragePolicy()
    this.schedulePersistence()
    return record
  }

  readArtifact(ref: string): Uint8Array { return readArtifact(this.state, ref) }
  pinArtifact(ref: string): void { pinArtifact(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }
  unpinArtifact(ref: string): void { unpinArtifact(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }
  markArtifactPersisted(ref: string): void { markArtifactPersisted(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }

  cancelAgent(agentId: string, reason = 'USER_REQUESTED', additionalMutations: Mutation[] = [], commandTransactionId?: string): boolean {
    const agent = this.state.agents.get(agentId)
    if (!agent || ['succeeded', 'failed', 'cancelled'].includes(agent.state ?? '')) return false
    const targetAgentIds: string[] = []
    const collect = (currentAgentId: string): void => {
      if (targetAgentIds.includes(currentAgentId)) return
      const current = this.state.agents.get(currentAgentId)
      if (!current || current.detached === true || ['succeeded', 'failed', 'cancelled'].includes(current.state ?? '')) return
      targetAgentIds.push(currentAgentId)
      for (const effect of this.state.effects.values()) if (effect.agentId === currentAgentId && effect.childAgentId !== undefined) collect(effect.childAgentId)
    }
    collect(agentId)
    const targetAgentSet = new Set(targetAgentIds)
    const targetLanes = [...this.state.lanes.values()].filter((lane) => targetAgentSet.has(lane.agentId) && !['succeeded', 'failed', 'cancelled'].includes(lane.status))
    const targetEffects = [...this.state.effects.values()].filter((effect) => targetAgentSet.has(effect.agentId) && !effect.outcome)
    const cancellableEffects = targetEffects.filter((effect) => effect.childAgentId === undefined || this.state.agents.get(effect.childAgentId)?.detached !== true)
    const cancellationEvents: RuntimeEventInput[] = [
      ...targetAgentIds.map((targetId) => ({ type: 'agent.cancelling', agentId: targetId, data: reason })),
      ...targetLanes.map((lane) => ({ type: 'lane.cancelling', laneId: lane.id, data: reason })),
      ...cancellableEffects.map((effect) => ({ type: 'effect.cancel_requested', effectId: effect.id, data: { reason } })),
      ...cancellableEffects.flatMap((effect) => {
        if (this.executions.has(effect.id) && (effect.cancelGraceMs ?? 0) === 0) {
          const state = isSideEffectful(effect.sideEffectPolicy) ? 'reconcile_required' : 'cancelled'
          return [{ type: 'effect.quarantined' as const, effectId: effect.id, data: { reason, state } }]
        }
        if (!this.executions.has(effect.id)) return [{ type: 'effect.settled', effectId: effect.id, data: { status: 'cancelled', error: { code: 'CANCELLED', message: reason } } }]
        return [] as RuntimeEventInput[]
      }),
      ...targetAgentIds.map((targetId) => ({ type: 'agent.cancelled', agentId: targetId, data: reason })),
      ...targetLanes.map((lane) => ({ type: 'lane.cancelled', laneId: lane.id, data: reason })),
    ]
    const cancellationPreflight: Mutation[] = [
      ...additionalMutations.map((mutation) => structuredClone(mutation)),
      ...cancellationEvents.map((event) => ({ op: 'appendEvent' as const, event })),
      ...targetAgentIds.flatMap((targetId) => {
        const current = this.state.agents.get(targetId)
        if (!current) return []
        const candidate = structuredClone(current)
        candidate.state = 'cancelling'
        return [{ op: 'setAgent' as const, agentId: targetId, record: candidate }]
      }),
      ...targetLanes.flatMap((lane) => {
        const candidate = structuredClone(lane)
        if ((lane.status === 'closing' || lane.status === 'waiting') && lane.closingResult !== undefined) candidate.pendingOutcome = { status: 'succeeded', result: structuredClone(lane.closingResult.value) }
        candidate.status = 'cancelling'
        candidate.cancelReason = reason
        candidate.version++
        candidate.unresolvedEffectIds = [...new Set([...(candidate.unresolvedEffectIds ?? []), ...cancellableEffects.filter((effect) => effect.ownerLaneId === lane.id && isSideEffectful(effect.sideEffectPolicy)).map((effect) => effect.id)])]
        return [{ op: 'setLane' as const, laneId: lane.id, record: candidate }]
      }),
      ...cancellableEffects.flatMap((effect) => {
        const candidate = structuredClone(effect)
        candidate.cancelRequested = { reason, at: this.state.now }
        if (this.executions.has(effect.id) && (effect.cancelGraceMs ?? 0) === 0) {
          candidate.executionState = 'remote_unknown'
          candidate.sideEffectState = isSideEffectful(candidate.sideEffectPolicy) ? 'unknown' : 'none'
          candidate.state = candidate.sideEffectState === 'unknown' ? 'reconcile_required' : 'cancelled'
          if (candidate.state === 'cancelled') candidate.outcome = { status: 'cancelled', reason, error: { code: reason, message: reason } }
        } else if (!this.executions.has(effect.id)) {
          candidate.state = 'cancelled'
          candidate.executionState = 'failed'
          candidate.sideEffectState = 'none'
          candidate.outcome = { status: 'cancelled', reason, error: { code: 'CANCELLED', message: reason } }
        }
        return [{ op: 'setEffect' as const, effectId: effect.id, record: candidate }]
      }),
    ]
    this.assertStorageAdmission(cancellationPreflight)
    let commandApplied = additionalMutations.length === 0
    for (const [index, targetId] of targetAgentIds.entries()) {
      const initialMutations: Mutation[] = [{ op: 'appendEvent', event: { type: 'agent.cancelling', agentId: targetId, data: reason } }]
      if (index === 0) initialMutations.push(...additionalMutations)
      const committed = this.commitAgentState(targetId, 'cancelling', index === 0 && commandTransactionId ? commandTransactionId : `agent:${targetId}:cancelling:${this.state.now}`, initialMutations)
      if (index === 0 && additionalMutations.length > 0) commandApplied = committed
    }
    for (const lane of targetLanes) {
      const nextLane = structuredClone(lane)
      if ((lane.status === 'closing' || lane.status === 'waiting') && lane.closingResult !== undefined) nextLane.pendingOutcome = { status: 'succeeded', result: structuredClone(lane.closingResult.value) }
      nextLane.status = 'cancelling'
      nextLane.cancelReason = reason
      nextLane.version++
      const event = { type: 'lane.cancelling' as const, laneId: lane.id, data: reason }
      const mutations: Mutation[] = [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }]
      this.assertStorageAdmission(mutations)
      commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:cancelling:${nextLane.version}`, mutations, this.state.now, this.sessionId)
      Object.assign(lane, nextLane)
      this.state.lanes.set(lane.id, lane)
    }
    for (const effect of targetEffects) {
      const childAgent = effect.childAgentId === undefined ? undefined : this.state.agents.get(effect.childAgentId)
      if (childAgent?.detached === true) continue
      this.requestEffectCancellation(effect.id, reason, effect.cancelGraceMs ?? 0)
    }
    this.finalizeCancellations()
    this.schedulePersistence()
    return commandApplied
  }

  private finalizeCancellations(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const lane of [...this.state.lanes.values()]) {
        if (lane.status !== 'cancelling') continue
        const wait = lane.activeWaitId === undefined ? undefined : this.state.waits.get(lane.activeWaitId)
        if (lane.pendingOutcome?.status === 'succeeded' && wait?.state === 'pending') continue
        const nextLane = structuredClone(lane)
        const mutations: Mutation[] = []
        if (wait?.state === 'pending') {
          const dependencies: Record<string, import('../core/types.js').DependencyObservation> = {}
          for (const dependency of wait.spec.dependencies) {
            const target = dependency.target as TargetRef
            const outcome = target.kind === 'lane' ? outcomeForSeriesMember(this.state, this.state.lanes.get(target.id)!, dependency.key) : this.state.effects.get(target.id)?.outcome
            dependencies[dependency.key] = outcome === undefined ? { state: 'pending', target } : { state: 'settled', target, outcome }
          }
          const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies, error: { code: 'CANCELLED', message: 'Lane cancellation interrupted the wait.' } }
          const nextWait = structuredClone(wait)
          nextWait.state = 'unsatisfied'
          nextWait.resolution = resolution
          delete nextLane.activeWaitId
          mutations.push({ op: 'setWait', waitId: wait.id, record: nextWait })
        }
        nextLane.status = 'cancelled'
        nextLane.cancelReason = nextLane.cancelReason ?? 'USER_REQUESTED'
        nextLane.version++
        mutations.push({ op: 'setLane', laneId: nextLane.id, record: nextLane }, { op: 'appendEvent', event: { type: 'lane.cancelled', laneId: nextLane.id, data: nextLane.cancelReason } })
        this.assertStorageAdmission(mutations)
        commitMutationTransaction(this.state, this.mutationLog, `lane:${nextLane.id}:cancelled:${nextLane.version}`, mutations, this.state.now, this.sessionId)
        Object.assign(lane, nextLane)
        this.state.lanes.set(lane.id, lane)
        changed = true
      }
      if (changed) this.refreshWaits()
    }
    for (const agent of [...this.state.agents.values()]) {
      if (agent.state !== 'cancelling') continue
      const lanes = [...this.state.lanes.values()].filter((lane) => lane.agentId === agent.id)
      if (lanes.some((lane) => !['succeeded', 'failed', 'cancelled'].includes(lane.status))) continue
      const effects = [...this.state.effects.values()].filter((effect) => effect.agentId === agent.id)
      if (effects.some((effect) => !effect.outcome && !['cancelled', 'reconcile_required', 'succeeded', 'failed'].includes(effect.state))) continue
      const root = this.state.lanes.get(agent.rootLaneId)
      const finalState = root?.status === 'succeeded' && root.cancelReason !== undefined ? 'succeeded' : root?.status === 'failed' && root.cancelReason === undefined ? 'failed' : 'cancelled'
      this.commitAgentState(agent.id, finalState, `agent:${agent.id}:${finalState}:${this.state.now}`, [{ op: 'appendEvent', event: { type: `agent.${finalState}`, agentId: agent.id, data: root?.cancelReason ?? 'USER_REQUESTED' } }])
    }
  }

  explain(laneId?: string): JsonValue {
    const readyItems = this.ready.snapshot(this.state.now)
    const lastEvent = (kind: 'lane' | 'effect', id: string): number | null => { const matching = this.state.events.filter((event) => (kind === 'lane' ? event.laneId === id : event.effectId === id)); return matching.at(-1)?.seq ?? null }
    const latestEffectMetadata = (effectId: string): JsonValue | null => { const event = [...this.state.events].reverse().find((candidate) => candidate.type === 'effect.execution_metadata' && candidate.effectId === effectId); return event?.data ?? event?.payload ?? null }
    const lanes = [...this.state.lanes.values()].filter((lane) => laneId === undefined || lane.id === laneId).map((lane) => {
      const ready = readyItems.find((item) => item.laneId === lane.id)
      const blockedBy = lane.activeWaitId ? `wait:${lane.activeWaitId}` : [...lane.ownedEffectIds].some((effectId) => this.lockBlocked.has(effectId)) ? 'resource_lock' : null
      return { id: lane.id, agentId: lane.agentId, status: lane.status, cancelReason: lane.cancelReason ?? null, failure: lane.failure?.error ?? null, goal: lane.goal, basePriority: lane.priority, effectivePriority: ready?.effectivePriority ?? lane.priority, queueWaitMs: ready ? Math.max(0, this.state.now - lane.readySince) : 0, blockedBy, activeWaitId: lane.activeWaitId ?? null, lastEventSeq: lastEvent('lane', lane.id), watchdog: lane.progressWatchdog ?? null, consecutiveControlErrors: lane.consecutiveControlErrors ?? 0, lastInterventionReason: lane.progressWatchdog?.lastReason ?? null, unresolvedEffectIds: lane.unresolvedEffectIds ?? [] }
    })
    const effects = [...this.state.effects.values()].filter((effect) => laneId === undefined || effect.ownerLaneId === laneId).map((effect) => ({ id: effect.id, state: effect.state, executionState: effect.executionState, sideEffectState: effect.sideEffectState, attemptId: effect.attemptId, inheritedFloor: effect.inheritedFloor ?? null, deadlineAt: effect.deadlineAt ?? null, lastEventSeq: lastEvent('effect', effect.id), preparation: effect.preparation ?? null, metadata: latestEffectMetadata(effect.id) }))
    return { now: this.state.now, lanes, effects, preparation: { preparing: this.preparingLLMs.size, prepared: [...this.state.effects.values()].filter((effect) => effect.state === 'queued' && effect.preparation?.state === 'prepared').length, maxPreparing: this.maxPreparingLLMs, maxPrepared: this.maxPreparedLLMs }, quarantine: this.quarantine.unresolvedEffectIds } as unknown as JsonValue
  }

  retryEffect(effectId: string, delayMs: number): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    this.scheduleRetry(effect, undefined, delayMs)
    this.schedulePersistence()
  }

  private readyRetryEffect(effectId: string, attemptId: string): void {
    const current = this.state.effects.get(effectId)
    if (!current || current.outcome || current.state !== 'retry_wait' || current.attemptId !== attemptId) return
    const ready = structuredClone(current)
    ready.state = 'queued'
    delete ready.retryAt
    const readyEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.retry_ready', effectId: current.id, data: current.attemptId }
    this.assertStorageAdmission([{ op: 'setEffect', effectId: current.id, record: ready }, { op: 'appendEvent', event: readyEvent }])
    commitMutationTransaction(this.state, this.mutationLog, `effect:${current.id}:${current.attemptId}:retry-ready`, [{ op: 'setEffect', effectId: current.id, record: ready }, { op: 'appendEvent', event: readyEvent }], this.state.now, this.sessionId)
    Object.assign(current, ready)
    delete current.retryAt
    this.state.effects.set(current.id, current)
    this.dispatchQueuedEffects()
  }

  private scheduleRetry(effect: EffectRecord, error?: RuntimeError, forcedDelayMs?: number): boolean {
    if (effect.cancelRequested || (!forcedDelayMs && !effect.retryPolicy)) return false
    if (forcedDelayMs === undefined && error?.retryable === false) return false
    if (forcedDelayMs === undefined && effect.retryPolicy) {
      if (effect.attemptNo >= effect.retryPolicy.maxAttempts) return false
      if (effect.sideEffectState === 'unknown') return false
      if (effect.sideEffectState === 'applied' && effect.duplicateExecutionPolicy !== 'allow') return false
    }
    const policy = effect.retryPolicy
    const baseDelay = forcedDelayMs ?? Math.min(policy!.maxBackoffMs, policy!.initialBackoffMs * (2 ** Math.max(0, effect.attemptNo - 1)))
    const jitter = forcedDelayMs === undefined && policy?.jitter ? Math.floor(baseDelay / 2) : 0
    const delayMs = baseDelay + jitter
    const previousAttemptId = effect.attemptId
    const candidate = structuredClone(effect)
    candidate.state = 'retry_wait'
    candidate.executionState = 'local'
    candidate.attemptNo += 1
    candidate.attemptId = `${candidate.id}-attempt-${candidate.attemptNo}`
    candidate.retryAt = this.state.now + delayMs
    if (candidate.kind === 'llm') candidate.preparation = { state: 'stale', generation: (candidate.preparation?.generation ?? 0) + 1 }
    const retryEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.retry_scheduled', effectId: effect.id, data: { previousAttemptId, nextAttemptId: candidate.attemptId, delayMs, ...(error ? { error } : {}) } as unknown as JsonValue }
    this.assertStorageAdmission([{ op: 'setEffect', effectId: effect.id, record: candidate }, { op: 'appendEvent', event: retryEvent }])
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${previousAttemptId}:retry-scheduled`, [{ op: 'setEffect', effectId: effect.id, record: candidate }, { op: 'appendEvent', event: retryEvent }], this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effect.id, effect)
    this.clock.timers.schedule(candidate.retryAt, () => this.readyRetryEffect(effect.id, candidate.attemptId))
    return true
  }

  private dispatchQueuedEffects(): void {
    if (this.persistenceBackend) {
      this.schedulePersistence()
      if (this.dispatchPersistencePending) return
      this.dispatchPersistencePending = true
      void this.flushPersistence().then(() => {
        this.dispatchPersistencePending = false
        this.dispatchQueuedEffectsNow()
      }).catch(() => {
        this.dispatchPersistencePending = false
      })
      return
    }
    this.dispatchQueuedEffectsNow()
  }

  private dispatchQueuedEffectsNow(): void {
    const queued = [...this.state.effects.values()].filter((effect) => effect.state === 'queued' && !this.executions.has(effect.id)).sort((a, b) => (Math.max(a.schedulePriority ?? 0, a.inheritedFloor ?? Number.NEGATIVE_INFINITY) - Math.max(b.schedulePriority ?? 0, b.inheritedFloor ?? Number.NEGATIVE_INFINITY)) || a.id.localeCompare(b.id))
    for (const effect of queued) {
      if (effect.state !== 'queued' || this.executions.has(effect.id)) continue
      if (effect.kind === 'llm' && !this.prepareLLMEffect(effect)) continue
      if (effect.concurrencyClass !== 'none' && this.runningCount(effect.concurrencyClass) >= this.state.maxRunning[effect.concurrencyClass]) continue
      const budgetError = this.budgetRejection(effect)
      if (budgetError) { this.completeEffect(effect.id, { value: null, executionState: 'failed', sideEffectState: 'none' }, 'failed', budgetError); continue }
      const outboxEntry = this.outbox.enqueue(effect, this.state.now)
      if (outboxEntry.state === 'claimed') continue
      if (!this.acquireEffectLocks(effect)) continue
      const running = structuredClone(effect)
      running.state = 'running'
      running.executionState = 'running'
      const attempt: import('../core/types.js').AttemptRecord = { id: effect.attemptId, effectId: effect.id, executionState: 'running', sideEffectState: effect.sideEffectState, startedAt: this.state.now }
      running.attempts = [...(running.attempts ?? []), attempt]
      const dispatchMutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: running }]
      try { this.assertStorageAdmission(dispatchMutations) } catch { this.releaseEffectLocks(effect.id); continue }
      if (!this.outbox.claim(outboxEntry.id)) { this.releaseEffectLocks(effect.id); continue }
      commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:dispatched`, dispatchMutations, this.state.now, this.sessionId)
      Object.assign(effect, running)
      this.state.effects.set(effect.id, effect)
      const controller = new AbortController()
      if (effect.kind === 'human' && !this.customExecutor) {
        this.emit({ type: 'human.requested', effectId: effect.id, data: effect.input })
        if (effect.attemptTimeoutMs !== undefined) this.clock.schedule(effect.attemptTimeoutMs, () => { if (!effect.outcome) this.completeEffect(effect.id, { value: null }, 'failed', { code: 'ATTEMPT_TIMEOUT', message: 'Human response timed out.' }) })
        if (effect.deadlineAt !== undefined) this.clock.timers.schedule(effect.deadlineAt, () => { if (!effect.outcome) this.completeEffect(effect.id, { value: null }, 'failed', { code: 'TIMEOUT', message: 'Human response deadline exceeded.' }) })
        continue
      }
      const executionRecord: { controller: AbortController; promise: Promise<void>; timeoutTimer?: string; deadlineTimer?: string; cancelTimer?: string } = { controller, promise: Promise.resolve() }
      if (effect.kind === 'timer' && !this.customExecutor) {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        const delayMs = input.delayMs
        if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) { this.completeEffect(effect.id, { value: null }, 'failed', { code: 'INVALID_TIMER', message: 'Timer Effect requires a non-negative delayMs.' }); continue }
        let resolveTimer!: () => void
        executionRecord.promise = new Promise<void>((resolve) => { resolveTimer = resolve })
        this.executions.set(effect.id, executionRecord)
        this.clock.schedule(delayMs, () => { if (!effect.outcome) this.completeEffect(effect.id, { value: { firedAt: this.clock.now() } }); resolveTimer() })
        if (effect.attemptTimeoutMs !== undefined) executionRecord.timeoutTimer = this.clock.schedule(effect.attemptTimeoutMs, () => this.expireEffect(effect.id, 'ATTEMPT_TIMEOUT'))
        if (effect.deadlineAt !== undefined) executionRecord.deadlineTimer = this.clock.timers.schedule(effect.deadlineAt, () => this.expireEffect(effect.id, 'TIMEOUT'))
        continue
      }
      if (effect.kind === 'agent' && !this.customExecutor) {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        const programId = input.programId
        const programVersion = input.programVersion
        const goal = input.goal
        const childProgram = typeof programId === 'string' && typeof programVersion === 'string' ? this.programs.get(`${programId}@${programVersion}`) : undefined
        if (!childProgram || typeof goal !== 'string') { this.completeEffect(effect.id, { value: null }, 'failed', { code: 'INVALID_AGENT_EFFECT_INPUT', message: 'Agent Effect requires a registered program and goal.' }); continue }
        const parent = this.state.agents.get(effect.agentId)
        if ((parent?.depth ?? 0) >= this.maxAgentDepth) { this.completeEffect(effect.id, { value: null }, 'failed', { code: 'MAX_AGENT_DEPTH', message: 'Child Agent depth limit exceeded.' }); continue }
        const parentLane = this.state.lanes.get(effect.ownerLaneId)
        const parentScore = parentLane === undefined ? 0 : this.ready.snapshot(this.state.now).find((item) => item.laneId === parentLane.id)?.effectivePriority ?? parentLane.priority
        const child = this.createAgent({ goal, program: childProgram, parentAgentId: effect.agentId, inheritedFloor: parentScore })
        effect.childAgentId = child.agentId
        this.emit({ type: 'agent.effect_started', effectId: effect.id, data: child.agentId })
        continue
      }
      const emitObservation: EffectObservationEmitter = (observation) => {
        const liveEffect = this.state.effects.get(effect.id)
        if (!liveEffect) return
        if (liveEffect.outcome || liveEffect.state !== 'running') {
          this.tryEmit({ type: 'attempt.late_emit', effectId: effect.id, attemptId: effect.attemptId, data: { kind: 'observation', status: liveEffect.outcome?.status ?? liveEffect.state } })
          return
        }
        this.observationInbox.enqueue({ ...observation, agentId: effect.agentId, laneId: effect.ownerLaneId, timestamp: this.state.now })
      }
      const promise = this.executor(effect, controller.signal, emitObservation).then((execution) => { this.completeEffect(effect.id, execution) }).catch((cause) => { const runtimeError = runtimeErrorFromCause(cause); this.tryEmit({ type: 'effect.dispatch_failed', effectId: effect.id, data: runtimeError as unknown as JsonValue }); this.completeEffect(effect.id, { value: null, sideEffectState: 'none' }, 'failed', runtimeError) }).finally(() => { this.executions.delete(effect.id); this.refreshWaits() })
      executionRecord.promise = promise
      if (effect.attemptTimeoutMs !== undefined) executionRecord.timeoutTimer = this.clock.schedule(effect.attemptTimeoutMs, () => this.expireEffect(effect.id, 'ATTEMPT_TIMEOUT'))
      if (effect.deadlineAt !== undefined) executionRecord.deadlineTimer = this.clock.timers.schedule(effect.deadlineAt, () => this.expireEffect(effect.id, 'TIMEOUT'))
      this.executions.set(effect.id, executionRecord)
      if (effect.kind === 'tool') {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        if (typeof input.name === 'string' && this.tools.get(input.name) !== undefined) this.executionYieldPending.add(effect.id)
      }
    }
  }

  private prepareLLMEffect(effect: EffectRecord): boolean {
    if (effect.preparation?.state === 'prepared') return true
    if (effect.preparation?.state === 'preparing') return false
    if (this.preparingLLMs.size >= this.maxPreparingLLMs) return false
    const preparedCount = [...this.state.effects.values()].filter((candidate) => candidate.state === 'queued' && candidate.preparation?.state === 'prepared').length
    if (preparedCount >= this.maxPreparedLLMs) return false
    const generation = (effect.preparation?.generation ?? 0) + 1
    const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    const request = input.request && typeof input.request === 'object' && !Array.isArray(input.request) ? input.request as Record<string, JsonValue> : undefined
    effect.preparation = { state: 'preparing', generation, ...(typeof request?.projectionHash === 'string' ? { projectionRef: request.projectionHash } : {}) }
    this.preparingLLMs.add(effect.id)
    Promise.resolve().then(() => {
      this.preparingLLMs.delete(effect.id)
      if (effect.outcome || effect.state !== 'queued' || effect.preparation?.generation !== generation || effect.cancelRequested) {
        if (effect.preparation?.generation === generation) effect.preparation = { state: 'stale', generation }
        return
      }
      effect.preparation = { ...effect.preparation, state: 'prepared' }
      this.emit({ type: 'llm.request_prepared', effectId: effect.id, data: { generation, projectionRef: effect.preparation.projectionRef ?? null } })
      this.dispatchQueuedEffects()
      this.syncStoragePolicy()
      this.schedulePersistence()
    })
    return false
  }

  private expireEffect(effectId: string, reason: 'ATTEMPT_TIMEOUT' | 'TIMEOUT'): void {
    const effect = this.state.effects.get(effectId)
    const execution = this.executions.get(effectId)
    if (!effect || effect.outcome || !execution) return
    this.state.now = this.clock.now()
    execution.controller.abort()
    this.quarantineEffect(effectId, reason, effect.cancelGraceMs ?? 0, { type: 'limit.rejected', effectId, data: { code: reason } })
    this.schedulePersistence()
  }

  private requestEffectCancellation(effectId: string, reason: string, graceMs: number, additionalMutations: Mutation[] = []): boolean {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return false
    const cancelEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.cancel_requested', effectId, data: { reason } }
    if (this.executions.has(effectId) && graceMs === 0) {
      return this.quarantineEffect(effectId, reason, 0, cancelEvent, additionalMutations)
    }
    const admitted = structuredClone(effect)
    admitted.cancelRequested = { reason, at: this.state.now }
    const cancellationMutations: Mutation[] = [{ op: 'setEffect', effectId, record: admitted }, { op: 'appendEvent', event: cancelEvent }]
    if (this.executions.has(effectId) && graceMs > 0) cancellationMutations.push(...additionalMutations.map((mutation) => structuredClone(mutation)))
    this.assertStorageAdmission(cancellationMutations)
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:cancel-requested`, cancellationMutations, this.state.now, this.sessionId)
    Object.assign(effect, admitted)
    this.state.effects.set(effectId, effect)
    if (!this.executions.has(effectId)) return this.completeEffect(effectId, { value: null }, 'cancelled', { code: 'CANCELLED', message: reason }, additionalMutations)
    this.executions.get(effectId)!.controller.abort()
    if (graceMs === 0) this.quarantineEffect(effectId, reason, 0)
    else this.executions.get(effectId)!.cancelTimer = this.clock.schedule(graceMs, () => this.quarantineEffect(effectId, reason, 0))
    return this.executions.has(effectId) && graceMs > 0
  }

  private quarantineEffect(effectId: string, reason: string, _graceMs: number, precedingEvent?: import('../core/types.js').RuntimeEventInput, additionalMutations: Mutation[] = []): boolean {
    const effect = this.state.effects.get(effectId)
    const execution = this.executions.get(effectId)
    if (!effect || effect.outcome) return false
    const candidate = structuredClone(effect)
    if (precedingEvent?.type === 'effect.cancel_requested' || precedingEvent?.type === 'limit.rejected') candidate.cancelRequested = { reason, at: this.state.now }
    candidate.executionState = 'remote_unknown'
    candidate.sideEffectState = isSideEffectful(candidate.sideEffectPolicy) ? 'unknown' : 'none'
    candidate.state = candidate.sideEffectState === 'unknown' ? 'reconcile_required' : 'cancelled'
    if (candidate.state === 'cancelled') candidate.outcome = { status: 'cancelled', reason, error: { code: reason, message: reason } }
    const lane = this.state.lanes.get(effect.ownerLaneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    if (candidateLane) candidateLane.unresolvedEffectIds = [...new Set([...(candidateLane.unresolvedEffectIds ?? []), effectId])]
    const quarantineEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.quarantined', effectId, data: { reason, state: candidate.state } }
    const admission: Mutation[] = [{ op: 'setEffect', effectId, record: candidate }]
    if (candidateLane) admission.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    if (precedingEvent) admission.push({ op: 'appendEvent', event: precedingEvent })
    admission.push(...additionalMutations.map((mutation) => structuredClone(mutation)))
    admission.push({ op: 'appendEvent', event: quarantineEvent })
    this.assertStorageAdmission(admission)
    if (execution) { execution.controller.abort(); this.executions.delete(effectId) }
    this.releaseEffectLocks(effectId)
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:quarantined`, admission, this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effectId, effect)
    if (candidateLane && lane) { Object.assign(lane, candidateLane); this.state.lanes.set(candidateLane.id, lane) }
    this.quarantine.add(effectId, this.state.now, reason)
    this.refreshWaits()
    this.schedulePersistence()
    return true
  }

  private propagateCancelledLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'cancelled' || lane.status === 'cancelling') for (const effectId of lane.ownedEffectIds) {
      const effect = this.state.effects.get(effectId)
      const childAgent = effect?.childAgentId === undefined ? undefined : this.state.agents.get(effect.childAgentId)
      if (childAgent?.detached === true) continue
      this.requestEffectCancellation(effectId, 'LANE_CANCELLED', effect?.cancelGraceMs ?? 0)
    }
  }

  private runningCount(concurrencyClass: import('../core/types.js').ConcurrencyClass): number { return [...this.state.effects.values()].filter((effect) => effect.concurrencyClass === concurrencyClass && effect.state === 'running').length }

  budgetUsage(): { attempts: number; costByCurrency: Record<string, number> } {
    return { attempts: [...this.state.effects.values()].reduce((total, effect) => total + (effect.attempts?.length ?? 0), 0), costByCurrency: Object.fromEntries(this.budgetCost.entries()) }
  }

  private budgetRejection(effect: EffectRecord): RuntimeError | undefined {
    const attempts = [...this.state.effects.values()].reduce((total, candidate) => total + (candidate.attempts?.length ?? 0), 0)
    if (this.budget.maxTotalAttempts !== undefined && attempts >= this.budget.maxTotalAttempts) return { code: 'BUDGET_EXCEEDED', message: 'Runtime attempt budget exceeded.', details: { budget: 'maxTotalAttempts', limit: this.budget.maxTotalAttempts } }
    const kindLimit = effect.kind === 'llm' ? this.budget.maxLLMAttempts : effect.kind === 'tool' ? this.budget.maxToolAttempts : undefined
    const kindAttempts = [...this.state.effects.values()].filter((candidate) => candidate.kind === effect.kind).reduce((total, candidate) => total + (candidate.attempts?.length ?? 0), 0)
    if (kindLimit !== undefined && kindAttempts >= kindLimit) return { code: 'BUDGET_EXCEEDED', message: `${effect.kind} attempt budget exceeded.`, details: { budget: effect.kind === 'llm' ? 'maxLLMAttempts' : 'maxToolAttempts', limit: kindLimit } }
    for (const [currency, limit] of Object.entries(this.budget.maxCostByCurrency ?? {})) if ((this.budgetCost.get(currency) ?? 0) >= limit) return { code: 'BUDGET_EXCEEDED', message: `Runtime cost budget exceeded for ${currency}.`, details: { budget: 'maxCostByCurrency', currency, limit } }
    return undefined
  }

  private recordBudgetMetadata(metadata: JsonValue | undefined): void {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return
    const attempts = (metadata as Record<string, JsonValue>).attempts
    if (!Array.isArray(attempts)) return
    for (const attempt of attempts) {
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) continue
      const usage = (attempt as Record<string, JsonValue>).usage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
      const cost = (usage as Record<string, JsonValue>).cost
      if (!cost || typeof cost !== 'object' || Array.isArray(cost)) continue
      const currency = (cost as Record<string, JsonValue>).currency
      const amount = (cost as Record<string, JsonValue>).amount
      if (typeof currency === 'string' && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) this.budgetCost.set(currency, (this.budgetCost.get(currency) ?? 0) + amount)
    }
  }

  private acquireEffectLocks(effect: EffectRecord): boolean {
    const specs = [...(effect.locks ?? [])].sort((a, b) => a.resource.localeCompare(b.resource) || a.mode.localeCompare(b.mode))
    const releases: Array<() => void> = []
    for (const [index, spec] of specs.entries()) {
      const release = this.resourceLocks.tryAcquire(spec.resource, spec.mode, `${effect.id}:${effect.attemptId}:${index}`)
      if (!release) {
        for (const held of releases.reverse()) held()
        if (!this.lockBlocked.has(effect.id)) {
          this.lockBlocked.add(effect.id)
          this.emit({ type: 'effect.lock_blocked', effectId: effect.id, data: { resource: spec.resource, mode: spec.mode } })
        }
        return false
      }
      releases.push(release)
    }
    if (releases.length) this.lockReleases.set(effect.id, releases)
    this.lockBlocked.delete(effect.id)
    return true
  }

  private releaseEffectLocks(effectId: string): void {
    const releases = this.lockReleases.get(effectId)
    if (!releases) return
    this.lockReleases.delete(effectId)
    for (const release of releases.reverse()) release()
  }

  private enqueueNewReadyLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'ready' && !this.ready.has(lane.id)) this.enqueueLane(lane.id)
  }

  private commitAgentState(agentId: string, state: 'created' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled', transactionId: string, additionalMutations: Mutation[] = []): boolean {
    const agent = this.state.agents.get(agentId)
    if (!agent || agent.state === state) return false
    const nextAgent = structuredClone(agent)
    nextAgent.state = state
    const mutations: Mutation[] = [{ op: 'setAgent', agentId, record: nextAgent }, ...additionalMutations.map((mutation) => structuredClone(mutation))]
    try { this.assertStorageAdmission(mutations) }
    catch (cause) { throw cause instanceof Error ? cause : new Error(String(cause)) }
    commitMutationTransaction(this.state, this.mutationLog, transactionId, mutations, this.state.now, this.sessionId)
    this.schedulePersistence()
    return true
  }

  private commitLaneControlInput(lane: LaneRecord, input: ResumeInput, event: import('../core/types.js').RuntimeEventInput, patch: Partial<LaneRecord> = {}): boolean {
    const nextLane = structuredClone(lane)
    nextLane.pendingResumeInput = structuredClone(input)
    Object.assign(nextLane, structuredClone(patch))
    nextLane.version = lane.version + 1
    const mutations: Mutation[] = [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }]
    try { this.assertStorageAdmission(mutations) }
    catch (cause) {
      this.failLane(lane, { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }, patch)
      return false
    }
    commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:control-error:${nextLane.version}`, mutations, this.state.now, this.sessionId)
    Object.assign(lane, nextLane)
    this.state.lanes.set(lane.id, lane)
    this.enqueueLane(lane.id)
    this.schedulePersistence()
    return true
  }

  private failLane(lane: LaneRecord, failure: RuntimeError, patch: Partial<LaneRecord> = {}): void {
    const nextLane = structuredClone(lane)
    Object.assign(nextLane, structuredClone(patch))
    nextLane.status = 'failed'
    nextLane.failure = { error: structuredClone(failure), privacy: 'public' }
    nextLane.version++
    const event: import('../core/types.js').RuntimeEventInput = { type: 'lane.failed', laneId: lane.id, data: failure as unknown as JsonValue }
    try {
      this.assertStorageAdmission([{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }])
      commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:failed:${nextLane.version}`, [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }], this.state.now, this.sessionId)
    } catch {
      try {
        this.assertStorageAdmission([{ op: 'setLane', laneId: lane.id, record: nextLane }])
        commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:failed:${nextLane.version}`, [{ op: 'setLane', laneId: lane.id, record: nextLane }], this.state.now, this.sessionId)
      } catch { return }
    }
    this.schedulePersistence()
    this.refreshWaits()
  }

  private refreshWaits(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const wait of [...this.state.waits.values()]) {
        if (wait.state !== 'pending') continue
        const commitResolution = (nextWait: import('../core/types.js').WaitRecord, nextLane?: LaneRecord, extra: Mutation[] = []): boolean => {
          const mutations: Mutation[] = [{ op: 'setWait', waitId: nextWait.id, record: nextWait }]
          if (nextLane) mutations.push({ op: 'setLane', laneId: nextLane.id, record: nextLane })
          mutations.push(...extra)
          try { this.assertStorageAdmission(mutations) } catch { return false }
          commitMutationTransaction(this.state, this.mutationLog, `wait:${nextWait.id}:${nextWait.state}:${this.state.now}`, mutations, this.state.now, this.sessionId)
          this.cancelWaitDeadline(nextWait.id)
          if (nextLane?.status === 'ready') this.enqueueLane(nextLane.id)
          this.schedulePersistence()
          changed = true
          return true
        }
        const exposeResolutionResults = (nextLane: LaneRecord | undefined, observations: Record<string, import('../core/types.js').DependencyObservation>): void => {
          if (!nextLane) return
          const refs = Object.values(observations).flatMap((observation) => observation.state === 'pending' ? [] : [
            ...(observation.outcome?.resultRef === undefined ? [] : [observation.outcome.resultRef]),
            ...(observation.outcome?.rejectedOutputRefs ?? []),
          ])
          if (!refs.length) return
          if (nextLane.visibleResultRefs) for (const ref of refs) nextLane.visibleResultRefs.add(ref)
          else nextLane.visibleResultRefs = new Set(refs)
        }
        const observations: Record<string, import('../core/types.js').DependencyObservation> = {}
        let pending = false
        let unsatisfied: RuntimeError | undefined
        let satisfied = 0
        let ignored = 0
        let pendingCount = 0
        for (const dependency of wait.spec.dependencies) {
          const target = dependency.target as TargetRef
          const outcome = target.kind === 'lane' ? outcomeForSeriesMember(this.state, this.state.lanes.get(target.id)!, dependency.key) : this.state.effects.get(target.id)?.outcome
          if (!outcome) { observations[dependency.key] = { state: 'pending', target }; pending = true; pendingCount++; continue }
          if (outcome.status === 'cancelled' && wait.spec.onCancelled === 'ignore') { observations[dependency.key] = { state: 'ignored', target, outcome }; ignored++ }
          else if (dependency.condition === 'success' && outcome.status !== 'succeeded') { observations[dependency.key] = { state: 'settled', target, outcome }; unsatisfied = { code: 'DEPENDENCY_FAILED', message: `${dependency.key} did not succeed` } }
          else { observations[dependency.key] = { state: 'settled', target, outcome }; satisfied++ }
        }
        const required = wait.spec.mode === 'all' ? wait.spec.dependencies.length - ignored : wait.spec.mode === 'any' ? 1 : wait.spec.quorum!
        const modeSatisfied = satisfied >= required
        const impossible = wait.spec.mode === 'all' ? Boolean(unsatisfied && !pending) : satisfied + pendingCount < required
        const modeUnsatisfied = !modeSatisfied && (impossible || (!pending && satisfied < required))
        const hardFailure = wait.spec.mode === 'all' && unsatisfied !== undefined
        if ((hardFailure || modeUnsatisfied) && wait.spec.onUnsatisfied === 'fail_lane') {
          const error = unsatisfied ?? { code: 'WAIT_QUORUM_UNREACHABLE', message: 'Wait can no longer satisfy its quorum.' }
          const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies: observations, error }
          const nextWait = structuredClone(wait)
          nextWait.state = 'unsatisfied'
          nextWait.resolution = resolution
          const lane = this.state.lanes.get(wait.laneId)
          const nextLane = lane === undefined || ['succeeded', 'failed', 'cancelled'].includes(lane.status) ? undefined : structuredClone(lane)
          if (nextLane) {
            exposeResolutionResults(nextLane, observations)
            const cancelled = nextLane.status === 'cancelling'
            nextLane.status = cancelled ? 'cancelled' : 'failed'
            if (cancelled) nextLane.cancelReason = nextLane.cancelReason ?? 'USER_REQUESTED'
            else nextLane.failure = { error: structuredClone(error), privacy: 'public' }
            delete nextLane.activeWaitId
            nextLane.version++
          }
          commitResolution(nextWait, nextLane, nextLane === undefined ? [] : [{ op: 'appendEvent', event: { type: nextLane.status === 'cancelled' ? 'lane.cancelled' : 'lane.failed', laneId: nextLane.id, data: nextLane.status === 'cancelled' ? nextLane.cancelReason as unknown as JsonValue : error as unknown as JsonValue } }])
        } else if (modeUnsatisfied || (hardFailure && !pending)) {
          const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies: observations, error: unsatisfied ?? { code: 'WAIT_QUORUM_UNREACHABLE', message: 'Wait can no longer satisfy its quorum.' } }
          const nextWait = structuredClone(wait)
          nextWait.state = 'unsatisfied'
          nextWait.resolution = resolution
          const lane = this.state.lanes.get(wait.laneId)
          const nextLane = lane === undefined || ['succeeded', 'failed', 'cancelled'].includes(lane.status) ? undefined : structuredClone(lane)
          if (nextLane) {
            exposeResolutionResults(nextLane, observations)
            const cancelled = nextLane.status === 'cancelling'
            nextLane.status = cancelled ? 'cancelled' : 'ready'
            if (cancelled) nextLane.cancelReason = nextLane.cancelReason ?? 'USER_REQUESTED'
            delete nextLane.activeWaitId
            if (!cancelled) nextLane.pendingResumeInput = { type: 'wait', resolution }
          }
          commitResolution(nextWait, nextLane, nextLane?.status === 'cancelled' ? [{ op: 'appendEvent', event: { type: 'lane.cancelled', laneId: nextLane.id, data: nextLane.cancelReason ?? 'USER_REQUESTED' } }] : [])
        } else if (modeSatisfied || (!pending && !unsatisfied && wait.spec.mode === 'all')) {
          const resolution = { waitId: wait.id, status: 'satisfied' as const, dependencies: observations }
          const nextWait = structuredClone(wait)
          nextWait.state = 'satisfied'
          nextWait.resolution = resolution
          const lane = this.state.lanes.get(wait.laneId)
          const nextLane = lane === undefined || ['succeeded', 'failed', 'cancelled'].includes(lane.status) ? undefined : structuredClone(lane)
          if (nextLane) {
            exposeResolutionResults(nextLane, observations)
            if (nextLane.closingResult) {
              let resultSequence = this.state.nextIds.result
              while (this.state.results.has(`result-${resultSequence}`)) resultSequence++
              const resultId = `result-${resultSequence}`
              const result = { id: resultId, producer: { kind: 'lane' as const, id: nextLane.id }, value: nextLane.closingResult.value, ...resultMetadata(nextLane.closingResult.value), storageState: 'memory' as const, pinCount: 0, privacy: nextLane.closingResult.privacy, ...(nextLane.closingResult.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(nextLane.closingResult.privacyTaints) }), derivedFrom: [...(nextLane.closingResult.derivedFrom ?? [])] }
              delete nextLane.activeWaitId
              nextLane.status = 'succeeded'
              delete nextLane.pendingOutcome
              nextLane.resultRef = resultId
              delete nextLane.closingResult
              if (nextLane.visibleResultRefs) nextLane.visibleResultRefs.add(resultId)
              else nextLane.visibleResultRefs = new Set([resultId])
              if (!commitResolution(nextWait, nextLane, [{ op: 'publishResult', record: result }, { op: 'appendEvent', event: { type: 'lane.succeeded', laneId: nextLane.id, data: resultId } }])) {
                const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: 'Session storage limit exceeded while committing a closing Lane result.' }
                const failedWait = structuredClone(wait)
                failedWait.state = 'unsatisfied'
                failedWait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error: storageError }
                const failedLane = structuredClone(lane!)
                delete failedLane.activeWaitId
                failedLane.status = 'failed'
                failedLane.failure = { error: storageError, privacy: 'public' }
                failedLane.version++
                commitResolution(failedWait, failedLane, [{ op: 'appendEvent', event: { type: 'lane.failed', laneId: failedLane.id, data: storageError as unknown as JsonValue } }])
              }
            } else {
              delete nextLane.activeWaitId
              if (nextLane.status === 'cancelling') {
                nextLane.status = 'cancelled'
                nextLane.cancelReason = nextLane.cancelReason ?? 'USER_REQUESTED'
                commitResolution(nextWait, nextLane, [{ op: 'appendEvent', event: { type: 'lane.cancelled', laneId: nextLane.id, data: nextLane.cancelReason } }])
              } else {
                nextLane.status = 'ready'
                nextLane.pendingResumeInput = { type: 'wait', resolution }
                commitResolution(nextWait, nextLane)
              }
            }
          } else {
            commitResolution(nextWait)
          }
        }
      }
    }
    this.recomputePriorityInheritance()
  }

  private scheduleWaitDeadline(wait: import('../core/types.js').WaitRecord): void {
    if (wait.state !== 'pending' || wait.spec.deadlineAt === undefined || this.waitDeadlineTimers.has(wait.id)) return
    const timerId = this.clock.timers.schedule(wait.spec.deadlineAt, () => this.expireWait(wait.id))
    this.waitDeadlineTimers.set(wait.id, timerId)
  }

  private cancelWaitDeadline(waitId: string): void {
    const timerId = this.waitDeadlineTimers.get(waitId)
    if (timerId !== undefined) { this.clock.timers.cancel(timerId); this.waitDeadlineTimers.delete(waitId) }
  }

  private expireWait(waitId: string): void {
    const wait = this.state.waits.get(waitId)
    if (!wait || wait.state !== 'pending') return
    const observations: Record<string, import('../core/types.js').DependencyObservation> = {}
    for (const dependency of wait.spec.dependencies) {
      const target = dependency.target as TargetRef
      const outcome = target.kind === 'lane' ? outcomeForSeriesMember(this.state, this.state.lanes.get(target.id)!, dependency.key) : this.state.effects.get(target.id)?.outcome
      observations[dependency.key] = outcome === undefined ? { state: 'pending', target } : outcome.status === 'cancelled' && wait.spec.onCancelled === 'ignore' ? { state: 'ignored', target, outcome } : { state: 'settled', target, outcome }
    }
    const error: RuntimeError = { code: 'WAIT_DEADLINE_EXCEEDED', message: 'Wait deadline exceeded.', details: { deadlineAt: wait.spec.deadlineAt ?? this.state.now } }
    const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies: observations, error }
    const candidateWait = structuredClone(wait)
    candidateWait.state = 'unsatisfied'
    candidateWait.resolution = resolution
    const lane = this.state.lanes.get(wait.laneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    const events: import('../core/types.js').RuntimeEventInput[] = []
    if (candidateLane && !['succeeded', 'failed', 'cancelled'].includes(candidateLane.status)) {
      delete candidateLane.activeWaitId
      if (candidateLane.status === 'cancelling') {
        candidateLane.status = 'cancelled'
        candidateLane.cancelReason = candidateLane.cancelReason ?? 'USER_REQUESTED'
        candidateLane.version++
        events.push({ type: 'lane.cancelled', laneId: candidateLane.id, data: candidateLane.cancelReason })
      } else if (wait.spec.onUnsatisfied === 'fail_lane') {
        candidateLane.status = 'failed'
        candidateLane.version++
        events.push({ type: 'lane.failed', laneId: candidateLane.id, data: error as unknown as JsonValue })
      } else {
        candidateLane.status = 'ready'
        candidateLane.pendingResumeInput = { type: 'wait', resolution }
      }
    }
    events.push({ type: 'wait.deadline_exceeded', laneId: wait.laneId, data: { waitId: wait.id, deadlineAt: wait.spec.deadlineAt ?? this.state.now } })
    const mutations: Mutation[] = [{ op: 'setWait', waitId: wait.id, record: candidateWait }]
    if (candidateLane) mutations.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    for (const event of events) mutations.push({ op: 'appendEvent', event })
    try { this.assertStorageAdmission(mutations) } catch (cause) {
      const timerId = this.clock.timers.schedule(this.clock.now(), () => this.expireWait(waitId))
      this.waitDeadlineTimers.set(waitId, timerId)
      throw cause
    }
    this.waitDeadlineTimers.delete(waitId)
    commitMutationTransaction(this.state, this.mutationLog, `wait:${wait.id}:deadline:${wait.spec.deadlineAt ?? this.state.now}`, mutations, this.state.now, this.sessionId)
    if (candidateLane && candidateLane.status === 'ready') this.enqueueLane(candidateLane.id)
    this.refreshWaits()
  }

  private recomputePriorityInheritance(): void {
    this.priorityInheritance.clear()
    for (const effect of this.state.effects.values()) delete effect.inheritedFloor
    const childEffectsWithPendingWait = new Set<string>()
    for (const wait of this.state.waits.values()) if (wait.state === 'pending') for (const dependency of wait.spec.dependencies) if ((dependency.target as TargetRef).kind === 'effect') {
      const effect = this.state.effects.get((dependency.target as TargetRef).id)
      if (effect?.childAgentId) childEffectsWithPendingWait.add(effect.id)
    }
    for (const agent of this.state.agents.values()) {
      const root = this.state.lanes.get(agent.rootLaneId)
      const ownedAgentEffect = [...this.state.effects.values()].find((effect) => effect.childAgentId === agent.id)
      if (root && (!ownedAgentEffect || !childEffectsWithPendingWait.has(ownedAgentEffect.id))) delete root.inheritedFloor
    }
    for (const wait of this.state.waits.values()) {
      if (wait.state !== 'pending') continue
      const consumer = this.state.lanes.get(wait.laneId)
      if (!consumer) continue
      for (const dependency of wait.spec.dependencies) {
        const target = dependency.target as TargetRef
        if (target.kind === 'lane') {
          const lane = this.state.lanes.get(target.id)
          if (lane && lane.status === 'ready') { this.priorityInheritance.raise(lane.id, consumer.id, consumer.priority); const inheritedFloor = this.priorityInheritance.floor(lane.id); this.ready.enqueue({ ...readyItemFromLane(lane), ...(inheritedFloor === undefined ? {} : { inheritedFloor }) }) }
        } else {
          const effect = this.state.effects.get(target.id)
          if (effect && effect.state === 'queued') {
            this.priorityInheritance.raise(effect.id, consumer.id, consumer.priority)
            const inheritedFloor = this.priorityInheritance.floor(effect.id)
            if (inheritedFloor === undefined) delete effect.inheritedFloor
            else effect.inheritedFloor = inheritedFloor
            if (effect.childAgentId) {
              const childRoot = this.state.agents.get(effect.childAgentId)?.rootLaneId
              const childLane = childRoot === undefined ? undefined : this.state.lanes.get(childRoot)
              if (childLane && childLane.status === 'ready') { if (inheritedFloor === undefined) delete childLane.inheritedFloor; else childLane.inheritedFloor = inheritedFloor; this.ready.enqueue(readyItemFromLane(childLane)) }
            }
          }
        }
      }
    }
  }
}
