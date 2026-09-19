export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type LaneId = string
export type AgentId = string
export type EffectId = string
export type WaitId = string
export type ResultRef = string
export type ContextVersion = number
export type PrivacyLabel = 'public' | 'cloud_allowed' | 'local_only'
export type LaneStatus = 'ready' | 'running' | 'waiting' | 'closing' | 'succeeded' | 'failed' | 'cancelled'
export type EffectState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retry_wait' | 'reconcile_required'
export type ConcurrencyClass = 'llm' | 'tool' | 'agent' | 'none'
export type OutcomeStatus = 'succeeded' | 'failed' | 'cancelled'
export interface ResourceLockSpec { resource: string; mode: 'shared' | 'exclusive' }

export interface RuntimeError {
  code: string
  message: string
  details?: JsonValue
}

export interface Outcome {
  status: OutcomeStatus
  resultRef?: ResultRef
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
}

export interface LaneContext {
  version: ContextVersion
  history: HistoryRecord[]
  state: JsonValue
}

export interface ProgressWatchdogState {
  window: string[]
  noProgressCount: number
  interventionLevel: 0 | 1 | 2 | 3
  lastFingerprint?: string
  lastReason?: string
}

export interface AgentRecord {
  id: AgentId
  rootLaneId: LaneId
  goal?: string
  state?: 'created' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  policyId?: string
  limitsId?: string
  globalVersions: Map<ContextVersion, JsonValue>
  latestGlobalVersion: ContextVersion
  maxActiveLanes: number
}

export interface LaneRecord {
  id: LaneId
  agentId: AgentId
  ownerLaneId?: LaneId
  status: LaneStatus
  version: number
  goal: string
  resume: ResumePoint
  pendingResumeInput?: ResumeInput
  contextSnapshotVersion: ContextVersion
  context: LaneContext
  activeWaitId?: WaitId
  children: Set<LaneId>
  priority: number
  enqueueSeq: number
  readySince: number
  ownedEffectIds: Set<EffectId>
  closingResult?: { value: JsonValue; privacy: PrivacyLabel }
  resultRef?: ResultRef
  consecutiveControlErrors?: number
  pendingOutcome?: Outcome
  unresolvedEffectIds?: EffectId[]
  progressWatchdog?: ProgressWatchdogState
}

export interface EffectRecord {
  id: EffectId
  agentId: AgentId
  ownerLaneId: LaneId
  key: string
  kind: 'llm' | 'tool' | 'human' | 'agent' | 'timer'
  concurrencyClass: ConcurrencyClass
  input: JsonValue
  state: EffectState
  attemptId: string
  attemptNo: number
  executionState: 'local' | 'running' | 'succeeded' | 'failed' | 'remote_unknown' | 'local_closed' | 'settled'
  sideEffectState: 'none' | 'applied' | 'known' | 'unknown'
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
  outcome?: Outcome
  toolCallId?: string
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
}

export interface ResultRecord {
  id: ResultRef
  effectId?: EffectId
  value: JsonValue
  privacy: PrivacyLabel
  derivedFrom: string[]
  summary?: JsonValue
}

export interface DependencySpec {
  key: string
  target: TargetRef | LocalRef
  condition: 'success' | 'settled'
}

export interface WaitSpec {
  dependencies: DependencySpec[]
  mode: 'all'
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
  locks?: ResourceLockSpec[]
}

export interface ForkLaneSpec {
  key: string
  goal: string
  program: ResumePoint
  priority?: number
  contextVersion?: 'parent' | 'latest' | ContextVersion
  dependsOn?: Array<{ key: string; target: TargetRef | LocalRef; condition: 'success' | 'settled' }>
}

export interface RuntimeActionBase { type: string }
export interface SubmitEffectsAction extends RuntimeActionBase {
  type: 'submit_effects'
  effects: EffectSubmission[]
  wait?: { onUnsatisfied: 'fail_lane' | 'resume_with_error'; onCancelled?: 'unsatisfied' | 'ignore'; reason?: WaitSpec['reason'] }
}
export interface WaitAction extends RuntimeActionBase { type: 'wait'; spec: WaitSpec }
export interface ForkAction extends RuntimeActionBase {
  type: 'fork'
  lanes: ForkLaneSpec[]
  join?: { condition: 'success' | 'settled'; onUnsatisfied: 'fail_lane' | 'resume_with_error'; onCancelled?: 'unsatisfied' | 'ignore' }
}
export interface CancelLaneAction extends RuntimeActionBase { type: 'cancel_lane'; laneId: LaneId; reason: 'SUPERSEDED' | 'USER_REQUESTED' | 'POLICY' }
export interface ProposeCancelAction extends RuntimeActionBase { type: 'propose_cancel'; laneId: LaneId; reason: 'SUPERSEDED' | 'POLICY' }
export interface CompleteAction extends RuntimeActionBase { type: 'complete'; result: JsonValue; privacy?: PrivacyLabel; derivedFrom?: ResultRef[]; children?: 'reject_if_active' | 'cancel' | 'await' }
export interface FailAction extends RuntimeActionBase { type: 'fail'; error: RuntimeError; privacy?: PrivacyLabel; derivedFrom?: ResultRef[] }
export interface AdoptContextAction extends RuntimeActionBase { type: 'adopt_context'; version: ContextVersion | 'latest' }

export type RuntimeAction = SubmitEffectsAction | WaitAction | ForkAction | CancelLaneAction | ProposeCancelAction | CompleteAction | FailAction | AdoptContextAction

export interface ContextOp {
  op: 'set' | 'append' | 'remove' | 'compact_history'
  path?: string[]
  value?: JsonValue
  upToSeq?: number
  summary?: JsonValue
}

export interface ContextDelta {
  target: 'global' | 'lane'
  baseVersion: ContextVersion
  ops: ContextOp[]
  privacy?: PrivacyLabel
  derivedFrom?: string[]
  proposal?: boolean
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
  events: RuntimeEvent[]
  nextIds: { agent: number; lane: number; effect: number; wait: number; result: number; event: number }
  maxTotalLanes: number
  maxQueuedEffects: number
  maxRunning: Record<ConcurrencyClass, number>
}

export function createRuntimeState(maxTotalLanes = 64, options: { maxQueuedEffects?: number; maxRunning?: Partial<Record<ConcurrencyClass, number>> } = {}): RuntimeState {
  return { now: 0, agents: new Map(), lanes: new Map(), effects: new Map(), waits: new Map(), results: new Map(), events: [], nextIds: { agent: 1, lane: 1, effect: 1, wait: 1, result: 1, event: 1 }, maxTotalLanes, maxQueuedEffects: options.maxQueuedEffects ?? 256, maxRunning: { llm: 4, tool: 16, agent: 4, none: Number.POSITIVE_INFINITY, ...(options.maxRunning ?? {}) } }
}

export function privacyRank(label: PrivacyLabel): number { return label === 'public' ? 0 : label === 'cloud_allowed' ? 1 : 2 }
export function strictestPrivacy(labels: PrivacyLabel[]): PrivacyLabel { return labels.reduce<PrivacyLabel>((current, next) => privacyRank(next) > privacyRank(current) ? next : current, 'public') }
