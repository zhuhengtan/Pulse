import { error } from '../core/errors.js'
import { apply } from '../core/mutations.js'
import { DependencyGraph } from '../dependencies/graph.js'
import type { ValidationResult, Mutation } from '../core/mutations.js'
import { effectivePrivacy, enqueueControlProposal, privacyMetadataForDerivedRef, privacyRank, privacyTaintPrivacy, provenanceRefId, strictestPrivacy, validatePrivacyTaints } from '../core/types.js'
import type { RuntimeState, LaneStepOutput, RuntimeAction, SubmitEffectsAction, WaitSpec, TargetRef, LocalRef, LaneRecord, EffectRecord, WaitRecord, ContextDelta, JsonValue, ResumePoint, Outcome, DependencySpec, ForkAction, PrivacyLabel, HistoryRecord, ForkLaneSpec, PrivacyMetadata, PrivacyTaint, ProvenanceRef } from '../core/types.js'
import { appendRuntimeEvent } from '../core/events.js'
import { ContextBuilder, contentHash, estimateHistoryTokens, hasUnsafePathSegment, historyPressure, ownChild, stableSerialize } from '../context/builder.js'

const isLocal = (value: TargetRef | LocalRef): value is LocalRef => 'local' in value
const clone = <T>(value: T): T => structuredClone(value)
const resultMetadata = (value: JsonValue): { sizeBytes: number; contentHash: string } => ({ sizeBytes: Buffer.byteLength(stableSerialize(value), 'utf8'), contentHash: contentHash(value) })
const laneCopy = (lane: LaneRecord): LaneRecord => ({ ...lane, resume: clone(lane.resume), context: clone(lane.context), ...(lane.visibleResultRefs === undefined ? {} : { visibleResultRefs: new Set(lane.visibleResultRefs) }), children: new Set(lane.children), ownedEffectIds: new Set(lane.ownedEffectIds), ...(lane.pendingResumeInput === undefined ? {} : { pendingResumeInput: clone(lane.pendingResumeInput) }), ...(lane.pendingControlProposals === undefined ? {} : { pendingControlProposals: clone(lane.pendingControlProposals) }), ...(lane.pendingOutcome === undefined ? {} : { pendingOutcome: clone(lane.pendingOutcome) }) })
function isRuntimeJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isRuntimeJsonValue(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.values(value as Record<string, unknown>).every((item) => isRuntimeJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }

function validProvenanceRef(value: unknown): boolean {
  if (nonEmptyString(value)) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as { kind?: unknown; ref?: unknown }
  return (ref.kind === 'result' || ref.kind === 'artifact') && nonEmptyString(ref.ref)
}

function validProvenanceRefs(value: unknown): value is ProvenanceRef[] {
  return Array.isArray(value) && value.every(validProvenanceRef)
}

function validRuntimeError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return nonEmptyString(candidate.code) && typeof candidate.message === 'string' && (candidate.retryable === undefined || typeof candidate.retryable === 'boolean') && (candidate.details === undefined || isRuntimeJsonValue(candidate.details))
}

function validateContextDeltaShape(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'INVALID_CONTEXT_DELTA'
  const delta = value as Record<string, unknown>
  if (!['lane', 'global'].includes(String(delta.target)) || !Number.isInteger(delta.baseVersion) || (delta.baseVersion as number) < 0 || !Array.isArray(delta.ops)) return 'INVALID_CONTEXT_DELTA'
  if (delta.sourceLaneId !== undefined && !nonEmptyString(delta.sourceLaneId)) return 'INVALID_CONTEXT_DELTA'
  if (delta.privacy !== undefined && !['public', 'cloud_allowed', 'local_only'].includes(String(delta.privacy))) return 'INVALID_CONTEXT_DELTA'
  if (delta.proposal !== undefined && typeof delta.proposal !== 'boolean') return 'INVALID_CONTEXT_DELTA'
  if (delta.derivedFrom !== undefined && !validProvenanceRefs(delta.derivedFrom)) return 'INVALID_CONTEXT_DELTA'
  if (delta.privacyTaints !== undefined && !Array.isArray(delta.privacyTaints)) return 'INVALID_CONTEXT_DELTA'
  for (const operation of delta.ops) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return 'INVALID_CONTEXT_OP'
    const op = operation as Record<string, unknown>
    if (!['set', 'append', 'remove', 'compact_history'].includes(String(op.op))) return 'INVALID_CONTEXT_OP'
    if (op.value !== undefined && !isRuntimeJsonValue(op.value)) return 'INVALID_CONTEXT_OP'
    if (op.summary !== undefined && !isRuntimeJsonValue(op.summary)) return 'INVALID_CONTEXT_OP'
    if (op.summaryRef !== undefined && !nonEmptyString(op.summaryRef)) return 'INVALID_CONTEXT_OP'
    if (op.upToSeq !== undefined && !Number.isInteger(op.upToSeq)) return 'INVALID_CONTEXT_OP'
    if (op.op === 'compact_history') {
      if (op.path !== undefined) return 'INVALID_CONTEXT_OP'
      continue
    }
    if (!Array.isArray(op.path) || op.path.length === 0 || op.path.some((part) => !nonEmptyString(part)) || hasUnsafePathSegment(op.path)) return 'INVALID_CONTEXT_PATH'
  }
  return undefined
}

function validateControlActionShape(action: unknown): string | undefined {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return 'INVALID_ACTION'
  const value = action as Record<string, unknown>
  if (value.type === 'cancel_lane' && (!nonEmptyString(value.laneId) || !['SUPERSEDED', 'USER_REQUESTED', 'POLICY'].includes(String(value.reason)))) return 'INVALID_CANCEL_ACTION'
  if (value.type === 'propose_cancel' && (!nonEmptyString(value.laneId) || !['SUPERSEDED', 'POLICY'].includes(String(value.reason)))) return 'INVALID_CANCEL_ACTION'
  if (value.type === 'adopt_context' && !(value.version === 'latest' || (Number.isInteger(value.version) && (value.version as number) >= 0))) return 'INVALID_CONTEXT_ADOPTION'
  if (value.type === 'complete' && value.children !== undefined && !['reject_if_active', 'cancel', 'await'].includes(String(value.children))) return 'INVALID_COMPLETE'
  if (value.type === 'downgrade_privacy') {
    if (!['human_approval', 'sanitizer'].includes(String(value.method)) || value.targetPrivacy !== 'cloud_allowed' || !nonEmptyString(value.outputRef) || !Array.isArray(value.sourceRefs) || !validProvenanceRefs(value.sourceRefs) || !isRuntimeJsonValue(value.value ?? null) || (value.summary !== undefined && !isRuntimeJsonValue(value.summary))) return 'INVALID_PRIVACY_DOWNGRADE'
    if (value.approvalRef !== undefined && !nonEmptyString(value.approvalRef)) return 'INVALID_PRIVACY_DOWNGRADE'
    if (value.sanitizerId !== undefined && !nonEmptyString(value.sanitizerId)) return 'INVALID_PRIVACY_DOWNGRADE'
  }
  return undefined
}

function validateEffectSubmission(submission: unknown): string | undefined {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) return 'INVALID_EFFECT_SUBMISSION'
  const value = submission as Record<string, unknown>
  if (!nonEmptyString(value.key)) return 'INVALID_EFFECT_KEY'
  if (!['llm', 'tool', 'human', 'agent', 'timer'].includes(String(value.kind))) return 'INVALID_EFFECT_KIND'
  if (!['llm', 'tool', 'agent', 'none'].includes(String(value.concurrencyClass))) return 'INVALID_EFFECT_CONCURRENCY'
  const expectedClass: Record<string, string> = { llm: 'llm', tool: 'tool', human: 'none', agent: 'agent', timer: 'none' }
  if (expectedClass[String(value.kind)] !== value.concurrencyClass) return 'INVALID_EFFECT_CONCURRENCY'
  if (!isRuntimeJsonValue(value.input)) return 'INVALID_EFFECT_INPUT'
  if (value.derivedFrom !== undefined && (!Array.isArray(value.derivedFrom) || value.derivedFrom.some((ref) => !validProvenanceRef(ref)))) return 'INVALID_EFFECT_PROVENANCE'
  if (value.wait !== undefined && typeof value.wait !== 'boolean') return 'INVALID_EFFECT_WAIT'
  if (value.privacy !== undefined && !['public', 'cloud_allowed', 'local_only'].includes(String(value.privacy))) return 'INVALID_EFFECT_PRIVACY'
  for (const field of ['priority', 'deadlineAt', 'cancelGraceMs', 'attemptTimeoutMs']) {
    if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || (['cancelGraceMs', 'attemptTimeoutMs'].includes(field) && value[field] < 0))) return `INVALID_EFFECT_${field.toUpperCase()}`
  }
  for (const field of ['idempotencyKey', 'toolVersion', 'toolCallId', 'llmEffectId']) if (value[field] !== undefined && !nonEmptyString(value[field])) return `INVALID_EFFECT_${field.toUpperCase()}`
  if (value.sideEffectPolicy !== undefined && !['none', 'read', 'write', 'external'].includes(String(value.sideEffectPolicy))) return 'INVALID_EFFECT_SIDE_EFFECT_POLICY'
  if (value.duplicateExecutionPolicy !== undefined && !['allow', 'forbid'].includes(String(value.duplicateExecutionPolicy))) return 'INVALID_EFFECT_DUPLICATE_POLICY'
  if (value.maxUnknownAttempts !== undefined && (!Number.isInteger(value.maxUnknownAttempts) || (value.maxUnknownAttempts as number) < 0)) return 'INVALID_EFFECT_UNKNOWN_ATTEMPTS'
  if (value.retryPolicy !== undefined) {
    if (!value.retryPolicy || typeof value.retryPolicy !== 'object' || Array.isArray(value.retryPolicy)) return 'INVALID_EFFECT_RETRY_POLICY'
    const retry = value.retryPolicy as Record<string, unknown>
    if (!Number.isInteger(retry.maxAttempts) || (retry.maxAttempts as number) < 1 || typeof retry.jitter !== 'boolean' || typeof retry.initialBackoffMs !== 'number' || !Number.isFinite(retry.initialBackoffMs) || retry.initialBackoffMs < 0 || typeof retry.maxBackoffMs !== 'number' || !Number.isFinite(retry.maxBackoffMs) || retry.maxBackoffMs < retry.initialBackoffMs) return 'INVALID_EFFECT_RETRY_POLICY'
  }
  if (value.locks !== undefined) {
    if (!Array.isArray(value.locks) || value.locks.some((lock) => !lock || typeof lock !== 'object' || Array.isArray(lock) || !nonEmptyString((lock as Record<string, unknown>).resource) || !['shared', 'exclusive'].includes(String((lock as Record<string, unknown>).mode)))) return 'INVALID_EFFECT_LOCK'
  }
  return undefined
}

function mergePrivacyTaints(...groups: Array<readonly PrivacyTaint[] | undefined>): PrivacyTaint[] {
  const output: PrivacyTaint[] = []; const seen = new Set<string>()
  for (const group of groups) for (const taint of group ?? []) { const key = JSON.stringify(taint); if (!seen.has(key)) { seen.add(key); output.push(clone(taint)) } }
  return output
}

function validResume(resume: unknown): resume is ResumePoint {
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return false
  const value = resume as Record<string, unknown>
  return nonEmptyString(value.programId) && nonEmptyString(value.programVersion) && nonEmptyString(value.step) && isRuntimeJsonValue(value.locals)
}

function descendants(state: RuntimeState, ownerId: string, targetId: string): boolean {
  let current = state.lanes.get(targetId)
  while (current?.ownerLaneId) {
    if (current.ownerLaneId === ownerId) return true
    current = state.lanes.get(current.ownerLaneId)
  }
  return false
}

const LANE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Cancel a Lane together with every non-terminal descendant. Cancellation is a
 * subtree operation: without the cascade a grandchild keeps running and holding
 * its Effects/locks after its parent has been marked cancelled. Lanes that are
 * already closing with a result keep it (`cancelling` + `pendingOutcome`); all
 * others move straight to `cancelled` and the Runtime cancels their owned
 * Effects via `propagateCancelledLanes`. Returns the ids that were cancelled.
 */
function cancelLaneSubtree(state: RuntimeState, rootId: string, reason: string, mutations: Mutation[], touched: Set<string>): string[] {
  const cancelled: string[] = []
  const queue = [rootId]
  while (queue.length) {
    const laneId = queue.shift()!
    if (touched.has(laneId)) continue
    touched.add(laneId)
    const target = state.lanes.get(laneId)
    if (!target) continue
    for (const childId of target.children) queue.push(childId)
    if (LANE_TERMINAL_STATUSES.has(target.status)) continue
    const copy = laneCopy(target)
    const preserveOutcome = (target.status === 'closing' || target.status === 'waiting') && target.closingResult !== undefined
    if (preserveOutcome) copy.pendingOutcome = { status: 'succeeded', result: clone(target.closingResult!.value) }
    copy.status = preserveOutcome ? 'cancelling' : 'cancelled'
    copy.cancelReason = reason
    copy.version = target.version + 1
    mutations.push({ op: 'setLane', laneId: target.id, record: copy })
    mutations.push({ op: 'appendEvent', event: { type: preserveOutcome ? 'lane.cancelling' : 'lane.cancelled', laneId: target.id, data: reason } })
    cancelled.push(target.id)
  }
  return cancelled
}

function resolveTarget(value: TargetRef | LocalRef, locals: Map<string, TargetRef>): TargetRef | undefined {
  return isLocal(value) ? locals.get(value.local) : value
}

function targetOutcome(state: RuntimeState, target: TargetRef): Outcome | undefined {
  if (target.kind === 'lane') return state.lanes.get(target.id)?.status === 'succeeded' ? { status: 'succeeded' } : state.lanes.get(target.id)?.status === 'failed' ? { status: 'failed' } : state.lanes.get(target.id)?.status === 'cancelled' ? { status: 'cancelled' } : undefined
  return state.effects.get(target.id)?.outcome
}

function hasDependencyCycle(state: RuntimeState, extra: Array<{ from: TargetRef; to: TargetRef; kind?: 'wait' | 'ownership' }>): boolean {
  const graph = new DependencyGraph()
  for (const wait of state.waits.values()) if (wait.state === 'pending') for (const dependency of wait.spec.dependencies) graph.add({ kind: 'lane', id: wait.laneId }, dependency.target as TargetRef)
  for (const edge of extra) graph.add(edge.from, edge.to, edge.kind ?? 'wait')
  return graph.hasCycle()
}

interface AffinityGroup { keys: string[]; signals: string[] }

function overlap<T>(left: T[], right: T[]): number {
  const a = new Set(left); const b = new Set(right)
  if (a.size === 0 && b.size === 0) return 0
  const intersection = [...a].filter((item) => b.has(item)).length
  return intersection / Math.max(1, new Set([...a, ...b]).size)
}

function affinityGroups(lanes: ForkLaneSpec[]): AffinityGroup[] {
  const groups: Array<{ keys: Set<string>; signals: Set<string> }> = []
  const join = (left: number, right: number): void => {
    if (left === right) return
    const target = groups[left]!; const source = groups[right]!
    for (const key of source.keys) target.keys.add(key)
    for (const signal of source.signals) target.signals.add(signal)
    groups.splice(right, 1)
  }
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!
    for (let j = 0; j < i; j++) {
      const other = lanes[j]!
      const signals: string[] = []
      if (lane.affinityKey && lane.affinityKey === other.affinityKey) signals.push(`affinityKey:${lane.affinityKey}`)
      const resources = (lane.resources ?? []).map((resource) => resource.resource)
      const otherResources = (other.resources ?? []).map((resource) => resource.resource)
      const resourceConflict = (lane.resources ?? []).some((resource) => (other.resources ?? []).some((candidate) => candidate.resource === resource.resource && (resource.mode === 'exclusive' || candidate.mode === 'exclusive')))
      if (resourceConflict) signals.push('exclusive_resource_overlap')
      if (overlap(resources, otherResources) > 0.5 && resources.length && otherResources.length) signals.push('shared_resource_overlap')
      if (lane.toolSetId && lane.toolSetId === other.toolSetId && lane.workspacePath && other.workspacePath && (lane.workspacePath.startsWith(other.workspacePath) || other.workspacePath.startsWith(lane.workspacePath))) signals.push('toolset_workspace_prefix')
      if (overlap(lane.inputResultRefs ?? [], other.inputResultRefs ?? []) > 0.5) signals.push('input_result_overlap')
      if (!signals.length) continue
      let left = groups.findIndex((group) => group.keys.has(other.key))
      let right = groups.findIndex((group) => group.keys.has(lane.key))
      if (left < 0) { groups.push({ keys: new Set([other.key]), signals: new Set() }); left = groups.length - 1 }
      if (right < 0) { groups.push({ keys: new Set([lane.key]), signals: new Set() }); right = groups.length - 1 }
      const group = groups[left]!
      for (const signal of signals) group.signals.add(signal)
      if (left !== right) join(left, right)
    }
  }
  return groups.filter((group) => group.keys.size > 1).map((group) => ({ keys: [...group.keys].sort(), signals: [...group.signals].sort() })).sort((a, b) => a.keys[0]!.localeCompare(b.keys[0]!))
}

function sameForkProgram(left: ForkLaneSpec, right: ForkLaneSpec): boolean {
  return left.program.programId === right.program.programId && left.program.programVersion === right.program.programVersion && left.program.step === right.program.step && JSON.stringify(left.program.locals ?? {}) === JSON.stringify(right.program.locals ?? {})
}

function seriesOrder(members: ForkLaneSpec[]): ForkLaneSpec[] | undefined {
  const byKey = new Map(members.map((lane) => [lane.key, lane]))
  const visiting = new Set<string>(); const visited = new Set<string>(); const ordered: ForkLaneSpec[] = []
  const visit = (key: string): boolean => {
    if (visited.has(key)) return true
    if (visiting.has(key)) return false
    const lane = byKey.get(key)
    if (!lane) return false
    visiting.add(key)
    for (const dependency of lane.dependsOn ?? []) if ('local' in dependency.target && byKey.has(dependency.target.local) && !visit(dependency.target.local)) return false
    visiting.delete(key); visited.add(key); ordered.push(lane)
    return true
  }
  return members.every((lane) => visit(lane.key)) ? ordered : undefined
}

function coalesceForkAction(action: ForkAction): ForkAction {
  const join = action.join
  if (!join || (join.mode ?? 'all') !== 'all' || join.condition !== 'settled') return action
  const byKey = new Map(action.lanes.map((lane) => [lane.key, lane]))
  const collapsed = new Set<string>()
  const replacements = new Map<string, string>()
  const output: ForkLaneSpec[] = []
  let groupIndex = 0
  for (const group of affinityGroups(action.lanes)) {
    const members = group.keys.map((key) => byKey.get(key)).filter((lane): lane is ForkLaneSpec => lane !== undefined)
    if (members.length !== group.keys.length || members.some((lane) => lane.series !== undefined || !sameForkProgram(lane, members[0]!))) continue
    if (members.some((lane) => (lane.dependsOn ?? []).some((dependency) => !('local' in dependency.target) || !group.keys.includes(dependency.target.local)))) continue
    const contextVersions = new Set(members.map((lane) => JSON.stringify(lane.contextVersion ?? 'parent')))
    if (contextVersions.size !== 1) continue
    const ordered = seriesOrder(members)
    if (!ordered) continue
    let key = `__series_coalesce_${groupIndex++}`
    while (byKey.has(key) || output.some((lane) => lane.key === key)) key = `${key}_x`
    const member = ordered[0]!
    const resources = new Map<string, 'shared' | 'exclusive'>()
    for (const lane of ordered) for (const resource of lane.resources ?? []) resources.set(resource.resource, resources.get(resource.resource) === 'exclusive' || resource.mode === 'exclusive' ? 'exclusive' : 'shared')
    const internalDependencies = Object.fromEntries(ordered.flatMap((lane) => {
      const dependsOn = (lane.dependsOn ?? []).filter((dependency): dependency is typeof dependency & { target: { local: string } } => 'local' in dependency.target).map((dependency) => ({ key: dependency.target.local, condition: dependency.condition }))
      return dependsOn.length ? [[lane.key, { dependsOn }]] : []
    }))
    const inputResultRefs = [...new Set(ordered.flatMap((lane) => lane.inputResultRefs ?? []))]
    const toolSetIds = new Set(ordered.map((lane) => lane.toolSetId).filter((value): value is string => value !== undefined))
    const workspacePaths = new Set(ordered.map((lane) => lane.workspacePath).filter((value): value is string => value !== undefined))
    output.push({
      key,
      goal: ordered.map((lane) => `${lane.key}: ${lane.goal}`).join('\n'),
      program: member.program,
      ...(member.priority === undefined ? {} : { priority: Math.max(...ordered.map((lane) => lane.priority ?? member.priority!)) }),
      ...(member.contextVersion === undefined ? {} : { contextVersion: member.contextVersion }),
      ...(resources.size ? { resources: [...resources].map(([resource, mode]) => ({ resource, mode })) } : {}),
      ...(inputResultRefs.length ? { inputResultRefs } : {}),
      ...(toolSetIds.size === 1 ? { toolSetId: [...toolSetIds][0] } : {}),
      ...(workspacePaths.size === 1 ? { workspacePath: [...workspacePaths][0] } : {}),
      series: { member: member.program, keys: ordered.map((lane) => lane.key), goals: Object.fromEntries(ordered.map((lane) => [lane.key, lane.goal])), ...(Object.keys(internalDependencies).length ? { members: internalDependencies } : {}), onMemberFailure: 'continue' },
    })
    for (const lane of ordered) { collapsed.add(lane.key); replacements.set(lane.key, key) }
  }
  if (replacements.size === 0) return action
  const aliases = Object.entries(action.joinAliases ?? Object.fromEntries(action.lanes.map((lane) => [lane.key, lane.key]))).map(([alias, laneKey]) => [alias, replacements.get(laneKey) ?? laneKey])
  return { ...action, lanes: [...output, ...action.lanes.filter((lane) => !collapsed.has(lane.key))], joinAliases: Object.fromEntries(aliases), affinityAck: true }
}

function validTargetRef(value: unknown): value is TargetRef | LocalRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  if (nonEmptyString(target.local)) return true
  return (target.kind === 'lane' || target.kind === 'effect') && nonEmptyString(target.id)
}

function validResourceLocks(value: unknown): boolean {
  return Array.isArray(value) && value.every((lock) => Boolean(lock && typeof lock === 'object' && !Array.isArray(lock) && nonEmptyString((lock as Record<string, unknown>).resource) && ['shared', 'exclusive'].includes(String((lock as Record<string, unknown>).mode))))
}

function validateForkActionShape(action: unknown): string | undefined {
  if (!action || typeof action !== 'object' || Array.isArray(action) || !Array.isArray((action as Record<string, unknown>).lanes)) return 'INVALID_FORK'
  const value = action as Record<string, unknown>
  const lanes = value.lanes as unknown[]
  if (lanes.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true
    const child = candidate as Record<string, unknown>
    if (!nonEmptyString(child.key) || typeof child.goal !== 'string' || !validResume(child.program)) return true
    if (child.priority !== undefined && (typeof child.priority !== 'number' || !Number.isFinite(child.priority))) return true
    if (child.contextVersion !== undefined && child.contextVersion !== 'parent' && child.contextVersion !== 'latest' && (!Number.isInteger(child.contextVersion) || (child.contextVersion as number) < 0)) return true
    if (child.affinityKey !== undefined && !nonEmptyString(child.affinityKey)) return true
    if (child.resources !== undefined && !validResourceLocks(child.resources)) return true
    if (child.inputResultRefs !== undefined && (!Array.isArray(child.inputResultRefs) || child.inputResultRefs.some((ref) => !nonEmptyString(ref)))) return true
    if (child.toolSetId !== undefined && !nonEmptyString(child.toolSetId)) return true
    if (child.workspacePath !== undefined && !nonEmptyString(child.workspacePath)) return true
    if (child.dependsOn !== undefined && (!Array.isArray(child.dependsOn) || child.dependsOn.some((dependency) => !dependency || typeof dependency !== 'object' || !nonEmptyString((dependency as Record<string, unknown>).key) || !validTargetRef((dependency as Record<string, unknown>).target) || !['success', 'settled'].includes(String((dependency as Record<string, unknown>).condition))))) return true
    if (child.series !== undefined) {
      const series = child.series as Record<string, unknown>
      if (!series || typeof series !== 'object' || Array.isArray(series) || !validResume(series.member) || !Array.isArray(series.keys) || series.keys.length === 0 || series.keys.some((key) => !nonEmptyString(key)) || new Set(series.keys).size !== series.keys.length || (series.onMemberFailure !== undefined && !['continue', 'abort'].includes(String(series.onMemberFailure)))) return true
    }
    return false
  })) return 'INVALID_FORK_LANE'
  if (value.affinityAck !== undefined && typeof value.affinityAck !== 'boolean') return 'INVALID_FORK'
  if (value.joinAliases !== undefined && (!value.joinAliases || typeof value.joinAliases !== 'object' || Array.isArray(value.joinAliases) || Object.entries(value.joinAliases as Record<string, unknown>).some(([key, laneKey]) => !nonEmptyString(key) || !nonEmptyString(laneKey)))) return 'INVALID_JOIN_ALIASES'
  if (value.join !== undefined) {
    const join = value.join as Record<string, unknown>
    if (!join || typeof join !== 'object' || Array.isArray(join) || !['success', 'settled'].includes(String(join.condition)) || (join.mode !== undefined && !['all', 'any', 'quorum'].includes(String(join.mode))) || (join.quorum !== undefined && !Number.isInteger(join.quorum)) || (join.deadlineAt !== undefined && (typeof join.deadlineAt !== 'number' || !Number.isFinite(join.deadlineAt))) || !['fail_lane', 'resume_with_error'].includes(String(join.onUnsatisfied)) || (join.onCancelled !== undefined && !['unsatisfied', 'ignore'].includes(String(join.onCancelled)))) return 'INVALID_FORK_JOIN'
  }
  return undefined
}

function validateSubmitWaitShape(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'INVALID_WAIT_DEPENDENCY'
  const wait = value as Record<string, unknown>
  if (!['fail_lane', 'resume_with_error'].includes(String(wait.onUnsatisfied)) || (wait.onCancelled !== undefined && !['unsatisfied', 'ignore'].includes(String(wait.onCancelled))) || (wait.reason !== undefined && !['startup', 'effect', 'dependency', 'join', 'timer'].includes(String(wait.reason))) || (wait.deadlineAt !== undefined && (typeof wait.deadlineAt !== 'number' || !Number.isFinite(wait.deadlineAt)))) return 'INVALID_WAIT_DEPENDENCY'
  return undefined
}

function validateWait(state: RuntimeState, laneId: string, spec: WaitSpec, locals: Map<string, TargetRef>, newTargets: Map<string, TargetRef>, allowDuplicateTargets = false): string | undefined {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Array.isArray(spec.dependencies)) return 'INVALID_WAIT_DEPENDENCY'
  if (!['all', 'any', 'quorum'].includes(spec.mode) || (spec.dependencies.length === 0 && spec.mode !== 'all') || !['fail_lane', 'resume_with_error'].includes(spec.onUnsatisfied) || (spec.onCancelled !== undefined && !['unsatisfied', 'ignore'].includes(spec.onCancelled)) || (spec.reason !== undefined && !['startup', 'effect', 'dependency', 'join', 'timer'].includes(spec.reason)) || spec.dependencies.some((dependency) => !dependency || typeof dependency !== 'object' || !nonEmptyString(dependency.key) || !validTargetRef(dependency.target) || !['success', 'settled'].includes(dependency.condition) || !resolveTarget(dependency.target, newTargets.size ? newTargets : locals))) return 'INVALID_WAIT_DEPENDENCY'
  if (spec.mode === 'quorum' && (!Number.isInteger(spec.quorum) || spec.quorum! < 1 || spec.quorum! > spec.dependencies.length)) return 'INVALID_WAIT_QUORUM'
  if (spec.mode !== 'quorum' && spec.quorum !== undefined) return 'INVALID_WAIT_QUORUM'
  if (spec.deadlineAt !== undefined && (!Number.isFinite(spec.deadlineAt) || spec.deadlineAt < state.now)) return 'INVALID_WAIT_DEADLINE'
  const keys = new Set<string>()
  const targets = new Set<string>()
  for (const dependency of spec.dependencies) {
    if (keys.has(dependency.key)) return 'DUPLICATE_WAIT_KEY'
    keys.add(dependency.key)
    const target = resolveTarget(dependency.target, newTargets.size ? newTargets : locals)!
    const targetKey = `${target.kind}:${target.id}`
    if (!allowDuplicateTargets && targets.has(targetKey)) return 'DUPLICATE_WAIT_TARGET'
    targets.add(targetKey)
    const isNewTarget = [...newTargets.values()].some((candidate) => candidate.kind === target.kind && candidate.id === target.id)
    if (target.kind === 'lane' && !state.lanes.has(target.id) && !isNewTarget) return 'UNKNOWN_TARGET'
    if (target.kind === 'effect' && !state.effects.has(target.id) && !isNewTarget) return 'UNKNOWN_TARGET'
    if (target.kind === 'lane' && target.id === laneId) return 'SELF_DEPENDENCY'
  }
  return undefined
}

function applyContextDelta(state: RuntimeState, lane: LaneRecord, delta: ContextDelta, mutations: Mutation[], proposalId?: string): { nextVersion: number; error?: string; history?: HistoryRecord[]; metadata?: PrivacyMetadata } {
  const base = delta.target === 'global' ? state.agents.get(lane.agentId)!.latestGlobalVersion : lane.context.version
  if (delta.baseVersion !== base) return { nextVersion: base, error: 'CONTEXT_VERSION_CONFLICT' }
  const paths: string[][] = []
  let history = structuredClone(lane.context.history)
  for (const op of delta.ops) {
    if (op.op === 'compact_history') {
      const upToSeq = op.upToSeq
      const summaryResult = op.summaryRef === undefined ? undefined : state.results.get(op.summaryRef)
      if (op.summaryRef !== undefined && !summaryResult) return { nextVersion: base, error: 'UNKNOWN_SUMMARY_REF' }
      if (op.summaryRef !== undefined && !resultVisible(lane, op.summaryRef)) return { nextVersion: base, error: 'RESULT_NOT_VISIBLE' }
      const summary = op.summary ?? summaryResult?.summary ?? summaryResult?.value
      if (delta.target !== 'lane' || upToSeq === undefined || summary === undefined || (op.summary === undefined && op.summaryRef === undefined) || !Number.isInteger(upToSeq) || upToSeq < 1) return { nextVersion: base, error: 'INVALID_HISTORY_COMPACTION' }
      if (!history.some((record) => record.seq <= upToSeq)) return { nextVersion: base, error: 'INVALID_HISTORY_COMPACTION' }
      if (history.length > 0 && upToSeq > Math.max(...history.map((record) => record.seq))) return { nextVersion: base, error: 'INVALID_HISTORY_COMPACTION' }
      const compacted = history.filter((record) => record.seq <= upToSeq)
      const summaryTaints = mergePrivacyTaints(...compacted.map((record) => record.privacyTaints), summaryResult?.privacyTaints)
      const summaryPrivacy = effectivePrivacy(strictestPrivacy([...(compacted.map((record) => record.privacy)), delta.privacy ?? 'public', summaryResult?.privacy ?? 'public']), summaryTaints)
      history = [{ seq: upToSeq, instruction: '[history compacted]', resultRefs: op.summaryRef === undefined ? [] : [op.summaryRef], output: clone(summary), privacy: summaryPrivacy, ...(summaryTaints.length ? { privacyTaints: summaryTaints } : {}) }, ...history.filter((record) => record.seq > upToSeq)]
      continue
    }
    if (!op.path || op.path.length === 0 || hasUnsafePathSegment(op.path)) return { nextVersion: base, error: 'INVALID_CONTEXT_PATH' }
    if (op.path?.[0] === 'history') return { nextVersion: base, error: 'HISTORY_IS_APPEND_ONLY' }
    for (const existing of paths) {
      if (op.path && (existing.every((value, index) => op.path?.[index] === value) || op.path.every((value, index) => existing[index] === value))) return { nextVersion: base, error: 'CONTEXT_PATH_CONFLICT' }
    }
    if (op.path) paths.push(op.path)
  }
  const source = delta.target === 'global' ? state.agents.get(lane.agentId)!.globalVersions.get(base) : lane.context.state
  const result = clone(source ?? {}) as JsonValue
  for (const op of delta.ops) {
    if (op.op === 'compact_history') continue
    const path = op.path!
    let cursor = result as Record<string, JsonValue>
    for (const part of path.slice(0, -1)) {
      const child = ownChild(cursor, part)
      if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[part] = {}
      cursor = cursor[part] as Record<string, JsonValue>
    }
    const key = path[path.length - 1]!
    if (op.op === 'set') cursor[key] = clone(op.value ?? null)
    else if (op.op === 'remove') delete cursor[key]
    else if (op.op === 'append') {
      const existing = ownChild(cursor, key)
      if (!Array.isArray(existing)) return { nextVersion: base, error: 'APPEND_TARGET_NOT_ARRAY' }
      existing.push(clone(op.value ?? null))
    }
  }
  const nextVersion = base + 1
  const baseMetadata = delta.target === 'global' ? state.agents.get(lane.agentId)!.globalPrivacy?.get(base) ?? { privacy: 'public' as const } : { privacy: lane.context.privacy ?? 'public', privacyTaints: lane.context.privacyTaints }
  const derived = derivedPrivacy(state, lane, delta.derivedFrom ?? [])
  const propagatedTaints = mergePrivacyTaints(baseMetadata.privacyTaints, derived.privacyTaints, delta.privacyTaints)
  const metadata: PrivacyMetadata = {
    privacy: strictestPrivacy([baseMetadata.privacy, delta.privacy ?? 'public', privacyTaintPrivacy(delta.privacyTaints), derived.privacy ?? 'public']),
    ...(propagatedTaints.length ? { privacyTaints: propagatedTaints } : {}),
  }
  if (delta.target === 'global' && delta.proposal) mutations.push({ op: 'insertMergeProposal', proposal: { id: proposalId ?? `proposal-${state.nextIds.proposal}`, agentId: lane.agentId, sourceLaneId: lane.id, baseGlobalVersion: base, delta: { ...clone(delta), sourceLaneId: lane.id }, createdAt: state.now } })
  else if (delta.target === 'global') mutations.push({ op: 'setGlobal', agentId: lane.agentId, version: nextVersion, value: result, metadata })
  else mutations.push({ op: 'setLaneContext', laneId: lane.id, version: nextVersion, value: result, metadata, ...(history.length === lane.context.history.length && history.every((record, index) => JSON.stringify(record) === JSON.stringify(lane.context.history[index])) ? {} : { history }) })
  return { nextVersion, metadata, ...(delta.target === 'lane' ? { history } : {}) }
}

function addWait(state: RuntimeState, lane: LaneRecord, spec: WaitSpec, targets: Map<string, TargetRef>, mutations: Mutation[], nextId: string): void {
  const dependencies = spec.dependencies.map((dependency) => ({ ...dependency, target: targets.get(dependency.key)! }))
  const wait: WaitRecord = { id: nextId, laneId: lane.id, spec: { ...spec, dependencies }, state: 'pending' }
  mutations.push({ op: 'insertWait', record: wait })
  lane.activeWaitId = nextId
  lane.status = 'waiting'
}

function resultVisible(lane: LaneRecord, ref: string): boolean { return lane.visibleResultRefs === undefined || lane.visibleResultRefs.has(ref) }

function derivedPrivacy(state: RuntimeState, lane: LaneRecord, refs: ProvenanceRef[]): { privacy?: PrivacyLabel; privacyTaints?: import('../core/types.js').PrivacyTaint[]; error?: string } {
  const labels: PrivacyLabel[] = []
  const privacyTaints: import('../core/types.js').PrivacyTaint[] = []
  const seenTaints = new Set<string>()
  for (const ref of refs) {
    const id = provenanceRefId(ref)
    const result = typeof ref === 'string' || ref.kind === 'result' ? state.results.get(id) : undefined
    if (result) {
      if (!resultVisible(lane, id)) return { error: 'RESULT_NOT_VISIBLE' }
    } else if (!privacyMetadataForDerivedRef(state, lane, ref)) return { error: 'UNKNOWN_RESULT_REF' }
    const metadata = privacyMetadataForDerivedRef(state, lane, ref)!
    labels.push(effectivePrivacy(metadata.privacy, metadata.privacyTaints))
    for (const taint of metadata.privacyTaints ?? []) {
      const value = { path: [id, ...taint.path], privacy: taint.privacy }
      const key = JSON.stringify(value)
      if (!seenTaints.has(key)) { seenTaints.add(key); privacyTaints.push(value) }
    }
  }
  return { privacy: strictestPrivacy(labels), ...(privacyTaints.length ? { privacyTaints } : {}) }
}

function prepareLLMInput(state: RuntimeState, lane: LaneRecord, submission: SubmitEffectsAction['effects'][number]): { input?: JsonValue; error?: string } {
  if (submission.kind !== 'llm' || !submission.input || typeof submission.input !== 'object' || Array.isArray(submission.input)) return { input: submission.input }
  const input = submission.input as Record<string, JsonValue>
  if (input.request !== undefined) return { input: submission.input }
  if (typeof input.task !== 'string') return { input: submission.input }
  const instruction = typeof input.instruction === 'string' ? input.instruction : input.task
  if (input.inputs !== undefined && (!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs))) return { error: 'INVALID_LLM_INPUTS' }
  const rawInputs = (input.inputs ?? {}) as Record<string, JsonValue>
  const readRefs = (key: string): { refs?: string[]; error?: string } => {
    const value = rawInputs[key]
    if (value === undefined) return { refs: [] }
    if (!Array.isArray(value) || value.some((ref) => typeof ref !== 'string' || ref.length === 0)) return { error: `INVALID_LLM_INPUT_REFS:${key}` }
    return { refs: value as string[] }
  }
  const resultInputs = readRefs('results')
  const findingInputs = readRefs('findings')
  const rejectedInputs = readRefs('rejectedOutputRefs')
  const artifactInputs = readRefs('artifacts')
  const eventInputs = readRefs('events')
  const inputError = resultInputs.error ?? findingInputs.error ?? rejectedInputs.error ?? artifactInputs.error ?? eventInputs.error
  if (inputError) return { error: inputError }
  const resultRefs = [...new Set([...(resultInputs.refs ?? []), ...(findingInputs.refs ?? []), ...(rejectedInputs.refs ?? [])])]
  const artifactRefs = [...new Set(artifactInputs.refs ?? [])]
  try {
    const agent = state.agents.get(lane.agentId)
    if (!agent) return { error: 'UNKNOWN_AGENT' }
    const projection = new ContextBuilder(state).build({ agent, lane, resultRefs, ...(artifactRefs.length ? { artifactRefs } : {}), eventIds: eventInputs.refs ?? [], instruction, ...(typeof input.system === 'string' ? { system: input.system } : {}), ...(input.policy === undefined ? {} : { policy: input.policy }), ...(input.tools === undefined ? {} : { tools: input.tools }), toolSetId: typeof input.toolSetId === 'string' ? input.toolSetId : 'default' })
    return { input: { ...input, request: projection as unknown as JsonValue } }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'INVALID_LLM_CONTEXT' }
  }
}

export function validateStep(state: RuntimeState, laneId: string, output: LaneStepOutput): ValidationResult {
  const lane = state.lanes.get(laneId)
  if (!lane) return { rejection: error('UNKNOWN_LANE', `Lane ${laneId} does not exist`) }
  if (!output || typeof output !== 'object' || !Array.isArray(output.actions)) return { rejection: error('INVALID_STEP_OUTPUT', 'Step output must contain an actions array') }
  if (!validResume(output.next)) return { rejection: error('INVALID_RESUME_POINT', 'next must identify a registered program step') }
  if (lane.status !== 'ready' && lane.status !== 'running') return { rejection: error('LANE_NOT_RUNNABLE', `Lane is ${lane.status}`) }
  const actions = output.actions
  const actionTypes = new Set(['submit_effects', 'fork', 'wait', 'cancel_lane', 'propose_cancel', 'adopt_context', 'downgrade_privacy', 'complete', 'fail'])
  if (actions.some((action) => !action || typeof action !== 'object' || Array.isArray(action) || !actionTypes.has(String((action as RuntimeAction).type)))) return { rejection: error('INVALID_ACTION', 'Step output contains an unknown RuntimeAction') }
  for (const action of actions) {
    const actionShapeError = validateControlActionShape(action)
    if (actionShapeError) return { rejection: error(actionShapeError, 'RuntimeAction shape is invalid') }
  }
  if (output.adoptCommittedContext !== undefined && typeof output.adoptCommittedContext !== 'boolean') return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'adoptCommittedContext must be a boolean') }
  const waitSources = actions.filter((action) => action.type === 'wait' || (action.type === 'submit_effects' && Boolean(action.wait)) || (action.type === 'fork' && Boolean(action.join))).length
  if (waitSources > 1) return { rejection: error('MULTIPLE_WAIT_SOURCES', 'a StepTransaction may have only one Wait source') }
  const terminal = actions.filter((action) => action.type === 'complete' || action.type === 'fail')
  if (terminal.length > 1) return { rejection: error('MULTIPLE_TERMINAL_ACTIONS', 'a step may have only one terminal action') }
  if (terminal.length && actions.length !== 1) return { rejection: error('AMBIGUOUS_TERMINAL_ACTION', 'terminal actions cannot be combined with other actions in MVP') }
  const mutations: Mutation[] = []
  const workingLane = laneCopy(lane)
  const localTargets = new Map<string, TargetRef>()
  const forkTargets = new Map<string, TargetRef>()
  const seenEffectKeys = new Set<string>()
  let effectCounter = state.nextIds.effect + state.effects.size
  let laneCounter = state.nextIds.lane + state.lanes.size
  let waitCounter = state.nextIds.wait + state.waits.size
  let resultCounter = state.nextIds.result + state.results.size
  let proposalCounter = state.nextIds.proposal + state.mergeProposals.size
  let queuedEffectCount = [...state.effects.values()].filter((effect) => effect.state === 'queued' && effect.concurrencyClass !== 'none').length
  const existingToolCallIds = new Set([...state.effects.values()].filter((effect) => effect.agentId === lane.agentId && effect.toolCallId !== undefined).map((effect) => effect.toolCallId!).concat([...state.toolCallCorrelations.keys()]))
  const seenToolCallIds = new Set<string>()
  const seenCancelTargets = new Set<string>()
  const cancelledSubtreeLanes = new Set<string>()

  if (output.contextDelta !== undefined) {
    const deltaShapeError = validateContextDeltaShape(output.contextDelta)
    if (deltaShapeError) return { rejection: error(deltaShapeError, 'ContextDelta shape is invalid') }
    const deltaPrivacyTaintError = validatePrivacyTaints(output.contextDelta.privacyTaints)
    if (deltaPrivacyTaintError) return { rejection: error(deltaPrivacyTaintError, 'ContextDelta privacy taints are invalid') }
    const deltaDerived = derivedPrivacy(state, lane, output.contextDelta.derivedFrom ?? [])
    if (deltaDerived.error) return { rejection: error(deltaDerived.error, 'ContextDelta provenance references an unknown or invisible result') }
    if (output.contextDelta.privacy !== undefined && deltaDerived.privacy !== undefined && privacyRank(output.contextDelta.privacy) < privacyRank(deltaDerived.privacy)) return { rejection: error('PRIVACY_DOWNGRADE_WITHOUT_PROOF', 'ContextDelta privacy cannot be broader than its sources') }
    if (output.contextDelta.target === 'global' && !output.contextDelta.proposal && lane.ownerLaneId !== undefined) return { rejection: error('GLOBAL_CONTEXT_WRITE_NOT_AUTHORIZED', 'Only the root Lane may commit Global Context directly.') }
    if (output.contextDelta.target !== 'global' && output.contextDelta.proposal) return { rejection: error('INVALID_MERGE_PROPOSAL', 'Only Global Context deltas may be proposals.') }
    const applied = applyContextDelta(state, workingLane, output.contextDelta, mutations, output.contextDelta.proposal ? `proposal-${proposalCounter++}` : undefined)
    if (applied.error) return { rejection: error(applied.error, 'ContextDelta rejected') }
    if (output.contextDelta.target === 'lane') {
      const nextValue = mutations[mutations.length - 1]
      if (nextValue?.op === 'setLaneContext') workingLane.context = { ...workingLane.context, state: nextValue.value, version: applied.nextVersion, ...(nextValue.history === undefined ? {} : { history: structuredClone(nextValue.history) }), ...(nextValue.metadata === undefined ? {} : structuredClone(nextValue.metadata)) }
    }
    if (output.adoptCommittedContext && output.contextDelta.target !== 'global') return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'adoptCommittedContext requires a global ContextDelta') }
    if (output.contextDelta.proposal && output.adoptCommittedContext) return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'proposals cannot be adopted in the same transaction') }
    if (output.contextDelta.target === 'global' && output.adoptCommittedContext) workingLane.contextSnapshotVersion = applied.nextVersion
  } else if (output.adoptCommittedContext) return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'adoptCommittedContext requires a ContextDelta') }

  const compactRequested = output.contextDelta?.target === 'lane' && output.contextDelta.ops.some((op) => op.op === 'compact_history')
  const nextHistoryTokens = estimateHistoryTokens(workingLane.context.history)
  if (nextHistoryTokens > state.historyHardTokens && !compactRequested) return { rejection: error('CONTEXT_TOO_LARGE', 'Lane history exceeded hardTokens and must be compacted before another Step can commit.', { historyTokens: nextHistoryTokens, softTokens: state.historySoftTokens, hardTokens: state.historyHardTokens }) }
  const pressure = historyPressure(workingLane.context.history, state.historySoftTokens, state.historyHardTokens)
  if (pressure) workingLane.historyPressure = pressure
  else delete workingLane.historyPressure

  for (const action of actions) {
    if (action.type === 'submit_effects') {
      if (!Array.isArray(action.effects)) return { rejection: error('INVALID_EFFECT_BATCH', 'submit_effects.effects must be an array') }
      if (action.effects.length === 0) return { rejection: error('EMPTY_EFFECT_BATCH', 'submit_effects requires at least one effect') }
      if (action.wait !== undefined) {
        const waitShapeError = validateSubmitWaitShape(action.wait)
        if (waitShapeError) return { rejection: error(waitShapeError, 'Wait rejected') }
      }
      for (const submission of action.effects) {
        const submissionError = validateEffectSubmission(submission)
        if (submissionError) return { rejection: error(submissionError, 'Effect submission rejected') }
      }
      const newQueued = action.effects.filter((submission) => submission.concurrencyClass !== 'none').length
      if (queuedEffectCount + newQueued > state.maxQueuedEffects) return { rejection: error('EFFECT_QUEUE_FULL', 'effect queue capacity would be exceeded') }
      queuedEffectCount += newQueued
      const batchTargets = new Map<string, TargetRef>()
      for (const submission of action.effects) {
        if (seenEffectKeys.has(submission.key)) return { rejection: error('DUPLICATE_EFFECT_KEY', submission.key) }
        if (submission.locks && new Set(submission.locks.map((lock) => lock.resource)).size !== submission.locks.length) return { rejection: error('DUPLICATE_EFFECT_LOCK', submission.key) }
        const submissionDerived = derivedPrivacy(state, lane, submission.derivedFrom ?? [])
        if (submissionDerived.error) return { rejection: error(submissionDerived.error, submission.key) }
        if (submission.toolCallId !== undefined && (existingToolCallIds.has(submission.toolCallId) || seenToolCallIds.has(submission.toolCallId))) return { rejection: error('DUPLICATE_TOOL_CALL_ID', submission.toolCallId) }
        const prepared = prepareLLMInput(state, lane, submission)
        if (prepared.error) return { rejection: error(prepared.error, submission.key) }
        seenEffectKeys.add(submission.key)
        if (submission.toolCallId !== undefined) seenToolCallIds.add(submission.toolCallId)
        const id = `effect-${effectCounter++}`
        const target = { kind: 'effect' as const, id }
        batchTargets.set(submission.key, target)
        localTargets.set(submission.key, target)
        const effect: EffectRecord = { id, agentId: lane.agentId, ownerLaneId: lane.id, key: submission.key, kind: submission.kind, concurrencyClass: submission.concurrencyClass, input: clone(prepared.input ?? submission.input), ...(submission.derivedFrom === undefined ? {} : { derivedFrom: [...submission.derivedFrom] }), state: 'queued', attemptId: `${id}-attempt-1`, attemptNo: 1, executionState: 'local', sideEffectState: 'none', ...(submission.kind === 'llm' ? { preparation: { state: 'idle' as const, generation: 0 } } : {}), ...(submission.priority === undefined ? {} : { schedulePriority: submission.priority }), ...(submission.deadlineAt === undefined ? {} : { deadlineAt: submission.deadlineAt }), ...(submission.cancelGraceMs === undefined ? {} : { cancelGraceMs: submission.cancelGraceMs }), ...(submission.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: submission.attemptTimeoutMs }), ...(submission.idempotencyKey === undefined ? {} : { idempotencyKey: submission.idempotencyKey }), ...(submission.sideEffectPolicy === undefined ? {} : { sideEffectPolicy: submission.sideEffectPolicy }), ...(submission.toolVersion === undefined ? {} : { toolVersion: submission.toolVersion }), ...(submission.retryPolicy === undefined ? {} : { retryPolicy: clone(submission.retryPolicy) }), ...(submission.duplicateExecutionPolicy === undefined ? {} : { duplicateExecutionPolicy: submission.duplicateExecutionPolicy }), ...(submission.maxUnknownAttempts === undefined ? {} : { maxUnknownAttempts: submission.maxUnknownAttempts }), ...(submission.toolCallId === undefined ? {} : { toolCallId: submission.toolCallId }), ...(submission.llmEffectId === undefined ? {} : { llmEffectId: submission.llmEffectId }), ...(submission.locks === undefined ? {} : { locks: clone(submission.locks) }) }
        mutations.push({ op: 'insertEffect', record: effect })
        if (submission.toolCallId !== undefined) mutations.push({ op: 'setToolCallCorrelation', record: { toolCallId: submission.toolCallId, llmEffectId: submission.llmEffectId ?? 'unknown', toolEffectId: id } })
        workingLane.ownedEffectIds.add(id)
      }
      if (action.wait) {
        const spec: WaitSpec = { dependencies: action.effects.map((submission) => ({ key: submission.key, target: batchTargets.get(submission.key)!, condition: 'settled' as const })), mode: 'all', ...(action.wait.deadlineAt === undefined ? {} : { deadlineAt: action.wait.deadlineAt }), onUnsatisfied: action.wait.onUnsatisfied, ...(action.wait.onCancelled ? { onCancelled: action.wait.onCancelled } : {}), reason: action.wait.reason ?? 'effect' }
        const waitError = validateWait(state, lane.id, spec, new Map(), batchTargets)
        if (waitError) return { rejection: error(waitError, 'Wait rejected') }
        if (hasDependencyCycle(state, spec.dependencies.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: dependency.target as TargetRef })))) return { rejection: error('DEPENDENCY_CYCLE', 'Wait would create a dependency cycle') }
        addWait(state, workingLane, spec, batchTargets, mutations, `wait-${waitCounter++}`)
      }
    } else if (action.type === 'fork') {
      const forkShapeError = validateForkActionShape(action)
      if (forkShapeError) return { rejection: error(forkShapeError, 'Fork rejected') }
      const forkAction = state.forkAffinity === 'coalesce' ? coalesceForkAction(action) : action
      if (forkAction.lanes.length === 0) return { rejection: error('EMPTY_FORK', 'fork requires at least one lane') }
      if (state.forkAffinity === 'advise' && forkAction.affinityAck !== true) {
        const groups = affinityGroups(forkAction.lanes)
        if (groups.length) return { rejection: error('FORK_AFFINITY_COLLAPSIBLE', 'Fork contains lanes that share a likely context affinity group.', { groups } as unknown as JsonValue) }
      }
      const agent = state.agents.get(lane.agentId)
      const activeAgentLanes = [...state.lanes.values()].filter((candidate) => candidate.agentId === lane.agentId && !['succeeded', 'failed', 'cancelled'].includes(candidate.status)).length
      if (agent && activeAgentLanes + forkAction.lanes.length > agent.maxActiveLanes) return { rejection: error('AGENT_LANE_LIMIT_EXCEEDED', 'agent active lane limit exceeded') }
      const siblingTargets = new Map<string, TargetRef>()
      for (const child of forkAction.lanes) {
        if (forkTargets.has(child.key)) return { rejection: error('DUPLICATE_FORK_KEY', child.key) }
        const childId = `lane-${laneCounter++}`
        const target = { kind: 'lane' as const, id: childId }
        forkTargets.set(child.key, target)
        siblingTargets.set(child.key, target)
      }
      if (state.lanes.size + forkAction.lanes.length > state.maxTotalLanes) return { rejection: error('LANE_LIMIT_EXCEEDED', 'runtime lane limit exceeded') }
      for (const child of forkAction.lanes) {
        const target = siblingTargets.get(child.key)!
        if (child.inputResultRefs?.some((ref) => !state.results.has(ref))) return { rejection: error('UNKNOWN_RESULT_REF', `fork input for ${child.key}`) }
        if (child.series && (!child.series.keys.length || new Set(child.series.keys).size !== child.series.keys.length || !validResume(child.series.member))) return { rejection: error('INVALID_SERIES_LANE', `series for ${child.key}`) }
        const contextVersion = child.contextVersion === 'latest' ? state.agents.get(lane.agentId)!.latestGlobalVersion : child.contextVersion === 'parent' || child.contextVersion === undefined ? lane.contextSnapshotVersion : child.contextVersion
        if (!state.agents.get(lane.agentId)!.globalVersions.has(contextVersion)) return { rejection: error('UNKNOWN_CONTEXT_VERSION', String(contextVersion)) }
        const dependencies = (child.dependsOn ?? []).map((dependency) => ({ ...dependency, target: resolveTarget(dependency.target, siblingTargets) ?? resolveTarget(dependency.target, localTargets) }))
        if (dependencies.some((dependency) => !dependency.target)) return { rejection: error('UNKNOWN_TARGET', `fork dependency for ${child.key}`) }
        const record: LaneRecord = { id: target.id, agentId: lane.agentId, ownerLaneId: lane.id, status: dependencies.length ? 'waiting' : 'ready', version: 0, goal: child.goal, resume: clone(child.program), ...(child.series === undefined ? {} : { series: clone(child.series) }), contextSnapshotVersion: contextVersion, context: { version: 0, history: [], state: {} }, visibleResultRefs: new Set(child.inputResultRefs ?? []), children: new Set(), priority: child.priority ?? lane.priority, enqueueSeq: state.nextIds.event + laneCounter, readySince: state.now, ownedEffectIds: new Set() }
        if (dependencies.length) {
          const startupWait: WaitSpec = { dependencies: dependencies as DependencySpec[], mode: 'all', onUnsatisfied: 'fail_lane', reason: 'startup' }
          const availableTargets = new Map([...siblingTargets, ...localTargets])
          const startupWaitError = validateWait(state, record.id, startupWait, new Map(), availableTargets)
          if (startupWaitError) return { rejection: error(startupWaitError, `fork dependency for ${child.key}`) }
        }
        mutations.push({ op: 'insertLane', record })
        workingLane.children.add(record.id)
        if (!dependencies.length) mutations.push({ op: 'appendEvent', event: { type: 'lane.ready', laneId: record.id } })
        else {
          const waitSpec: WaitSpec = { dependencies: dependencies as DependencySpec[], mode: 'all', onUnsatisfied: 'fail_lane', reason: 'startup' }
          const resolved = new Map(dependencies.map((dependency) => [dependency.key, dependency.target!] as const))
          addWait(state, record, waitSpec, resolved, mutations, `wait-${waitCounter++}`)
        }
      }
      if (!forkAction.join) {
        const forkEdges = forkAction.lanes.flatMap((child) => (child.dependsOn ?? []).map((dependency) => ({ from: siblingTargets.get(child.key)!, to: resolveTarget(dependency.target, siblingTargets) ?? resolveTarget(dependency.target, localTargets)! })))
        if (forkEdges.some((edge) => !edge.to) || hasDependencyCycle(state, forkEdges)) return { rejection: error('DEPENDENCY_CYCLE', 'Fork dependencies would create a cycle') }
      }
      if (forkAction.join) {
        const aliases = forkAction.joinAliases === undefined ? forkAction.lanes.map((child) => [child.key, child.key] as const) : Object.entries(forkAction.joinAliases)
        if (new Set(aliases.map(([key]) => key)).size !== aliases.length || aliases.some(([, laneKey]) => !siblingTargets.has(laneKey))) return { rejection: error('INVALID_JOIN_ALIASES', 'join aliases must point to unique original keys and existing fork lanes') }
        const deps = aliases.map(([key, laneKey]) => ({ key, target: siblingTargets.get(laneKey)!, condition: forkAction.join!.condition }))
        const joinMode = forkAction.join.mode ?? 'all'
        const spec: WaitSpec = { dependencies: deps, mode: joinMode, ...(forkAction.join.quorum === undefined ? {} : { quorum: forkAction.join.quorum }), ...(forkAction.join.deadlineAt === undefined ? {} : { deadlineAt: forkAction.join.deadlineAt }), onUnsatisfied: forkAction.join.onUnsatisfied, ...(forkAction.join.onCancelled ? { onCancelled: forkAction.join.onCancelled } : {}), reason: 'join' }
        const forkEdges = forkAction.lanes.flatMap((child) => (child.dependsOn ?? []).map((dependency) => ({ from: siblingTargets.get(child.key)!, to: resolveTarget(dependency.target, siblingTargets) ?? resolveTarget(dependency.target, localTargets)! })))
        forkEdges.push(...deps.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: dependency.target as TargetRef })))
        if (forkEdges.some((edge) => !edge.to) || hasDependencyCycle(state, forkEdges)) return { rejection: error('DEPENDENCY_CYCLE', 'Fork dependencies would create a cycle') }
        const joinTargets = new Map(deps.map((dependency) => [dependency.key, dependency.target] as const))
        const waitError = validateWait(state, lane.id, spec, new Map(), joinTargets, true)
        if (waitError) return { rejection: error(waitError, 'Join rejected') }
        addWait(state, workingLane, spec, joinTargets, mutations, `wait-${waitCounter++}`)
      }
    } else if (action.type === 'wait') {
      const waitError = validateWait(state, lane.id, action.spec, localTargets, new Map())
      if (waitError) return { rejection: error(waitError, 'Wait rejected') }
      const targets = new Map<string, TargetRef>()
      for (const dependency of action.spec.dependencies) {
        const target = resolveTarget(dependency.target, localTargets)
        if (target) targets.set(dependency.key, target)
      }
      if (hasDependencyCycle(state, action.spec.dependencies.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: resolveTarget(dependency.target, localTargets)! })))) return { rejection: error('DEPENDENCY_CYCLE', 'Wait would create a dependency cycle') }
      addWait(state, workingLane, action.spec, targets, mutations, `wait-${waitCounter++}`)
    } else if (action.type === 'cancel_lane') {
      if (seenCancelTargets.has(action.laneId)) return { rejection: error('DUPLICATE_CANCEL_TARGET', action.laneId) }
      seenCancelTargets.add(action.laneId)
      if (action.laneId === lane.id || !descendants(state, lane.id, action.laneId)) return { rejection: error('CANCEL_NOT_OWNER', 'a Lane can only cancel its own descendants') }
      cancelLaneSubtree(state, action.laneId, action.reason, mutations, cancelledSubtreeLanes)
    } else if (action.type === 'propose_cancel') {
      if (seenCancelTargets.has(action.laneId)) return { rejection: error('DUPLICATE_CANCEL_TARGET', action.laneId) }
      seenCancelTargets.add(action.laneId)
      const target = state.lanes.get(action.laneId)
      if (!target) return { rejection: error('UNKNOWN_LANE', action.laneId) }
      if (target.ownerLaneId && target.ownerLaneId !== lane.id) {
        const owner = laneCopy(state.lanes.get(target.ownerLaneId)!)
        enqueueControlProposal(owner, { type: 'cancel_lane', laneId: target.id, reason: action.reason, fromLaneId: lane.id })
        mutations.push({ op: 'setLane', laneId: owner.id, record: { ...owner, version: owner.version + 1 } })
      }
    } else if (action.type === 'adopt_context') {
      if (output.contextDelta) return { rejection: error('CONFLICTING_ADOPT', 'explicit adopt conflicts with adoptCommittedContext') }
      const version = action.version === 'latest' ? state.agents.get(lane.agentId)!.latestGlobalVersion : action.version
      if (!state.agents.get(lane.agentId)!.globalVersions.has(version)) return { rejection: error('UNKNOWN_CONTEXT_VERSION', String(version)) }
      workingLane.contextSnapshotVersion = version
    } else if (action.type === 'downgrade_privacy') {
      if (!nonEmptyString(action.outputRef) || !isRuntimeJsonValue(action.value ?? null) || (action.summary !== undefined && !isRuntimeJsonValue(action.summary)) || !validProvenanceRefs(action.sourceRefs)) return { rejection: error('INVALID_PRIVACY_DOWNGRADE', 'Privacy downgrade shape is invalid') }
      if (!action.outputRef || state.results.has(action.outputRef)) return { rejection: error('INVALID_PRIVACY_OUTPUT_REF', 'downgrade_privacy requires a fresh outputRef') }
      if (action.targetPrivacy !== 'cloud_allowed') return { rejection: error('INVALID_PRIVACY_TARGET', 'Only cloud_allowed is a supported downgrade target.') }
      if (action.sourceRefs.length === 0) return { rejection: error('EMPTY_PRIVACY_SOURCES', 'downgrade_privacy requires at least one source reference.') }
      if (action.method === 'human_approval') {
        if (!action.approvalRef) return { rejection: error('MISSING_PRIVACY_APPROVAL', 'human_approval requires approvalRef.') }
        const approval = state.results.get(action.approvalRef)
        if (!approval) return { rejection: error('UNKNOWN_PRIVACY_APPROVAL', 'approvalRef must reference a published approval result.') }
        if (!resultVisible(lane, action.approvalRef)) return { rejection: error('RESULT_NOT_VISIBLE', 'approvalRef is not visible to this Lane.') }
        const approvalValue = approval.value
        const approved = approvalValue === true || (approvalValue && typeof approvalValue === 'object' && !Array.isArray(approvalValue) && (approvalValue as Record<string, JsonValue>).approved === true)
        if (!approved) return { rejection: error('PRIVACY_APPROVAL_REQUIRED', 'approvalRef must contain an explicit approved=true decision.') }
      }
      if (action.method === 'sanitizer') {
        if (!action.sanitizerId) return { rejection: error('MISSING_PRIVACY_SANITIZER', 'sanitizer requires sanitizerId.') }
        if (!state.trustedSanitizerIds.has(action.sanitizerId)) return { rejection: error('UNTRUSTED_SANITIZER', `Sanitizer ${action.sanitizerId} is not trusted by the Runtime policy.`) }
      }
      const sourcePrivacy = derivedPrivacy(state, lane, action.sourceRefs)
      if (sourcePrivacy.error) return { rejection: error(sourcePrivacy.error, 'Privacy downgrade references an unknown result.') }
      const result: import('../core/types.js').ResultRecord = {
        id: action.outputRef,
        producer: { kind: 'lane', id: lane.id },
        value: clone(action.value ?? null),
        ...resultMetadata(action.value ?? null),
        storageState: 'memory',
        pinCount: 0,
        privacy: action.targetPrivacy,
        derivedFrom: [...action.sourceRefs],
        ...(action.summary === undefined ? {} : { summary: clone(action.summary) }),
        downgrade: {
          sourceRefs: [...action.sourceRefs],
          targetPrivacy: action.targetPrivacy,
          method: action.method,
          ...(action.approvalRef === undefined ? {} : { approvalRef: action.approvalRef }),
          ...(action.sanitizerId === undefined ? {} : { sanitizerId: action.sanitizerId }),
        },
      }
      mutations.push({ op: 'publishResult', record: result })
      if (workingLane.visibleResultRefs) workingLane.visibleResultRefs.add(action.outputRef)
      else workingLane.visibleResultRefs = new Set([action.outputRef])
      mutations.push({ op: 'appendEvent', event: { type: 'privacy.downgraded', laneId: lane.id, data: { outputRef: action.outputRef, sourceRefs: action.sourceRefs, method: action.method } as unknown as JsonValue } })
    } else if (action.type === 'complete') {
      if (!isRuntimeJsonValue(action.result) || (action.derivedFrom !== undefined && !validProvenanceRefs(action.derivedFrom)) || (action.privacy !== undefined && !['public', 'cloud_allowed', 'local_only'].includes(action.privacy)) || (action.privacyTaints !== undefined && !Array.isArray(action.privacyTaints))) return { rejection: error('INVALID_COMPLETE', 'Complete action shape is invalid') }
      const activeChildren = [...lane.children].some((childId) => !['succeeded', 'failed', 'cancelled'].includes(state.lanes.get(childId)?.status ?? 'cancelled'))
      if (activeChildren && (action.children ?? 'reject_if_active') === 'reject_if_active') return { rejection: error('CHILDREN_STILL_ACTIVE', 'complete requires an explicit child join or cancellation') }
      const derived = derivedPrivacy(state, lane, action.derivedFrom ?? [])
      if (derived.error) return { rejection: error(derived.error, 'Result provenance references an unknown result') }
      const taintError = validatePrivacyTaints(action.privacyTaints)
      if (taintError) return { rejection: error(taintError, 'Result privacy taints are invalid') }
      if (action.privacy !== undefined && derived.privacy !== undefined && privacyRank(action.privacy) < privacyRank(derived.privacy)) return { rejection: error('PRIVACY_DOWNGRADE_WITHOUT_PROOF', 'Result privacy cannot be broader than its sources') }
      const propagatedTaints = mergePrivacyTaints(derived.privacyTaints, action.privacyTaints)
      const privacy = effectivePrivacy(strictestPrivacy([derived.privacy ?? 'public', action.privacy ?? 'public']), propagatedTaints)
      if (activeChildren && action.children === 'await') {
        const dependencies = [...lane.children].filter((childId) => !['succeeded', 'failed', 'cancelled'].includes(state.lanes.get(childId)?.status ?? 'cancelled')).map((childId) => ({ key: childId, target: { kind: 'lane' as const, id: childId }, condition: 'settled' as const }))
        if (hasDependencyCycle(state, dependencies.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: dependency.target, kind: 'wait' as const })))) return { rejection: error('DEPENDENCY_CYCLE', 'closing wait would create a dependency cycle') }
        workingLane.closingResult = { value: clone(action.result), privacy, ...(propagatedTaints.length ? { privacyTaints: propagatedTaints } : {}), ...(action.derivedFrom === undefined ? {} : { derivedFrom: [...action.derivedFrom] }) }
        addWait(state, workingLane, { dependencies, mode: 'all', onUnsatisfied: 'resume_with_error', reason: 'join' }, new Map(dependencies.map((dependency) => [dependency.key, dependency.target] as const)), mutations, `wait-${waitCounter++}`)
        workingLane.status = 'waiting'
        mutations.push({ op: 'setLane', laneId: lane.id, record: { ...workingLane, version: lane.version + 1 } })
        mutations.push({ op: 'appendEvent', event: { type: 'lane.closing', laneId: lane.id } })
        return { mutations }
      }
      if (activeChildren && action.children === 'cancel') for (const childId of lane.children) cancelLaneSubtree(state, childId, 'POLICY', mutations, cancelledSubtreeLanes)
      const resultId = `result-${resultCounter++}`
      mutations.push({ op: 'publishResult', record: { id: resultId, producer: { kind: 'lane', id: lane.id }, value: clone(action.result), ...resultMetadata(action.result), storageState: 'memory', pinCount: 0, privacy, ...(propagatedTaints.length ? { privacyTaints: propagatedTaints } : {}), derivedFrom: [...(action.derivedFrom ?? [])] } })
      if (workingLane.visibleResultRefs) workingLane.visibleResultRefs.add(resultId)
      else workingLane.visibleResultRefs = new Set([resultId])
      if (lane.ownerLaneId !== undefined) {
        const owner = state.lanes.get(lane.ownerLaneId)
        if (owner) {
          const ownerCopy = laneCopy(owner)
          if (ownerCopy.visibleResultRefs) ownerCopy.visibleResultRefs.add(resultId)
          else ownerCopy.visibleResultRefs = new Set([resultId])
          mutations.push({ op: 'setLane', laneId: owner.id, record: ownerCopy })
        }
      }
      workingLane.status = 'succeeded'
      workingLane.resultRef = resultId
      mutations.push({ op: 'setLane', laneId: lane.id, record: { ...workingLane, version: lane.version + 1 } })
      mutations.push({ op: 'appendEvent', event: { type: 'lane.succeeded', laneId: lane.id, data: resultId } })
      return { mutations }
    } else if (action.type === 'fail') {
      if (!validRuntimeError(action.error) || (action.derivedFrom !== undefined && !validProvenanceRefs(action.derivedFrom)) || (action.privacy !== undefined && !['public', 'cloud_allowed', 'local_only'].includes(action.privacy))) return { rejection: error('INVALID_FAIL', 'Fail action shape is invalid') }
      const derived = derivedPrivacy(state, lane, action.derivedFrom ?? [])
      if (derived.error) return { rejection: error(derived.error, 'Failure provenance references an unknown or invisible result') }
      if (action.privacy !== undefined && derived.privacy !== undefined && privacyRank(action.privacy) < privacyRank(derived.privacy)) return { rejection: error('PRIVACY_DOWNGRADE_WITHOUT_PROOF', 'Failure privacy cannot be broader than its sources') }
      const privacy = strictestPrivacy([derived.privacy ?? 'public', action.privacy ?? 'public'])
      workingLane.status = 'failed'
      workingLane.failure = { error: clone(action.error), privacy, ...(action.derivedFrom === undefined ? {} : { derivedFrom: [...action.derivedFrom] }) }
      mutations.push({ op: 'setLane', laneId: lane.id, record: { ...workingLane, version: lane.version + 1 } })
      mutations.push({ op: 'appendEvent', event: { type: 'lane.failed', laneId: lane.id, data: action.error as unknown as JsonValue } })
      return { mutations }
    }
  }
  workingLane.resume = clone(output.next)
  workingLane.version = lane.version + 1
  workingLane.status = workingLane.status === 'waiting' ? 'waiting' : 'ready'
  mutations.push({ op: 'setLane', laneId: lane.id, record: workingLane })
  if (workingLane.contextSnapshotVersion !== lane.contextSnapshotVersion) mutations.push({ op: 'appendEvent', event: { type: 'lane.context_adopted', laneId: lane.id, data: workingLane.contextSnapshotVersion } })
  mutations.push({ op: 'appendEvent', event: { type: 'step.committed', laneId: lane.id } })
  return { mutations }
}

export function commitStep(state: RuntimeState, laneId: string, output: LaneStepOutput): ValidationResult {
  const result = validateStep(state, laneId, output)
  if ('rejection' in result) return result
  apply(state, result.mutations)
  return result
}

function requireMutations(): typeof import('../core/mutations.js') {
  return { apply: (state: RuntimeState, mutations: Mutation[]) => {
    for (const mutation of mutations) {
      switch (mutation.op) {
        case 'setAgent': state.agents.set(mutation.agentId, mutation.record); break
        case 'setLane': state.lanes.set(mutation.laneId, mutation.record); break
        case 'setEffect': state.effects.set(mutation.effectId, mutation.record); break
        case 'setWait': state.waits.set(mutation.waitId, mutation.record); break
        case 'insertLane': state.lanes.set(mutation.record.id, mutation.record); break
        case 'insertEffect': state.effects.set(mutation.record.id, mutation.record); break
        case 'insertWait': state.waits.set(mutation.record.id, mutation.record); break
        case 'publishResult': {
          state.results.set(mutation.record.id, mutation.record)
          const match = /^result-(\d+)$/.exec(mutation.record.id)
          if (match) state.nextIds.result = Math.max(state.nextIds.result, Number(match[1]) + 1)
          break
        }
        case 'publishFinding': {
          state.results.set(mutation.record.id, mutation.record)
          const lane = state.lanes.get(mutation.record.laneId)
          if (lane?.visibleResultRefs) lane.visibleResultRefs.add(mutation.record.id)
          else if (lane) lane.visibleResultRefs = new Set([mutation.record.id])
          const match = /^finding-(\d+)$/.exec(mutation.record.id)
          if (match) state.nextIds.result = Math.max(state.nextIds.result, Number(match[1]) + 1)
          break
        }
        case 'setGlobal': { const agent = state.agents.get(mutation.agentId)!; agent.globalVersions.set(mutation.version, mutation.value); if (mutation.metadata) { if (!agent.globalPrivacy) agent.globalPrivacy = new Map(); agent.globalPrivacy.set(mutation.version, structuredClone(mutation.metadata)) } agent.latestGlobalVersion = mutation.version; break }
        case 'setLaneContext': { const lane = state.lanes.get(mutation.laneId)!; lane.context = { ...lane.context, state: mutation.value, version: mutation.version, ...(mutation.history === undefined ? {} : { history: structuredClone(mutation.history) }), ...(mutation.metadata === undefined ? {} : structuredClone(mutation.metadata)) }; break }
        case 'setNextIds': state.nextIds = { ...mutation.nextIds }; break
        case 'appendEvent': appendRuntimeEvent(state, mutation.event); break
        case 'insertMergeProposal': state.mergeProposals.set(mutation.proposal.id, mutation.proposal); break
        case 'removeMergeProposal': state.mergeProposals.delete(mutation.proposalId); break
        case 'setNow': state.now = mutation.now; break
      }
    }
  } }
}
