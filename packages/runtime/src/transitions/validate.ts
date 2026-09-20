import { error } from '../core/errors.js'
import { apply } from '../core/mutations.js'
import { DependencyGraph } from '../dependencies/graph.js'
import type { ValidationResult, Mutation } from '../core/mutations.js'
import { privacyRank, strictestPrivacy } from '../core/types.js'
import type { RuntimeState, LaneStepOutput, RuntimeAction, SubmitEffectsAction, WaitSpec, TargetRef, LocalRef, LaneRecord, EffectRecord, WaitRecord, ContextDelta, JsonValue, ResumePoint, Outcome, DependencySpec, ForkAction, PrivacyLabel, HistoryRecord } from '../core/types.js'
import { appendRuntimeEvent } from '../core/events.js'

const isLocal = (value: TargetRef | LocalRef): value is LocalRef => 'local' in value
const clone = <T>(value: T): T => structuredClone(value)
const laneCopy = (lane: LaneRecord): LaneRecord => ({ ...lane, resume: clone(lane.resume), context: clone(lane.context), children: new Set(lane.children), ownedEffectIds: new Set(lane.ownedEffectIds), ...(lane.pendingResumeInput === undefined ? {} : { pendingResumeInput: clone(lane.pendingResumeInput) }) })

function validResume(resume: ResumePoint): boolean {
  return Boolean(resume.programId && resume.programVersion && resume.step) && resume.locals !== undefined
}

function descendants(state: RuntimeState, ownerId: string, targetId: string): boolean {
  let current = state.lanes.get(targetId)
  while (current?.ownerLaneId) {
    if (current.ownerLaneId === ownerId) return true
    current = state.lanes.get(current.ownerLaneId)
  }
  return false
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

function validateWait(state: RuntimeState, laneId: string, spec: WaitSpec, locals: Map<string, TargetRef>, newTargets: Map<string, TargetRef>): string | undefined {
  if (spec.mode !== 'all' || spec.dependencies.some((dependency) => !dependency.key || !resolveTarget(dependency.target, newTargets.size ? newTargets : locals))) return 'INVALID_WAIT_DEPENDENCY'
  const keys = new Set<string>()
  const targets = new Set<string>()
  for (const dependency of spec.dependencies) {
    if (keys.has(dependency.key)) return 'DUPLICATE_WAIT_KEY'
    keys.add(dependency.key)
    const target = resolveTarget(dependency.target, newTargets.size ? newTargets : locals)!
    const targetKey = `${target.kind}:${target.id}`
    if (targets.has(targetKey)) return 'DUPLICATE_WAIT_TARGET'
    targets.add(targetKey)
    if (target.kind === 'lane' && !state.lanes.has(target.id) && !newTargets.has(target.id)) return 'UNKNOWN_TARGET'
    if (target.kind === 'effect' && !state.effects.has(target.id) && !newTargets.has(target.id)) return 'UNKNOWN_TARGET'
    if (target.kind === 'lane' && target.id === laneId) return 'SELF_DEPENDENCY'
  }
  return undefined
}

function applyContextDelta(state: RuntimeState, lane: LaneRecord, delta: ContextDelta, mutations: Mutation[], proposalId?: string): { nextVersion: number; error?: string; history?: HistoryRecord[] } {
  const base = delta.target === 'global' ? state.agents.get(lane.agentId)!.latestGlobalVersion : lane.context.version
  if (delta.baseVersion !== base) return { nextVersion: base, error: 'CONTEXT_VERSION_CONFLICT' }
  const paths: string[][] = []
  let history = structuredClone(lane.context.history)
  for (const op of delta.ops) {
    if (op.op === 'compact_history') {
      const upToSeq = op.upToSeq
      const summary = op.summary
      if (delta.target !== 'lane' || upToSeq === undefined || summary === undefined || !Number.isInteger(upToSeq) || upToSeq < 1) return { nextVersion: base, error: 'INVALID_HISTORY_COMPACTION' }
      if (!history.some((record) => record.seq <= upToSeq)) return { nextVersion: base, error: 'INVALID_HISTORY_COMPACTION' }
      history = [{ seq: upToSeq, instruction: '[history compacted]', resultRefs: [], output: clone(summary), privacy: delta.privacy ?? 'public' }, ...history.filter((record) => record.seq > upToSeq)]
      continue
    }
    if (!op.path || op.path.length === 0) return { nextVersion: base, error: 'INVALID_CONTEXT_PATH' }
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
      const child = cursor[part]
      if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[part] = {}
      cursor = cursor[part] as Record<string, JsonValue>
    }
    const key = path[path.length - 1]!
    if (op.op === 'set') cursor[key] = clone(op.value ?? null)
    else if (op.op === 'remove') delete cursor[key]
    else if (op.op === 'append') {
      const existing = cursor[key]
      if (!Array.isArray(existing)) return { nextVersion: base, error: 'APPEND_TARGET_NOT_ARRAY' }
      existing.push(clone(op.value ?? null))
    }
  }
  const nextVersion = base + 1
  if (delta.target === 'global' && delta.proposal) mutations.push({ op: 'insertMergeProposal', proposal: { id: proposalId ?? `proposal-${state.nextIds.proposal}`, agentId: lane.agentId, sourceLaneId: lane.id, baseGlobalVersion: base, delta: { ...clone(delta), sourceLaneId: lane.id }, createdAt: state.now } })
  else if (delta.target === 'global') mutations.push({ op: 'setGlobal', agentId: lane.agentId, version: nextVersion, value: result })
  else mutations.push({ op: 'setLaneContext', laneId: lane.id, version: nextVersion, value: result, ...(history.length === lane.context.history.length && history.every((record, index) => record.seq === lane.context.history[index]?.seq) ? {} : { history }) })
  return { nextVersion, ...(delta.target === 'lane' ? { history } : {}) }
}

function addWait(state: RuntimeState, lane: LaneRecord, spec: WaitSpec, targets: Map<string, TargetRef>, mutations: Mutation[], nextId: string): void {
  const dependencies = spec.dependencies.map((dependency) => ({ ...dependency, target: targets.get(dependency.key)! }))
  const wait: WaitRecord = { id: nextId, laneId: lane.id, spec: { ...spec, dependencies }, state: 'pending' }
  mutations.push({ op: 'insertWait', record: wait })
  lane.activeWaitId = nextId
  lane.status = 'waiting'
}

function derivedPrivacy(state: RuntimeState, refs: string[]): { privacy?: PrivacyLabel; error?: string } {
  const labels: PrivacyLabel[] = []
  for (const ref of refs) {
    const result = state.results.get(ref)
    if (!result) return { error: 'UNKNOWN_RESULT_REF' }
    labels.push(result.privacy)
  }
  return { privacy: strictestPrivacy(labels) }
}

export function validateStep(state: RuntimeState, laneId: string, output: LaneStepOutput): ValidationResult {
  const lane = state.lanes.get(laneId)
  if (!lane) return { rejection: error('UNKNOWN_LANE', `Lane ${laneId} does not exist`) }
  if (!validResume(output.next)) return { rejection: error('INVALID_RESUME_POINT', 'next must identify a registered program step') }
  if (lane.status !== 'ready' && lane.status !== 'running') return { rejection: error('LANE_NOT_RUNNABLE', `Lane is ${lane.status}`) }
  const actions = output.actions
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

  if (output.contextDelta) {
    if (output.contextDelta.target === 'global' && !output.contextDelta.proposal && lane.ownerLaneId !== undefined) return { rejection: error('GLOBAL_CONTEXT_WRITE_NOT_AUTHORIZED', 'Only the root Lane may commit Global Context directly.') }
    if (output.contextDelta.target !== 'global' && output.contextDelta.proposal) return { rejection: error('INVALID_MERGE_PROPOSAL', 'Only Global Context deltas may be proposals.') }
    const applied = applyContextDelta(state, workingLane, output.contextDelta, mutations, output.contextDelta.proposal ? `proposal-${proposalCounter++}` : undefined)
    if (applied.error) return { rejection: error(applied.error, 'ContextDelta rejected') }
    if (output.contextDelta.target === 'lane') {
      const nextValue = mutations[mutations.length - 1]
      if (nextValue?.op === 'setLaneContext') workingLane.context = { ...workingLane.context, state: nextValue.value, version: applied.nextVersion, ...(nextValue.history === undefined ? {} : { history: structuredClone(nextValue.history) }) }
    }
    if (output.adoptCommittedContext && output.contextDelta.target !== 'global') return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'adoptCommittedContext requires a global ContextDelta') }
    if (output.contextDelta.proposal && output.adoptCommittedContext) return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'proposals cannot be adopted in the same transaction') }
    if (output.contextDelta.target === 'global' && output.adoptCommittedContext) workingLane.contextSnapshotVersion = applied.nextVersion
  } else if (output.adoptCommittedContext) return { rejection: error('INVALID_ADOPT_COMMITTED_CONTEXT', 'adoptCommittedContext requires a ContextDelta') }

  for (const action of actions) {
    if (action.type === 'submit_effects') {
      if (action.effects.length === 0) return { rejection: error('EMPTY_EFFECT_BATCH', 'submit_effects requires at least one effect') }
      const newQueued = action.effects.filter((submission) => submission.concurrencyClass !== 'none').length
      if (queuedEffectCount + newQueued > state.maxQueuedEffects) return { rejection: error('EFFECT_QUEUE_FULL', 'effect queue capacity would be exceeded') }
      queuedEffectCount += newQueued
      const batchTargets = new Map<string, TargetRef>()
      for (const submission of action.effects) {
        if (seenEffectKeys.has(submission.key)) return { rejection: error('DUPLICATE_EFFECT_KEY', submission.key) }
        if (submission.locks && new Set(submission.locks.map((lock) => lock.resource)).size !== submission.locks.length) return { rejection: error('DUPLICATE_EFFECT_LOCK', submission.key) }
        seenEffectKeys.add(submission.key)
        const id = `effect-${effectCounter++}`
        const target = { kind: 'effect' as const, id }
        batchTargets.set(submission.key, target)
        localTargets.set(submission.key, target)
        const effect: EffectRecord = { id, agentId: lane.agentId, ownerLaneId: lane.id, key: submission.key, kind: submission.kind, concurrencyClass: submission.concurrencyClass, input: clone(submission.input), state: 'queued', attemptId: `${id}-attempt-1`, attemptNo: 1, executionState: 'local', sideEffectState: 'none', ...(submission.priority === undefined ? {} : { schedulePriority: submission.priority }), ...(submission.deadlineAt === undefined ? {} : { deadlineAt: submission.deadlineAt }), ...(submission.cancelGraceMs === undefined ? {} : { cancelGraceMs: submission.cancelGraceMs }), ...(submission.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: submission.attemptTimeoutMs }), ...(submission.idempotencyKey === undefined ? {} : { idempotencyKey: submission.idempotencyKey }), ...(submission.sideEffectPolicy === undefined ? {} : { sideEffectPolicy: submission.sideEffectPolicy }), ...(submission.retryPolicy === undefined ? {} : { retryPolicy: clone(submission.retryPolicy) }), ...(submission.duplicateExecutionPolicy === undefined ? {} : { duplicateExecutionPolicy: submission.duplicateExecutionPolicy }), ...(submission.maxUnknownAttempts === undefined ? {} : { maxUnknownAttempts: submission.maxUnknownAttempts }), ...(submission.toolCallId === undefined ? {} : { toolCallId: submission.toolCallId }), ...(submission.locks === undefined ? {} : { locks: clone(submission.locks) }) }
        mutations.push({ op: 'insertEffect', record: effect })
        workingLane.ownedEffectIds.add(id)
      }
      if (action.wait) {
        const spec: WaitSpec = { dependencies: action.effects.map((submission) => ({ key: submission.key, target: batchTargets.get(submission.key)!, condition: 'settled' as const })), mode: 'all', onUnsatisfied: action.wait.onUnsatisfied, ...(action.wait.onCancelled ? { onCancelled: action.wait.onCancelled } : {}), reason: action.wait.reason ?? 'effect' }
        if (hasDependencyCycle(state, spec.dependencies.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: dependency.target as TargetRef })))) return { rejection: error('DEPENDENCY_CYCLE', 'Wait would create a dependency cycle') }
        addWait(state, workingLane, spec, batchTargets, mutations, `wait-${waitCounter++}`)
      }
    } else if (action.type === 'fork') {
      if (action.lanes.length === 0) return { rejection: error('EMPTY_FORK', 'fork requires at least one lane') }
      const siblingTargets = new Map<string, TargetRef>()
      for (const child of action.lanes) {
        if (forkTargets.has(child.key)) return { rejection: error('DUPLICATE_FORK_KEY', child.key) }
        const childId = `lane-${laneCounter++}`
        const target = { kind: 'lane' as const, id: childId }
        forkTargets.set(child.key, target)
        siblingTargets.set(child.key, target)
      }
      if (state.lanes.size + action.lanes.length > state.maxTotalLanes) return { rejection: error('LANE_LIMIT_EXCEEDED', 'runtime lane limit exceeded') }
      for (const child of action.lanes) {
        const target = siblingTargets.get(child.key)!
        const contextVersion = child.contextVersion === 'latest' ? state.agents.get(lane.agentId)!.latestGlobalVersion : child.contextVersion === 'parent' || child.contextVersion === undefined ? lane.contextSnapshotVersion : child.contextVersion
        if (!state.agents.get(lane.agentId)!.globalVersions.has(contextVersion)) return { rejection: error('UNKNOWN_CONTEXT_VERSION', String(contextVersion)) }
        const dependencies = (child.dependsOn ?? []).map((dependency) => ({ ...dependency, target: resolveTarget(dependency.target, siblingTargets) ?? resolveTarget(dependency.target, localTargets) }))
        if (dependencies.some((dependency) => !dependency.target)) return { rejection: error('UNKNOWN_TARGET', `fork dependency for ${child.key}`) }
        const record: LaneRecord = { id: target.id, agentId: lane.agentId, ownerLaneId: lane.id, status: dependencies.length ? 'waiting' : 'ready', version: 0, goal: child.goal, resume: clone(child.program), contextSnapshotVersion: contextVersion, context: { version: 0, history: [], state: {} }, children: new Set(), priority: child.priority ?? lane.priority, enqueueSeq: state.nextIds.event + laneCounter, readySince: state.now, ownedEffectIds: new Set() }
        mutations.push({ op: 'insertLane', record })
        workingLane.children.add(record.id)
        if (!dependencies.length) mutations.push({ op: 'appendEvent', event: { type: 'lane.ready', laneId: record.id } })
        else {
          const waitSpec: WaitSpec = { dependencies: dependencies as DependencySpec[], mode: 'all', onUnsatisfied: 'fail_lane', reason: 'startup' }
          const resolved = new Map(dependencies.map((dependency) => [dependency.key, dependency.target!] as const))
          addWait(state, record, waitSpec, resolved, mutations, `wait-${waitCounter++}`)
        }
      }
      if (!action.join) {
        const forkEdges = action.lanes.flatMap((child) => (child.dependsOn ?? []).map((dependency) => ({ from: siblingTargets.get(child.key)!, to: resolveTarget(dependency.target, siblingTargets) ?? resolveTarget(dependency.target, localTargets)! })))
        if (forkEdges.some((edge) => !edge.to) || hasDependencyCycle(state, forkEdges)) return { rejection: error('DEPENDENCY_CYCLE', 'Fork dependencies would create a cycle') }
      }
      if (action.join) {
        const deps = action.lanes.map((child) => ({ key: child.key, target: siblingTargets.get(child.key)!, condition: action.join!.condition }))
        const spec: WaitSpec = { dependencies: deps, mode: 'all', onUnsatisfied: action.join.onUnsatisfied, ...(action.join.onCancelled ? { onCancelled: action.join.onCancelled } : {}), reason: 'join' }
        const forkEdges = action.lanes.flatMap((child) => (child.dependsOn ?? []).map((dependency) => ({ from: siblingTargets.get(child.key)!, to: resolveTarget(dependency.target, siblingTargets) ?? resolveTarget(dependency.target, localTargets)! })))
        forkEdges.push(...deps.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: dependency.target as TargetRef })))
        if (forkEdges.some((edge) => !edge.to) || hasDependencyCycle(state, forkEdges)) return { rejection: error('DEPENDENCY_CYCLE', 'Fork dependencies would create a cycle') }
        addWait(state, workingLane, spec, siblingTargets, mutations, `wait-${waitCounter++}`)
      }
    } else if (action.type === 'wait') {
      const targets = new Map<string, TargetRef>()
      for (const dependency of action.spec.dependencies) {
        const target = resolveTarget(dependency.target, localTargets)
        if (target) targets.set(dependency.key, target)
      }
      const waitError = validateWait(state, lane.id, action.spec, localTargets, targets)
      if (waitError) return { rejection: error(waitError, 'Wait rejected') }
      if (hasDependencyCycle(state, action.spec.dependencies.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: resolveTarget(dependency.target, localTargets)! })))) return { rejection: error('DEPENDENCY_CYCLE', 'Wait would create a dependency cycle') }
      addWait(state, workingLane, action.spec, targets, mutations, `wait-${waitCounter++}`)
    } else if (action.type === 'cancel_lane') {
      if (action.laneId === lane.id || !descendants(state, lane.id, action.laneId)) return { rejection: error('CANCEL_NOT_OWNER', 'a Lane can only cancel its own descendants') }
      const target = state.lanes.get(action.laneId)!
      mutations.push({ op: 'setLane', laneId: target.id, record: { ...laneCopy(target), status: 'cancelled', version: target.version + 1 } })
    } else if (action.type === 'propose_cancel') {
      const target = state.lanes.get(action.laneId)
      if (!target) return { rejection: error('UNKNOWN_LANE', action.laneId) }
      if (target.ownerLaneId && target.ownerLaneId !== lane.id) {
        const owner = laneCopy(state.lanes.get(target.ownerLaneId)!)
        const proposal = { type: 'cancel_lane' as const, laneId: target.id, reason: action.reason, fromLaneId: lane.id }
        const existing = owner.pendingResumeInput?.type === 'control_proposal' ? owner.pendingResumeInput.proposals : []
        owner.pendingResumeInput = { type: 'control_proposal', proposals: [...existing, proposal] }
        mutations.push({ op: 'setLane', laneId: owner.id, record: { ...owner, version: owner.version + 1 } })
      }
    } else if (action.type === 'adopt_context') {
      if (output.contextDelta) return { rejection: error('CONFLICTING_ADOPT', 'explicit adopt conflicts with adoptCommittedContext') }
      const version = action.version === 'latest' ? state.agents.get(lane.agentId)!.latestGlobalVersion : action.version
      if (!state.agents.get(lane.agentId)!.globalVersions.has(version)) return { rejection: error('UNKNOWN_CONTEXT_VERSION', String(version)) }
      workingLane.contextSnapshotVersion = version
    } else if (action.type === 'complete') {
      const activeChildren = [...lane.children].some((childId) => !['succeeded', 'failed', 'cancelled'].includes(state.lanes.get(childId)?.status ?? 'cancelled'))
      if (activeChildren && (action.children ?? 'reject_if_active') === 'reject_if_active') return { rejection: error('CHILDREN_STILL_ACTIVE', 'complete requires an explicit child join or cancellation') }
      if (activeChildren && action.children === 'await') {
        const dependencies = [...lane.children].filter((childId) => !['succeeded', 'failed', 'cancelled'].includes(state.lanes.get(childId)?.status ?? 'cancelled')).map((childId) => ({ key: childId, target: { kind: 'lane' as const, id: childId }, condition: 'settled' as const }))
        if (hasDependencyCycle(state, dependencies.map((dependency) => ({ from: { kind: 'lane' as const, id: lane.id }, to: dependency.target, kind: 'wait' as const })))) return { rejection: error('DEPENDENCY_CYCLE', 'closing wait would create a dependency cycle') }
        workingLane.closingResult = { value: clone(action.result), privacy: action.privacy ?? 'public' }
        addWait(state, workingLane, { dependencies, mode: 'all', onUnsatisfied: 'resume_with_error', reason: 'join' }, new Map(dependencies.map((dependency) => [dependency.key, dependency.target] as const)), mutations, `wait-${waitCounter++}`)
        workingLane.status = 'waiting'
        mutations.push({ op: 'setLane', laneId: lane.id, record: { ...workingLane, version: lane.version + 1 } })
        mutations.push({ op: 'appendEvent', event: { type: 'lane.closing', laneId: lane.id } })
        return { mutations }
      }
      if (activeChildren && action.children === 'cancel') {
        for (const childId of lane.children) {
          const child = state.lanes.get(childId)
          if (child && !['succeeded', 'failed', 'cancelled'].includes(child.status)) mutations.push({ op: 'setLane', laneId: child.id, record: { ...laneCopy(child), status: 'cancelled', version: child.version + 1 } })
        }
      }
      const resultId = `result-${resultCounter++}`
      const derived = derivedPrivacy(state, action.derivedFrom ?? [])
      if (derived.error) return { rejection: error(derived.error, 'Result provenance references an unknown result') }
      if (action.privacy !== undefined && derived.privacy !== undefined && privacyRank(action.privacy) < privacyRank(derived.privacy)) return { rejection: error('PRIVACY_DOWNGRADE_WITHOUT_PROOF', 'Result privacy cannot be broader than its sources') }
      const privacy = strictestPrivacy([derived.privacy ?? 'public', action.privacy ?? 'public'])
      mutations.push({ op: 'publishResult', record: { id: resultId, value: clone(action.result), privacy, derivedFrom: [...(action.derivedFrom ?? [])] } })
      workingLane.status = 'succeeded'
      workingLane.resultRef = resultId
      mutations.push({ op: 'setLane', laneId: lane.id, record: { ...workingLane, version: lane.version + 1 } })
      mutations.push({ op: 'appendEvent', event: { type: 'lane.succeeded', laneId: lane.id, data: resultId } })
      return { mutations }
    } else if (action.type === 'fail') {
      workingLane.status = 'failed'
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
        case 'setLane': state.lanes.set(mutation.laneId, mutation.record); break
        case 'setEffect': state.effects.set(mutation.effectId, mutation.record); break
        case 'setWait': state.waits.set(mutation.waitId, mutation.record); break
        case 'insertLane': state.lanes.set(mutation.record.id, mutation.record); break
        case 'insertEffect': state.effects.set(mutation.record.id, mutation.record); break
        case 'insertWait': state.waits.set(mutation.record.id, mutation.record); break
        case 'publishResult': state.results.set(mutation.record.id, mutation.record); break
        case 'setGlobal': { const agent = state.agents.get(mutation.agentId)!; agent.globalVersions.set(mutation.version, mutation.value); agent.latestGlobalVersion = mutation.version; break }
        case 'setLaneContext': { const lane = state.lanes.get(mutation.laneId)!; lane.context = { ...lane.context, state: mutation.value, version: mutation.version, ...(mutation.history === undefined ? {} : { history: structuredClone(mutation.history) }) }; break }
        case 'appendEvent': appendRuntimeEvent(state, mutation.event); break
        case 'insertMergeProposal': state.mergeProposals.set(mutation.proposal.id, mutation.proposal); break
        case 'setNow': state.now = mutation.now; break
      }
    }
  } }
}
