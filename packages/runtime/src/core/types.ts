export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type LaneId = string
export type AgentId = string
export type EffectId = string
export type WaitId = string
export type ResultRef = string
export type ContextVersion = number
export type PrivacyLabel = 'public' | 'cloud_allowed' | 'local_only'
export type ForkAffinityMode = 'off' | 'advise' | 'coalesce'
export type LaneStatus = 'ready' | 'running' | 'waiting' | 'closing' | 'succeeded' | 'failed' | 'cancelled'
export type EffectState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retry_wait' | 'reconcile_required'
export type ConcurrencyClass = 'llm' | 'tool' | 'agent' | 'none'
export type OutcomeStatus = 'succeeded' | 'failed' | 'cancelled'
export interface ResourceLockSpec { resource: string; mode: 'shared' | 'exclusive' }
export interface PrivacyTaint { path: string[]; privacy: PrivacyLabel }
export interface PrivacyMetadata { privacy: PrivacyLabel; privacyTaints?: PrivacyTaint[] }

export interface RuntimeError {
  code: string
  message: string
  details?: JsonValue
}

export interface Outcome {
  status: OutcomeStatus
  resultRef?: ResultRef
  result?: JsonValue
  rejectedOutputRefs?: ResultRef[]
  error?: RuntimeError
}

export interface ResumePoint {
  programId: string
  programVersion: string
  step: string
  locals: JsonValue
}

export interface HistoryRecord {
  seq: number
  instruction: string
  resultRefs: ResultRef[]
  output: JsonValue
  privacy: PrivacyLabel
  privacyTaints?: PrivacyTaint[]
}

export interface LaneContext {
  version: ContextVersion
  history: HistoryRecord[]
  state: JsonValue
  privacy?: PrivacyLabel
  privacyTaints?: PrivacyTaint[]
}

export interface ProgressWatchdogState {
  window: string[]
  noProgressCount: number
  interventionLevel: 0 | 1 | 2 | 3
  lastFingerprint?: string
  lastReason?: string
}

export interface HistoryPressure {
  historyTokens: number
  softTokens: number
  hardTokens: number
}

export interface AgentRecord {
  id: AgentId
  rootLaneId: LaneId
  goal?: string
  state?: 'created' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  policyId?: string
  limitsId?: string
  globalVersions: Map<ContextVersion, JsonValue>
  globalPrivacy?: Map<ContextVersion, PrivacyMetadata>
  latestGlobalVersion: ContextVersion
  maxActiveLanes: number
  parentAgentId?: AgentId
  depth?: number
  detached?: boolean
}

export interface LaneRecord {
  id: LaneId
  agentId: AgentId
  ownerLaneId?: LaneId
  status: LaneStatus
  version: number
  goal: string
  resume: ResumePoint
  series?: SeriesLaneSpec
  pendingResumeInput?: ResumeInput
  contextSnapshotVersion: ContextVersion
  context: LaneContext
  visibleResultRefs?: Set<ResultRef>
  activeWaitId?: WaitId
  children: Set<LaneId>
  priority: number
  inheritedFloor?: number
  enqueueSeq: number
  readySince: number
  ownedEffectIds: Set<EffectId>
  closingResult?: { value: JsonValue; privacy: PrivacyLabel; privacyTaints?: PrivacyTaint[]; derivedFrom?: ResultRef[] }
  failure?: { error: RuntimeError; privacy: PrivacyLabel; derivedFrom?: ResultRef[] }
  resultRef?: ResultRef
  consecutiveControlErrors?: number
  pendingOutcome?: Outcome
  unresolvedEffectIds?: EffectId[]
  progressWatchdog?: ProgressWatchdogState
  historyPressure?: HistoryPressure
}

export interface EffectRecord {
  id: EffectId
  agentId: AgentId
  ownerLaneId: LaneId
  key: string
  kind: 'llm' | 'tool' | 'human' | 'agent' | 'timer'
  concurrencyClass: ConcurrencyClass
  input: JsonValue
  derivedFrom?: ResultRef[]
  state: EffectState
  attemptId: string
  attemptNo: number
  executionState: 'local' | 'running' | 'succeeded' | 'failed' | 'remote_unknown' | 'local_closed' | 'settled'
  sideEffectState: 'none' | 'applied' | 'known' | 'unknown'
  executionRef?: JsonValue
  attempts?: AttemptRecord[]
  cancelRequested?: { reason: string; at: number }
  schedulePriority?: number
  inheritedFloor?: number
  deadlineAt?: number
  cancelGraceMs?: number
  attemptTimeoutMs?: number
  idempotencyKey?: string
  sideEffectPolicy?: 'none' | 'read' | 'write'
  retryPolicy?: { maxAttempts: number; initialBackoffMs: number; maxBackoffMs: number; jitter: boolean }
  duplicateExecutionPolicy?: 'allow' | 'forbid'
  maxUnknownAttempts?: number
  retryAt?: number
  preparation?: { state: 'idle' | 'preparing' | 'prepared' | 'stale'; generation: number; projectionRef?: string }
  outcome?: Outcome
  toolCallId?: string
  llmEffectId?: EffectId
  childAgentId?: AgentId
  locks?: ResourceLockSpec[]
}

export interface AttemptRecord {
  id: string
  effectId: EffectId
  executionState: EffectRecord['executionState']
  sideEffectState: EffectRecord['sideEffectState']
  startedAt?: number
  settledAt?: number
  error?: RuntimeError
  remoteStatusRef?: JsonValue
  sideEffectRef?: JsonValue
}

export interface ResultRecord {
  id: ResultRef
  effectId?: EffectId
  kind?: 'result' | 'rejected_output'
  value?: JsonValue
  privacy: PrivacyLabel
  privacyTaints?: PrivacyTaint[]
  derivedFrom: string[]
  summary?: JsonValue
  downgrade?: {
    sourceRefs: ResultRef[]
    targetPrivacy: 'cloud_allowed'
    method: 'human_approval' | 'sanitizer'
    approvalRef?: string
    sanitizerId?: string
  }
}

export interface DependencySpec {
  key: string
  target: TargetRef | LocalRef
  condition: 'success' | 'settled'
}

export interface WaitSpec {
  dependencies: DependencySpec[]
  mode: 'all' | 'any' | 'quorum'
  quorum?: number
  onUnsatisfied: 'fail_lane' | 'resume_with_error'
  onCancelled?: 'unsatisfied' | 'ignore'
  reason: 'startup' | 'effect' | 'dependency' | 'join' | 'timer'
  deadlineAt?: number
}

export interface WaitRecord {
  id: WaitId
  laneId: LaneId
  spec: WaitSpec
  state: 'pending' | 'satisfied' | 'unsatisfied'
  resolution?: WaitResolution
}

export type TargetRef = { kind: 'lane' | 'effect'; id: string }
export type LocalRef = { local: string }

export type DependencyObservation =
  | { state: 'pending'; target: TargetRef }
  | { state: 'settled'; target: TargetRef; outcome: Outcome }
  | { state: 'ignored'; target: TargetRef; outcome: Outcome }

export interface WaitResolution {
  waitId: WaitId
  status: 'satisfied' | 'unsatisfied'
  dependencies: Record<string, DependencyObservation>
  error?: RuntimeError
}

export type ResumeInput =
  | { type: 'wait'; resolution: WaitResolution }
  | { type: 'submitted'; targets: Record<string, TargetRef> }
  | { type: 'control_error'; error: RuntimeError; original?: ResumeInput }
  | { type: 'control_proposal'; proposals: Array<{ type: 'cancel_lane'; laneId: LaneId; reason: string; fromLaneId: LaneId }> }

export interface EffectSubmission {
  key: string
  kind: EffectRecord['kind']
  concurrencyClass: ConcurrencyClass
  input: JsonValue
  derivedFrom?: ResultRef[]
  wait?: boolean
  privacy?: PrivacyLabel
  priority?: number
  deadlineAt?: number
  cancelGraceMs?: number
  attemptTimeoutMs?: number
  idempotencyKey?: string
  sideEffectPolicy?: 'none' | 'read' | 'write'
  retryPolicy?: { maxAttempts: number; initialBackoffMs: number; maxBackoffMs: number; jitter: boolean }
  duplicateExecutionPolicy?: 'allow' | 'forbid'
  maxUnknownAttempts?: number
  toolCallId?: string
  llmEffectId?: EffectId
  locks?: ResourceLockSpec[]
}

export interface ForkLaneSpec {
  key: string
  goal: string
  program: ResumePoint
  priority?: number
  contextVersion?: 'parent' | 'latest' | ContextVersion
  affinityKey?: string
  resources?: ResourceLockSpec[]
  inputResultRefs?: ResultRef[]
  toolSetId?: string
  workspacePath?: string
  dependsOn?: Array<{ key: string; target: TargetRef | LocalRef; condition: 'success' | 'settled' }>
  series?: SeriesLaneSpec
}

export interface SeriesLaneSpec {
  member: ResumePoint
  keys: string[]
  goals?: Record<string, string>
  members?: Record<string, { dependsOn: Array<{ key: string; condition: 'success' | 'settled' }> }>
  onMemberFailure?: 'continue' | 'abort'
}

export interface RuntimeActionBase { type: string }
export interface SubmitEffectsAction extends RuntimeActionBase {
  type: 'submit_effects'
  effects: EffectSubmission[]
  wait?: { onUnsatisfied: 'fail_lane' | 'resume_with_error'; onCancelled?: 'unsatisfied' | 'ignore'; reason?: WaitSpec['reason']; deadlineAt?: number }
}
export interface WaitAction extends RuntimeActionBase { type: 'wait'; spec: WaitSpec }
export interface ForkAction extends RuntimeActionBase {
  type: 'fork'
  lanes: ForkLaneSpec[]
  affinityAck?: boolean
  joinAliases?: Record<string, string>
  join?: { condition: 'success' | 'settled'; mode?: WaitSpec['mode']; quorum?: number; deadlineAt?: number; onUnsatisfied: 'fail_lane' | 'resume_with_error'; onCancelled?: 'unsatisfied' | 'ignore' }
}
export interface CancelLaneAction extends RuntimeActionBase { type: 'cancel_lane'; laneId: LaneId; reason: 'SUPERSEDED' | 'USER_REQUESTED' | 'POLICY' }
export interface ProposeCancelAction extends RuntimeActionBase { type: 'propose_cancel'; laneId: LaneId; reason: 'SUPERSEDED' | 'POLICY' }
export interface CompleteAction extends RuntimeActionBase { type: 'complete'; result: JsonValue; privacy?: PrivacyLabel; privacyTaints?: PrivacyTaint[]; derivedFrom?: ResultRef[]; children?: 'reject_if_active' | 'cancel' | 'await' }
export interface FailAction extends RuntimeActionBase { type: 'fail'; error: RuntimeError; privacy?: PrivacyLabel; derivedFrom?: ResultRef[] }
export interface AdoptContextAction extends RuntimeActionBase { type: 'adopt_context'; version: ContextVersion | 'latest' }
export interface DowngradePrivacyAction extends RuntimeActionBase {
  type: 'downgrade_privacy'
  sourceRefs: ResultRef[]
  outputRef: ResultRef
  value: JsonValue
  targetPrivacy: 'cloud_allowed'
  method: 'human_approval' | 'sanitizer'
  approvalRef?: string
  sanitizerId?: string
  summary?: JsonValue
}

export type RuntimeAction = SubmitEffectsAction | WaitAction | ForkAction | CancelLaneAction | ProposeCancelAction | CompleteAction | FailAction | AdoptContextAction | DowngradePrivacyAction

export interface ContextOp {
  op: 'set' | 'append' | 'remove' | 'compact_history'
  path?: string[]
  value?: JsonValue
  upToSeq?: number
  summary?: JsonValue
  summaryRef?: ResultRef
}

export interface ContextDelta {
  target: 'global' | 'lane'
  baseVersion: ContextVersion
  sourceLaneId?: LaneId
  ops: ContextOp[]
  privacy?: PrivacyLabel
  privacyTaints?: PrivacyTaint[]
  derivedFrom?: string[]
  proposal?: boolean
}

export interface MergeProposal {
  id: string
  agentId: AgentId
  sourceLaneId: LaneId
  baseGlobalVersion: ContextVersion
  delta: ContextDelta
  createdAt: number
}

export interface LaneStepOutput {
  contextDelta?: ContextDelta
  adoptCommittedContext?: boolean
  actions: RuntimeAction[]
  next: ResumePoint
  locals?: JsonValue
}

export interface LLMContextSpec {
  globalSnapshotVersion: ContextVersion
  laneSnapshotVersion: ContextVersion
  resultRefs: ResultRef[]
  eventIds: string[]
  toolSetId: string
  instruction: string
  privacy: PrivacyLabel
  privacyRefs: string[]
  privacyTaints?: PrivacyTaint[]
}

export interface LLMRequestProjection {
  contextSpec: LLMContextSpec
  blocks: Array<{ kind: 'system' | 'policy' | 'tools' | 'global' | 'history' | 'lane' | 'events' | 'results' | 'instruction'; content: JsonValue }>
  prefixHash: string
  projectionHash: string
  builderVersion: string
  policyVersion: string
  toolSetVersion: string
  privacy: PrivacyLabel
  privacyRefs: string[]
  privacyTaints?: PrivacyTaint[]
}

export interface RuntimeEvent {
  id: string
  schemaVersion: number
  sessionId: string
  seq: number
  timestamp: number
  type: string
  txId?: string
  agentId?: AgentId
  laneId?: LaneId
  effectId?: EffectId
  attemptId?: string
  causationId?: string
  payload: JsonValue
  data?: JsonValue
}

export interface RuntimeEventInput {
  id?: string
  schemaVersion?: number
  sessionId?: string
  type: string
  timestamp?: number
  txId?: string
  agentId?: AgentId
  laneId?: LaneId
  effectId?: EffectId
  attemptId?: string
  causationId?: string
  payload?: JsonValue
  data?: JsonValue
}

export interface RuntimeState {
  now: number
  agents: Map<AgentId, AgentRecord>
  lanes: Map<LaneId, LaneRecord>
  effects: Map<EffectId, EffectRecord>
  waits: Map<WaitId, WaitRecord>
  results: Map<ResultRef, ResultRecord>
  toolCallCorrelations: Map<string, ToolCallCorrelation>
  mergeProposals: Map<string, MergeProposal>
  events: RuntimeEvent[]
  eventsCompactedThrough?: number
  nextIds: { agent: number; lane: number; effect: number; wait: number; result: number; proposal: number; event: number }
  maxTotalLanes: number
  maxQueuedEffects: number
  maxRunning: Record<ConcurrencyClass, number>
  forkAffinity: ForkAffinityMode
  historySoftTokens: number
  historyHardTokens: number
  trustedSanitizerIds: Set<string>
}

export interface ContextSnapshotRef {
  kind: 'global' | 'lane'
  agentId?: AgentId
  laneId?: LaneId
  version: ContextVersion
}

export function globalContextRef(agentId: AgentId, version: ContextVersion): string { return `global:${agentId}:${version}` }
export function laneContextRef(laneId: LaneId, version: ContextVersion): string { return `lane:${laneId}:${version}` }

export function parseContextSnapshotRef(ref: string): ContextSnapshotRef | undefined {
  const parts = ref.split(':')
  if (parts[0] === 'global' && parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined && /^\d+$/.test(parts[2])) return { kind: 'global', agentId: parts[1], version: Number(parts[2]) }
  if (parts[0] === 'global' && parts.length === 2 && parts[1] !== undefined && /^\d+$/.test(parts[1])) return { kind: 'global', version: Number(parts[1]) }
  if (parts[0] === 'lane' && parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined && /^\d+$/.test(parts[2])) return { kind: 'lane', laneId: parts[1], version: Number(parts[2]) }
  return undefined
}

export function privacyForContextSnapshot(state: RuntimeState, lane: LaneRecord, ref: string): PrivacyMetadata | undefined {
  const parsed = parseContextSnapshotRef(ref)
  if (!parsed) return undefined
  if (parsed.kind === 'global') {
    const agent = state.agents.get(lane.agentId)
    if (!agent || (parsed.agentId !== undefined && parsed.agentId !== agent.id) || !agent.globalVersions.has(parsed.version)) return undefined
    return structuredClone(agent.globalPrivacy?.get(parsed.version) ?? { privacy: 'public' })
  }
  if (parsed.laneId !== lane.id || parsed.version !== lane.context.version) return undefined
  return { privacy: lane.context.privacy ?? 'public', ...(lane.context.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(lane.context.privacyTaints) }) }
}

export function privacyMetadataForDerivedRef(state: RuntimeState, lane: LaneRecord, ref: string): PrivacyMetadata | undefined {
  const result = state.results.get(ref)
  if (result) return { privacy: result.privacy, ...(result.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(result.privacyTaints) }) }
  return privacyForContextSnapshot(state, lane, ref)
}

export function privacyTaintsForDerivedRefs(state: RuntimeState, lane: LaneRecord, refs: readonly string[]): PrivacyTaint[] {
  const output: PrivacyTaint[] = []
  const seen = new Set<string>()
  for (const ref of refs) for (const taint of privacyMetadataForDerivedRef(state, lane, ref)?.privacyTaints ?? []) {
    const value = { path: [ref, ...taint.path], privacy: taint.privacy }
    const key = JSON.stringify(value)
    if (!seen.has(key)) { seen.add(key); output.push(value) }
  }
  return output
}

export interface ToolCallCorrelation {
  toolCallId: string
  llmEffectId: EffectId
  toolEffectId: EffectId
  resultRef?: ResultRef
}

export function createRuntimeState(maxTotalLanes = 64, options: { maxQueuedEffects?: number; maxRunning?: Partial<Record<ConcurrencyClass, number>>; forkAffinity?: ForkAffinityMode; historySoftTokens?: number; historyHardTokens?: number; trustedSanitizerIds?: Iterable<string> } = {}): RuntimeState {
  return { now: 0, agents: new Map(), lanes: new Map(), effects: new Map(), waits: new Map(), results: new Map(), toolCallCorrelations: new Map(), mergeProposals: new Map(), events: [], nextIds: { agent: 1, lane: 1, effect: 1, wait: 1, result: 1, proposal: 1, event: 1 }, maxTotalLanes, maxQueuedEffects: options.maxQueuedEffects ?? 256, maxRunning: { llm: 4, tool: 16, agent: 4, none: Number.POSITIVE_INFINITY, ...(options.maxRunning ?? {}) }, forkAffinity: options.forkAffinity ?? 'off', historySoftTokens: options.historySoftTokens ?? 8_000, historyHardTokens: options.historyHardTokens ?? 16_000, trustedSanitizerIds: new Set(options.trustedSanitizerIds ?? []) }
}

export function privacyRank(label: PrivacyLabel): number { return label === 'public' ? 0 : label === 'cloud_allowed' ? 1 : 2 }
export function strictestPrivacy(labels: PrivacyLabel[]): PrivacyLabel { return labels.reduce<PrivacyLabel>((current, next) => privacyRank(next) > privacyRank(current) ? next : current, 'public') }
export function privacyTaintPrivacy(taints: readonly PrivacyTaint[] | undefined): PrivacyLabel { return strictestPrivacy((taints ?? []).map((taint) => taint.privacy)) }
export function effectivePrivacy(base: PrivacyLabel, taints: readonly PrivacyTaint[] | undefined): PrivacyLabel { return strictestPrivacy([base, privacyTaintPrivacy(taints)]) }
export function validatePrivacyTaints(value: readonly PrivacyTaint[] | undefined): string | undefined {
  if (value === undefined) return undefined
  const paths = new Set<string>()
  for (const taint of value) {
    if (!taint || !Array.isArray(taint.path) || taint.path.length === 0 || taint.path.some((part) => typeof part !== 'string' || part.length === 0)) return 'INVALID_PRIVACY_TAINT'
    const key = JSON.stringify(taint.path)
    if (paths.has(key)) return 'DUPLICATE_PRIVACY_TAINT'
    paths.add(key)
    if (taint.privacy !== 'public' && taint.privacy !== 'cloud_allowed' && taint.privacy !== 'local_only') return 'INVALID_PRIVACY_TAINT'
  }
  return undefined
}
