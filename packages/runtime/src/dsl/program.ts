import { z, type ZodTypeAny } from 'zod'
import type { LaneProgram, LaneStepContext } from '../scheduler/runtime.js'
import { globalContextRef, laneContextRef } from '../core/types.js'
import type { ContextDelta, JsonValue, LaneRecord, LaneStepOutput, ResultRef, ProvenanceRef, RuntimeAction, RuntimeState, ResumeInput, HistoryRecord, ProgressWatchdogState, ContextOp, LaneId, PrivacyLabel, RuntimeError, MergeProposal, ResourceLockSpec, Outcome, ForkAction, ForkLaneSpec, WaitResolution } from '../core/types.js'
import { createDraftProxy } from './context-proxy.js'
import type { ProgramRef } from './templates.js'

export type NextStepTarget<TState = unknown> = string | { step: string } | { complete: { value?: JsonValue; privacy?: PrivacyLabel; children?: 'reject_if_active' | 'cancel' | 'await' } } | { fail: { code: string; message: string; retryable?: boolean; details?: JsonValue; privacy?: PrivacyLabel; derivedFrom?: ProvenanceRef[] } }
export type ScalarProjection<T> = T extends string | number | boolean | null ? T : T extends readonly unknown[] ? never : T extends object ? { [K in keyof T]: T[K] extends string | number | boolean | null ? T[K] : never } : never
export interface InstructionView<TState> { goal: string; state: ScalarProjection<TState> }
export interface StepInputs { results?: ResultRef[]; findings?: ResultRef[]; artifacts?: string[]; events?: string[] }
export interface HistoryCompactionOptions { summarizeTask: string; keepRecentRounds: number }
export interface HistoryRecordMeta { seq: number; effectId?: string; resultRefs: ResultRef[]; resultSelection?: Array<{ ref: ResultRef; rule: string; hash: string }>; result?: ResultRef; findings?: ResultRef[]; privacy: PrivacyLabel; privacyTaints?: import('../core/types.js').PrivacyTaint[] }
export interface ResultMeta { ref: ResultRef; privacy: PrivacyLabel; derivedFrom: ProvenanceRef[]; summary?: JsonValue }
export interface StepContext<TState = JsonValue> {
  lane: Readonly<LaneRecord>
  goal: string
  global: Readonly<JsonValue>
  globalVersion: number
  laneState: TState
  history: ReadonlyArray<HistoryRecordMeta>
  now: number
  watchdog?: ProgressWatchdogState
  resumeInput?: ResumeInput
  results: { meta(ref: ResultRef): ResultMeta | undefined; summary(ref: ResultRef): JsonValue | undefined }
  mergeProposals: ReadonlyArray<MergeProposal>
  mutateLane(mutator: (draft: TState) => void): void
  proposeGlobal(delta: { ops: ContextOp[] | ((draft: Record<string, JsonValue>) => void); privacy?: PrivacyLabel }): void
  commitGlobal(delta: { ops: ContextOp[] | ((draft: Record<string, JsonValue>) => void); privacy?: PrivacyLabel; adoptImmediately?: boolean }): void
  adoptContext(version: number | 'latest'): void
  cancelLane(target: LaneId, reason: 'SUPERSEDED' | 'USER_REQUESTED' | 'POLICY'): void
  proposeCancel(target: LaneId, reason: 'SUPERSEDED' | 'POLICY'): void
  trace(message: string | { kind: string; data?: JsonValue }): void
}

export interface ForkProposalLane { goal: string; program: ProgramRef; priority?: number; contextVersion?: 'parent' | 'latest' | number; affinityKey?: string; resources?: ResourceLockSpec[]; inputResultRefs?: ResultRef[]; dependsOn?: Array<{ sibling: string; condition: 'success' | 'settled' }> }
export interface ForkProposal { lanes: Record<string, ForkProposalLane> }
export interface ForkJoinOptions { condition?: 'success' | 'settled'; onUnsatisfied?: 'fail_lane' | 'resume_with_error'; onCancelled?: 'unsatisfied' | 'ignore' }

type Handler = (ctx: StepContext<any>) => { actions?: RuntimeAction[]; next: NextStepTarget; contextDelta?: ContextDelta | undefined; adoptCommittedContext?: boolean; locals?: JsonValue }

export interface LaneProgramDefinition extends LaneProgram {
  id: string
  version: string
  system?: string
  toolSet?: string
  entry: string
  steps: string[]
  debugSources?: string[]
}
type ErrorBoundaryHandler<TState> = (error: RuntimeError, ctx: StepContext<TState>) => NextStepTarget<TState> | { fail: RuntimeError }

function target(step: NextStepTarget, fallback: string): { step: string; action?: RuntimeAction } {
  if (typeof step === 'string') return { step }
  if ('step' in step) return { step: step.step }
  if ('complete' in step) return { step: fallback, action: { type: 'complete', result: step.complete.value ?? null, ...(step.complete.privacy === undefined ? {} : { privacy: step.complete.privacy }), ...(step.complete.children === undefined ? {} : { children: step.complete.children }) } }
  return { step: fallback, action: { type: 'fail', error: { code: step.fail.code, message: step.fail.message, ...(step.fail.retryable === undefined ? {} : { retryable: step.fail.retryable }), ...(step.fail.details === undefined ? {} : { details: step.fail.details }) }, ...(step.fail.privacy === undefined ? {} : { privacy: step.fail.privacy }), ...(step.fail.derivedFrom === undefined ? {} : { derivedFrom: step.fail.derivedFrom }) } }
}
function clone<T>(value: T): T { return structuredClone(value) }
function asJson(value: unknown): JsonValue { return value as JsonValue }
function scalarProjection(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child === null || typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean').map(([key, child]) => [key, child as JsonValue]))
}
function boundedInstruction(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > 2048) throw Object.assign(new Error('Instruction exceeds the 2 KB DSL limit.'), { code: 'INSTRUCTION_TOO_LARGE', retryable: false })
  return value
}
function programLLMInput(config: { system?: string; toolSet?: string }, input: Record<string, JsonValue>): Record<string, JsonValue> {
  return { ...input, ...(config.system === undefined ? {} : { system: config.system }), ...(config.toolSet === undefined ? {} : { toolSetId: config.toolSet }) }
}

interface AffinityAdviceGroup { keys: string[]; signals: string[] }

function affinityAdvice(ctx: StepContext): AffinityAdviceGroup[] | undefined {
  const input = ctx.resumeInput
  if (!input || input.type !== 'control_error' || input.error.code !== 'FORK_AFFINITY_COLLAPSIBLE') return undefined
  const details = input.error.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const groups = (details as Record<string, JsonValue>).groups
  if (!Array.isArray(groups)) return undefined
  return groups.flatMap((group) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return []
    const value = group as Record<string, JsonValue>
    const keys = Array.isArray(value.keys) ? value.keys.filter((key): key is string => typeof key === 'string') : []
    const signals = Array.isArray(value.signals) ? value.signals.filter((signal): signal is string => typeof signal === 'string') : []
    return keys.length > 1 ? [{ keys, signals }] : []
  })
}

function sameProgram(left: ForkLaneSpec, right: ForkLaneSpec): boolean {
  return left.program.programId === right.program.programId && left.program.programVersion === right.program.programVersion && left.program.step === right.program.step && JSON.stringify(left.program.locals ?? {}) === JSON.stringify(right.program.locals ?? {})
}

function normalizeDependsOn(dependencies: Array<{ sibling: string; condition: 'success' | 'settled' } | { key: string; target: { local: string } | { kind: 'lane' | 'effect'; id: string }; condition: 'success' | 'settled' }> | undefined): ForkLaneSpec['dependsOn'] | undefined {
  return dependencies?.map((dependency) => 'sibling' in dependency ? { key: dependency.sibling, target: { local: dependency.sibling }, condition: dependency.condition } : dependency)
}

function joinOptions(value: ForkJoinOptions | undefined, legacy: { condition?: 'success' | 'settled'; mode?: 'all' | 'any' | 'quorum'; quorum?: number; deadlineAt?: number }): { condition: 'success' | 'settled'; mode: 'all' | 'any' | 'quorum'; quorum?: number; deadlineAt?: number; onUnsatisfied: 'fail_lane' | 'resume_with_error'; onCancelled?: 'unsatisfied' | 'ignore' } {
  return { condition: value?.condition ?? legacy.condition ?? 'settled', mode: legacy.mode ?? 'all', ...(legacy.quorum === undefined ? {} : { quorum: legacy.quorum }), ...(legacy.deadlineAt === undefined ? {} : { deadlineAt: legacy.deadlineAt }), onUnsatisfied: value?.onUnsatisfied ?? 'resume_with_error', ...(value?.onCancelled === undefined ? {} : { onCancelled: value.onCancelled }) }
}

function seriesOrder(members: ForkLaneSpec[]): ForkLaneSpec[] | undefined {
  const byKey = new Map(members.map((lane) => [lane.key, lane]))
  const visiting = new Set<string>(); const visited = new Set<string>(); const ordered: ForkLaneSpec[] = []
  const visit = (key: string): boolean => {
    if (visited.has(key)) return true
    if (visiting.has(key)) return false
    visiting.add(key)
    const lane = byKey.get(key)
    if (!lane) return false
    for (const dependency of lane.dependsOn ?? []) if ('local' in dependency.target && byKey.has(dependency.target.local) && !visit(dependency.target.local)) return false
    visiting.delete(key); visited.add(key); ordered.push(lane); return true
  }
  return members.every((lane) => visit(lane.key)) ? ordered : undefined
}

function collapseAffinityLanes(name: string, lanes: ForkLaneSpec[], groups: AffinityAdviceGroup[], enabled: boolean, joinMode: 'all' | 'any' | 'quorum', condition: 'success' | 'settled'): { lanes: ForkLaneSpec[]; aliases?: Record<string, string> } {
  if (!enabled || joinMode !== 'all' || condition !== 'settled') return { lanes }
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]))
  const collapsed = new Set<string>()
  const aliases: Record<string, string> = {}
  const output: ForkLaneSpec[] = []
  let groupIndex = 0
  for (const group of groups) {
    const members = group.keys.map((key) => byKey.get(key)).filter((lane): lane is ForkLaneSpec => lane !== undefined)
    if (members.length !== group.keys.length || members.some((lane) => (lane.dependsOn ?? []).some((dependency) => !('local' in dependency.target) || !group.keys.includes(dependency.target.local))) || members.some((lane) => !sameProgram(lane, members[0]!))) continue
    const ordered = seriesOrder(members)
    if (!ordered) continue
    const key = `__series_${name}_${groupIndex++}`
    const member = ordered[0]!
    const internalDependencies = Object.fromEntries(ordered.flatMap((lane) => {
      const dependsOn = (lane.dependsOn ?? []).filter((dependency): dependency is typeof dependency & { target: { local: string } } => 'local' in dependency.target).map((dependency) => ({ key: dependency.target.local, condition: dependency.condition }))
      return dependsOn.length ? [[lane.key, { dependsOn }]] : []
    }))
    output.push({ key, goal: ordered.map((lane) => `${lane.key}: ${lane.goal}`).join('\n'), program: member.program, ...(member.priority === undefined ? {} : { priority: member.priority }), ...(member.contextVersion === undefined ? {} : { contextVersion: member.contextVersion }), ...(member.resources === undefined ? {} : { resources: member.resources }), series: { member: member.program, keys: ordered.map((lane) => lane.key), goals: Object.fromEntries(ordered.map((lane) => [lane.key, lane.goal])), ...(Object.keys(internalDependencies).length ? { members: internalDependencies } : {}), onMemberFailure: 'continue' } })
    for (const lane of ordered) { collapsed.add(lane.key); aliases[lane.key] = key }
  }
  output.push(...lanes.filter((lane) => !collapsed.has(lane.key)))
  return Object.keys(aliases).length ? { lanes: output, aliases } : { lanes }
}

function joinedOutcome(ctx: StepContext, dependency: { state: string; outcome: Outcome }, key: string): Outcome {
  if (dependency.outcome.resultRef === undefined) return dependency.outcome
  const value = readResult(ctx, dependency.outcome.resultRef)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return dependency.outcome
  const member = (value as Record<string, JsonValue>).results
  if (!member || typeof member !== 'object' || Array.isArray(member)) return dependency.outcome
  const result = (member as Record<string, JsonValue>)[key]
  if (!result || typeof result !== 'object' || Array.isArray(result)) return dependency.outcome
  const record = result as Record<string, JsonValue>
  const status = record.status
  if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') return dependency.outcome
  return { status, resultRef: dependency.outcome.resultRef, ...(record.result === undefined ? {} : { result: record.result } as { result: JsonValue }), ...(record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? { error: record.error as unknown as RuntimeError } : {}) }
}

function zodJsonSchema(schema: ZodTypeAny): JsonValue {
  const definition = schema?._def as { typeName?: string; shape?: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>; type?: ZodTypeAny; innerType?: ZodTypeAny; values?: string[]; value?: JsonValue; options?: ZodTypeAny[]; description?: string } | undefined
  if (!definition) return {}
  const typeName = definition.typeName
  let result: Record<string, JsonValue>
  if (typeName === 'ZodObject') {
    const shape = typeof definition.shape === 'function' ? definition.shape() : definition.shape ?? {}
    const properties: Record<string, JsonValue> = {}
    const required: string[] = []
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = zodJsonSchema(child)
      if (!child.isOptional()) required.push(key)
    }
    result = { type: 'object', properties, ...(required.length ? { required } : {}) }
  } else if (typeName === 'ZodString') result = { type: 'string' }
  else if (typeName === 'ZodNumber') result = { type: 'number' }
  else if (typeName === 'ZodBoolean') result = { type: 'boolean' }
  else if (typeName === 'ZodNull') result = { type: 'null' }
  else if (typeName === 'ZodArray') result = { type: 'array', items: zodJsonSchema(definition.type!) }
  else if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return zodJsonSchema(definition.innerType ?? definition.type!)
  else if (typeName === 'ZodNullable') result = { anyOf: [zodJsonSchema(definition.innerType!), { type: 'null' }] }
  else if (typeName === 'ZodEnum') result = { enum: [...(definition.values ?? [])] }
  else if (typeName === 'ZodLiteral') result = { const: definition.value ?? null }
  else if (typeName === 'ZodUnion') result = { anyOf: (definition.options ?? []).map(zodJsonSchema) }
  else if (typeName === 'ZodEffects') return zodJsonSchema((definition as { schema: ZodTypeAny }).schema)
  else if (typeName === undefined) result = {}
  else throw new Error(`UNSUPPORTED_OUTPUT_SCHEMA:${typeName}`)
  return definition.description === undefined ? result : { ...result, description: definition.description }
}

function resultVisible(context: LaneStepContext, ref: ResultRef): boolean { return context.lane.visibleResultRefs === undefined || context.lane.visibleResultRefs.has(ref) }
function findResult(context: LaneStepContext, ref: ResultRef): JsonValue | undefined { return resultVisible(context, ref) ? context.state.results.get(ref)?.value : undefined }

function collectResumeResultRefs(input: ResumeInput | undefined, refs: Set<ProvenanceRef>): void {
  if (!input) return
  if (input.type === 'control_error') { collectResumeResultRefs(input.original, refs); return }
  if (input.type !== 'wait') return
  for (const dependency of Object.values(input.resolution.dependencies)) {
    if (dependency.state !== 'settled' && dependency.state !== 'ignored') continue
    if (dependency.outcome.resultRef) refs.add(dependency.outcome.resultRef)
    for (const ref of dependency.outcome.rejectedOutputRefs ?? []) refs.add(ref)
  }
}

function annotateAction(action: RuntimeAction, derivedFrom: ProvenanceRef[]): RuntimeAction {
  if (!derivedFrom.length) return action
  if (action.type === 'complete' || action.type === 'fail') return { ...action, derivedFrom: [...new Set([...derivedFrom, ...(action.derivedFrom ?? [])])] }
  if (action.type === 'submit_effects') return { ...action, effects: action.effects.map((effect) => ({ ...effect, derivedFrom: [...new Set([...derivedFrom, ...(effect.derivedFrom ?? [])])] })) }
  return action
}

const RESULT_READER = Symbol('pulse.dsl.internal.result-reader')
type InternalStepContext<TState> = StepContext<TState> & { [RESULT_READER]: (ref: ResultRef) => JsonValue | undefined }
function readResult(ctx: StepContext, ref: ResultRef): JsonValue | undefined { return (ctx as InternalStepContext<JsonValue>)[RESULT_READER](ref) }

function sdkLocals(locals: JsonValue): Record<string, JsonValue> {
  if (!locals || typeof locals !== 'object' || Array.isArray(locals)) return {}
  const value = (locals as Record<string, JsonValue>).$sdk
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function ordinaryLocals(locals: JsonValue): Record<string, JsonValue> {
  return locals && typeof locals === 'object' && !Array.isArray(locals) ? locals as Record<string, JsonValue> : {}
}

function makeContext<TState>(context: LaneStepContext, initialState: TState): { ctx: StepContext<TState>; getDelta: () => ContextDelta | undefined; getActions: () => RuntimeAction[]; getDerivedRefs: () => ProvenanceRef[]; getAdoptImmediately: () => boolean } {
  const draft = clone(initialState)
  const draftProxy = draft && typeof draft === 'object' && !Array.isArray(draft) ? createDraftProxy(draft as Record<string, unknown>) : undefined
  let delta: ContextDelta | undefined
  const actions: RuntimeAction[] = []
  const derivedRefs = new Set<ProvenanceRef>()
  let adoptImmediately = false
  const agent = context.state.agents.get(context.lane.agentId)
  const globalVersion = context.lane.contextSnapshotVersion
  const global = clone(agent?.globalVersions.get(globalVersion) ?? {})
  const globalDraftProxy = global && typeof global === 'object' && !Array.isArray(global) ? createDraftProxy(global as Record<string, unknown>) : undefined
  if (agent) derivedRefs.add(globalContextRef(agent.id, globalVersion))
  derivedRefs.add(laneContextRef(context.lane.id, context.lane.context.version))
  collectResumeResultRefs(context.resumeInput, derivedRefs)
  for (const record of context.lane.context.history) for (const ref of record.resultRefs) derivedRefs.add(ref)
  const history = context.lane.context.history.map((record: HistoryRecord): HistoryRecordMeta => ({ seq: record.seq, ...(record.effectId === undefined ? {} : { effectId: record.effectId }), resultRefs: [...record.resultRefs], ...(record.resultSelection === undefined ? {} : { resultSelection: clone(record.resultSelection) }), ...(record.result === undefined ? {} : { result: record.result }), ...(record.findings === undefined ? {} : { findings: [...record.findings] }), privacy: record.privacy, ...(record.privacyTaints === undefined ? {} : { privacyTaints: clone(record.privacyTaints) }) }))
  const resultMeta = (ref: ResultRef): ResultMeta | undefined => { const result = resultVisible(context, ref) ? context.state.results.get(ref) : undefined; if (result) derivedRefs.add(ref); return result ? { ref, privacy: result.privacy, derivedFrom: [...result.derivedFrom], ...(result.summary === undefined ? {} : { summary: clone(result.summary) }) } : undefined }
  const globalDelta = (value: { ops: ContextOp[] | ((draft: Record<string, JsonValue>) => void); privacy?: PrivacyLabel; proposal: boolean }): void => {
    const ops = typeof value.ops === 'function' ? (() => { if (!globalDraftProxy) throw Object.assign(new Error('GLOBAL_DRAFT_REQUIRES_OBJECT'), { code: 'GLOBAL_DRAFT_REQUIRES_OBJECT', retryable: false }); value.ops(globalDraftProxy.draft as Record<string, JsonValue>); return globalDraftProxy.changes().ops as ContextOp[] })() : value.ops
    delta = { target: 'global', baseVersion: agent?.latestGlobalVersion ?? 0, sourceLaneId: context.lane.id, ops: clone(ops), ...(value.privacy === undefined ? {} : { privacy: value.privacy }), proposal: value.proposal }
  }
  const ctx: InternalStepContext<TState> = {
    lane: context.lane, goal: context.lane.goal, global, globalVersion, laneState: draft, history, now: context.now, ...(context.lane.progressWatchdog === undefined ? {} : { watchdog: context.lane.progressWatchdog }), ...(context.resumeInput ? { resumeInput: context.resumeInput } : {}),
    [RESULT_READER]: (ref) => { if (context.state.results.has(ref) && resultVisible(context, ref)) derivedRefs.add(ref); return findResult(context, ref) },
    results: { meta: resultMeta, summary: (ref) => { if (context.state.results.has(ref) && resultVisible(context, ref)) derivedRefs.add(ref); return resultMeta(ref)?.summary } },
    mergeProposals: [...context.state.mergeProposals.values()].filter((proposal) => proposal.agentId === context.lane.agentId).map((proposal) => { for (const ref of proposal.delta.derivedFrom ?? []) derivedRefs.add(ref); return clone(proposal) }),
    mutateLane: (mutator) => { mutator((draftProxy?.draft ?? draft) as TState); const changes = draftProxy?.changes(); delta = { target: 'lane', baseVersion: context.lane.context.version, ops: changes?.ops.map((op) => op.op === 'set' ? { op: 'set' as const, path: op.path, value: asJson(op.value) } : op.op === 'append' ? { op: 'append' as const, path: op.path, value: asJson(op.value) } : { op: 'remove' as const, path: op.path }) ?? [] } },
    proposeGlobal: (value) => globalDelta({ ...value, proposal: true }),
    commitGlobal: (value) => { globalDelta({ ...value, proposal: false }); adoptImmediately = value.adoptImmediately ?? false },
    adoptContext: (version) => actions.push({ type: 'adopt_context', version }),
    cancelLane: (laneId, reason) => actions.push({ type: 'cancel_lane', laneId, reason }),
    proposeCancel: (laneId, reason) => actions.push({ type: 'propose_cancel', laneId, reason }),
    trace: (message) => { context.observe?.({ type: 'trace', data: typeof message === 'string' ? message : asJson(message) }) },
  }
  return { ctx, getDelta: () => delta, getActions: () => actions, getDerivedRefs: () => [...derivedRefs], getAdoptImmediately: () => adoptImmediately }
}

export class StepBuilder<TState = JsonValue> {
  readonly handlers = new Map<string, Handler>()
  private boundaryHandler?: ErrorBoundaryHandler<TState>
  constructor(readonly config: { id: string; version: string; system?: string; toolSet?: string; state?: z.ZodType<TState>; historyCompaction?: HistoryCompactionOptions }) {}
  addStep(name: string, handler: Handler): this { this.handlers.set(name, handler); return this }
  onErrorBoundary(handler: ErrorBoundaryHandler<TState>): this { this.boundaryHandler = handler; return this }
  addStructuredLLMStep<TOutput extends ZodTypeAny>(name: string, options: {
    task: string
    instruction: string | ((view: InstructionView<TState>) => string)
    schema: TOutput
    inputs?: (ctx: StepContext<TState>) => StepInputs
    requirements?: Record<string, JsonValue>
    executionPolicy?: { duplicateExecutionPolicy: 'allow' | 'forbid'; maxUnknownAttempts: number }
    retryPolicy?: { maxAttempts: number; initialBackoffMs: number; maxBackoffMs: number; jitter: boolean }
    selfCorrect?: { maxRounds: 0 | 1 }
    onSuccess: (data: z.infer<TOutput>, ctx: StepContext<TState>) => NextStepTarget<TState>
    onError?: (error: RuntimeError, ctx: StepContext<TState>) => NextStepTarget<TState>
  }): this {
    const submit = `${name}:submit`; const decode = `${name}:decode`
    const maxCorrectionRounds = options.selfCorrect?.maxRounds ?? 1
    const correctionRoundKey = `${name}CorrectRound`
    const inputKey = `${name}Inputs`
    const readSdk = (ctx: StepContext<TState>): Record<string, JsonValue> => sdkLocals(ctx.lane.resume.locals)
    const writeSdk = (ctx: StepContext<TState>, patch: Record<string, JsonValue>): JsonValue => { const locals = ctx.lane.resume.locals; const base = locals && typeof locals === 'object' && !Array.isArray(locals) ? locals as Record<string, JsonValue> : {}; return { ...base, $sdk: { ...readSdk(ctx), ...patch } } }
    const fail = (runtimeError: RuntimeError, ctx: StepContext<TState>): { next: NextStepTarget<TState> } => options.onError ? { next: options.onError(runtimeError, ctx) } : (() => { throw Object.assign(new Error(runtimeError.message), runtimeError) })()
    const retryPolicy = options.retryPolicy ?? { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0, jitter: false }
    const requirements = { ...(options.requirements ?? {}) }
    this.handlers.set(name, (ctx) => {
      const instruction = boundedInstruction(typeof options.instruction === 'string' ? options.instruction : options.instruction({ goal: ctx.goal, state: scalarProjection(ctx.laneState) as ScalarProjection<TState> }))
      const inputs = options.inputs?.(ctx) ?? {}
      const inputResultRefs = [...new Set([...(inputs.results ?? []), ...(inputs.findings ?? []), ...(inputs.artifacts ?? [])])]
      const outputSchema = zodJsonSchema(options.schema)
      return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-llm`, kind: 'llm', concurrencyClass: 'llm', input: programLLMInput(this.config, { task: options.task, instruction, inputs: asJson(inputs), outputSchema, requirements: { ...requirements, structuredOutput: { schema: outputSchema } }, ...(options.executionPolicy === undefined ? {} : { executionPolicy: options.executionPolicy }) }), retryPolicy, ...(inputResultRefs.length ? { derivedFrom: inputResultRefs } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode, locals: writeSdk(ctx, { [correctionRoundKey]: 0, [inputKey]: asJson(inputs) }) }
    })
    this.handlers.set(submit, (ctx) => ({ next: decode }))
    this.handlers.set(decode, (ctx) => {
      const input = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).find((dependency) => dependency.state !== 'pending') : undefined
      const ref = input?.state === 'settled' ? input.outcome.resultRef : undefined
      const rejectedRef = input?.state === 'settled' ? input.outcome.rejectedOutputRefs?.[0] : undefined
      const value = rejectedRef ? readResult(ctx, rejectedRef) : ref ? readResult(ctx, ref) : undefined
      const parsed = options.schema.safeParse(value)
      if (!parsed.success) {
        const sdk = readSdk(ctx)
        const currentRound = typeof sdk[correctionRoundKey] === 'number' && Number.isInteger(sdk[correctionRoundKey]) ? sdk[correctionRoundKey] as number : 0
        if (currentRound >= maxCorrectionRounds) return fail({ code: 'OUTPUT_SCHEMA_VIOLATION', message: 'Structured LLM output did not match the declared schema.', retryable: false, details: parsed.error.message }, ctx)
        const originalInputs = sdk[inputKey] && typeof sdk[inputKey] === 'object' && !Array.isArray(sdk[inputKey]) ? sdk[inputKey] as Record<string, JsonValue> : {}
        const inputResultRefs = [...new Set([...(Array.isArray(originalInputs.results) ? originalInputs.results.filter((item): item is string => typeof item === 'string') : []), ...(Array.isArray(originalInputs.findings) ? originalInputs.findings.filter((item): item is string => typeof item === 'string') : []), ...(Array.isArray(originalInputs.artifacts) ? originalInputs.artifacts.filter((item): item is string => typeof item === 'string') : []), ...(rejectedRef ? [rejectedRef] : [])])]
        const outputSchema = zodJsonSchema(options.schema)
        const correctionInstruction = boundedInstruction(`${typeof options.instruction === 'string' ? options.instruction : 'structured'}\nValidation errors: ${parsed.error.message}`)
        return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-correct-${currentRound + 1}`, kind: 'llm', concurrencyClass: 'llm', input: programLLMInput(this.config, { task: options.task, instruction: correctionInstruction, inputs: { ...originalInputs, rejectedOutputRefs: inputResultRefs }, outputSchema, requirements: { ...requirements, structuredOutput: { schema: outputSchema } }, ...(options.executionPolicy === undefined ? {} : { executionPolicy: options.executionPolicy }) }), retryPolicy, ...(inputResultRefs.length ? { derivedFrom: inputResultRefs } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode, locals: writeSdk(ctx, { [correctionRoundKey]: currentRound + 1, [inputKey]: { ...originalInputs, rejectedOutputRefs: inputResultRefs } }) }
      }
      const next = options.onSuccess(parsed.data, ctx)
      return { next }
    })
    return this
  }
  addReActLoopStep(name: string, options: { task?: string; instruction: string | ((view: InstructionView<TState>) => string); inputs?: (ctx: StepContext<TState>) => StepInputs; toolAllow?: string[]; maxTurns?: number; outputSchema?: ZodTypeAny; requirements?: Record<string, JsonValue>; onFinish: ((resultRef: ResultRef, ctx: StepContext<TState>) => NextStepTarget<TState>) | { text: (resultRef: ResultRef, ctx: StepContext<TState>) => NextStepTarget<TState>; structured?: { schema: ZodTypeAny; onParsed: (data: unknown, ctx: StepContext<TState>) => NextStepTarget<TState> } }; onMaxTurns?: (ctx: StepContext<TState>) => NextStepTarget<TState>; onError?: (error: RuntimeError, ctx: StepContext<TState>) => NextStepTarget<TState> }): this {
    const readTurns = (ctx: StepContext<TState>): number => { const sdk = sdkLocals(ctx.lane.resume.locals); const turn = sdk[`${name}Turns`]; return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : 0 }
    const writeTurns = (ctx: StepContext<TState>, turns: number): JsonValue => { const locals = ctx.lane.resume.locals; const base = locals && typeof locals === 'object' && !Array.isArray(locals) ? locals as Record<string, JsonValue> : {}; return { ...base, $sdk: { ...sdkLocals(locals), [`${name}Turns`]: turns } } }
    const resultRefFromWait = (ctx: StepContext<TState>): ResultRef | undefined => { const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined; return dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined }
    const resultRefsFromWait = (ctx: StepContext<TState>): ResultRef[] => ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).flatMap((dependency) => dependency.state === 'settled' && dependency.outcome.resultRef ? [dependency.outcome.resultRef] : []) : []
    const instruction = (ctx: StepContext<TState>): string => boundedInstruction(typeof options.instruction === 'string' ? options.instruction : options.instruction({ goal: ctx.goal, state: scalarProjection(ctx.laneState) as ScalarProjection<TState> }))
    const submitModel = (ctx: StepContext<TState>, turn: number, resultRefs: ResultRef[] = [], artifactRefs: string[] = []): LaneStepOutput => { const dataRefs = [...new Set([...resultRefs, ...artifactRefs])]; const requirements = { ...(options.requirements ?? {}), ...(options.toolAllow === undefined ? {} : { toolCalling: true }) }; return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-turn-${turn}`, kind: 'llm', concurrencyClass: 'llm', input: programLLMInput(this.config, { task: options.task ?? 'reason', instruction: instruction(ctx), inputs: { ...(resultRefs.length ? { results: resultRefs } : {}), ...(artifactRefs.length ? { artifacts: artifactRefs } : {}) }, turn, ...(options.outputSchema === undefined ? {} : { outputSchema: zodJsonSchema(options.outputSchema) }), ...(Object.keys(requirements).length ? { requirements } : {}) }), ...(dataRefs.length ? { derivedFrom: dataRefs } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: this.config.id, programVersion: this.config.version, step: `${name}:decode`, locals: writeTurns(ctx, turn) }, locals: writeTurns(ctx, turn) } }
    this.handlers.set(name, (ctx) => { const turn = readTurns(ctx) + 1; const inputs = options.inputs?.(ctx) ?? {}; const refs = [...new Set([...(inputs.results ?? []), ...(inputs.findings ?? [])])]; const output = submitModel(ctx, turn, refs, [...new Set(inputs.artifacts ?? [])]); return { ...output, next: `${name}:decode` } })
    this.handlers.set(`${name}:tools`, (ctx) => { const turn = readTurns(ctx); const refs = resultRefsFromWait(ctx); return { ...submitModel(ctx, turn + 1, refs), next: `${name}:decode` } })
    this.handlers.set(`${name}:decode`, (ctx) => {
      const turns = readTurns(ctx)
      const ref = resultRefFromWait(ctx)
      const value = ref ? readResult(ctx, ref) ?? null : null
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined
      const finishReason = record?.finishReason
      const toolCalls = Array.isArray(record?.toolCalls) ? record.toolCalls : []
      const fail = (runtimeError: RuntimeError): { next: NextStepTarget<TState> } => options.onError ? { next: options.onError(runtimeError, ctx) } : (() => { const error = Object.assign(new Error(runtimeError.message), runtimeError); throw error })()
      const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 10))
      const maxTurnsReached = (): { next: NextStepTarget<TState> } => options.onMaxTurns ? { next: options.onMaxTurns(ctx) } : fail({ code: 'MAX_TURNS_REACHED', message: `ReAct loop ${name} reached its maximum of ${maxTurns} turns.`, retryable: false })
      if (finishReason === 'tool_calls') {
        if (turns >= maxTurns || toolCalls.length === 0) return maxTurnsReached()
        const invalidTool = toolCalls.find((call) => { const item = call && typeof call === 'object' && !Array.isArray(call) ? call as Record<string, JsonValue> : {}; const toolName = typeof item.name === 'string' ? item.name : ''; return !toolName || (options.toolAllow !== undefined && !options.toolAllow.includes(toolName)) })
        if (invalidTool !== undefined) return fail({ code: 'ACTION_TOOL_NOT_ALLOWED', message: 'Model requested a tool outside the ReAct allow-list.', retryable: false })
        const sourceEffectId = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).find((dependency) => dependency.state === 'settled' && dependency.target.kind === 'effect')?.target.id : undefined
        const effects = toolCalls.map((call, index) => {
          const item = call && typeof call === 'object' && !Array.isArray(call) ? call as Record<string, JsonValue> : {}
          const originalId = typeof item.toolCallId === 'string' ? item.toolCallId : `call-${index + 1}`
          const toolName = typeof item.name === 'string' ? item.name : ''
          return { key: `${name}-tool-${turns}-${index + 1}`, toolCallId: `${name}:${turns}:${originalId}`, ...(sourceEffectId === undefined ? {} : { llmEffectId: sourceEffectId }), kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { toolCallId: `${name}:${turns}:${originalId}`, name: toolName, arguments: item.input ?? {} } }
        })
        return { actions: [{ type: 'submit_effects', effects, wait: { onUnsatisfied: 'resume_with_error' } }], next: `${name}:tools` }
      }
      if (turns >= maxTurns) return maxTurnsReached()
      if (options.outputSchema) {
        const parsed = options.outputSchema.safeParse(value)
        if (!parsed.success) return fail({ code: 'OUTPUT_SCHEMA_VIOLATION', message: 'ReAct result did not match outputSchema.', retryable: false, details: parsed.error.message })
      }
      if (!ref) return fail({ code: 'MISSING_RESULT_REF', message: 'ReAct result did not produce a ResultRef.', retryable: false })
      if (typeof options.onFinish === 'function') return { next: options.onFinish(ref, ctx) }
      if (options.onFinish.structured) {
        const structuredValue = record?.structured ?? value
        const parsed = options.onFinish.structured.schema.safeParse(structuredValue)
        if (!parsed.success) return fail({ code: 'OUTPUT_SCHEMA_VIOLATION', message: 'ReAct structured result did not match schema.', retryable: false, details: parsed.error.message })
        return { next: options.onFinish.structured.onParsed(parsed.data, ctx) }
      }
      return { next: options.onFinish.text(ref, ctx) }
    })
    return this
  }
  addParallelStep(name: string, options: { lanes: Record<string, ForkProposalLane & { dependsOn?: ForkProposalLane['dependsOn'] | Array<{ key: string; target: { local: string } | { kind: 'lane' | 'effect'; id: string }; condition: 'success' | 'settled' }> }>; join?: ForkJoinOptions; condition?: 'success' | 'settled'; mode?: 'all' | 'any' | 'quorum'; quorum?: number; deadlineAt?: number; affinity?: 'collapse' | 'ack'; next?: NextStepTarget; onJoin?: (outcomes: Record<string, Outcome>, ctx: StepContext<TState>) => NextStepTarget }): this {
    const joinStep = `${name}:join`
    this.handlers.set(name, (ctx) => {
      const join = joinOptions(options.join, options)
      const rawLanes: ForkLaneSpec[] = Object.entries(options.lanes).map(([key, lane]) => { const dependsOn = normalizeDependsOn(lane.dependsOn); return { key, goal: lane.goal, program: { programId: lane.program.programId, programVersion: lane.program.programVersion, step: lane.program.step ?? 'start', locals: lane.program.locals ?? {} }, ...(lane.priority === undefined ? {} : { priority: lane.priority }), ...(lane.contextVersion === undefined ? {} : { contextVersion: lane.contextVersion }), ...(lane.affinityKey === undefined ? {} : { affinityKey: lane.affinityKey }), ...(lane.resources === undefined ? {} : { resources: lane.resources }), ...(lane.inputResultRefs === undefined ? {} : { inputResultRefs: lane.inputResultRefs }), ...(dependsOn === undefined ? {} : { dependsOn }) } })
      const collapsed = collapseAffinityLanes(name, rawLanes, affinityAdvice(ctx) ?? [], options.affinity !== 'ack', join.mode, join.condition)
      const action: ForkAction = { type: 'fork', affinityAck: options.affinity === 'ack' || affinityAdvice(ctx) !== undefined, lanes: collapsed.lanes, ...(collapsed.aliases === undefined ? {} : { joinAliases: collapsed.aliases }), join }
      return { actions: [action], next: options.onJoin ? joinStep : options.next ?? joinStep }
    })
    if (options.onJoin) this.handlers.set(joinStep, (ctx) => { const outcomes: Record<string, Outcome> = {}; if (ctx.resumeInput?.type === 'wait') for (const [key, dependency] of Object.entries(ctx.resumeInput.resolution.dependencies)) if (dependency.state !== 'pending') outcomes[key] = joinedOutcome(ctx, dependency, key); return { next: options.onJoin!(outcomes, ctx) } })
    return this
  }
  addDynamicForkStep(name: string, options: { proposal?: (ctx: StepContext<TState>) => ForkProposal; lanes?: (ctx: StepContext<TState>) => Record<string, ForkProposalLane>; join?: ForkJoinOptions; condition?: 'success' | 'settled'; mode?: 'all' | 'any' | 'quorum'; quorum?: number; deadlineAt?: number; affinity?: 'collapse' | 'ack' | ((groups: AffinityAdviceGroup[], ctx: StepContext<TState>) => 'collapse' | 'ack'); next?: NextStepTarget; onJoin?: (outcomes: Map<string, Outcome>, ctx: StepContext<TState>) => NextStepTarget }): this {
    const joinStep = `${name}:join`
    this.handlers.set(name, (ctx) => {
      const join = joinOptions(options.join, options)
      const proposal = options.proposal?.(ctx) ?? { lanes: options.lanes?.(ctx) ?? {} }
      const rawLanes: ForkLaneSpec[] = Object.entries(proposal.lanes).map(([key, lane]) => { const dependsOn = normalizeDependsOn(lane.dependsOn); return { key, goal: lane.goal, program: { programId: lane.program.programId, programVersion: lane.program.programVersion, step: lane.program.step ?? 'start', locals: lane.program.locals ?? {} }, ...(lane.priority === undefined ? {} : { priority: lane.priority }), ...(lane.contextVersion === undefined ? {} : { contextVersion: lane.contextVersion }), ...(lane.affinityKey === undefined ? {} : { affinityKey: lane.affinityKey }), ...(lane.resources === undefined ? {} : { resources: lane.resources }), ...(lane.inputResultRefs === undefined ? {} : { inputResultRefs: lane.inputResultRefs }), ...(dependsOn === undefined ? {} : { dependsOn }) } })
      const advice = affinityAdvice(ctx) ?? []
      const affinity = typeof options.affinity === 'function' ? options.affinity(advice, ctx) : options.affinity
      const collapsed = collapseAffinityLanes(name, rawLanes, advice, affinity !== 'ack', join.mode, join.condition)
      const action: ForkAction = { type: 'fork', affinityAck: affinity === 'ack' || advice.length > 0, lanes: collapsed.lanes, ...(collapsed.aliases === undefined ? {} : { joinAliases: collapsed.aliases }), join }
      return { actions: [action], next: options.onJoin ? joinStep : options.next ?? joinStep }
    })
    if (options.onJoin) this.handlers.set(joinStep, (ctx) => { const outcomes = new Map<string, Outcome>(); if (ctx.resumeInput?.type === 'wait') for (const [key, dependency] of Object.entries(ctx.resumeInput.resolution.dependencies)) if (dependency.state !== 'pending') outcomes.set(key, joinedOutcome(ctx, dependency, key)); return { next: options.onJoin!(outcomes, ctx) } })
    return this
  }
  addMergeStep(name: string, options: { task?: string; next?: NextStepTarget; sources?: { proposals?: 'joined' | LaneId[]; outcomes?: 'joined' | LaneId[] }; instruction?: string | ((ctx: StepContext<TState>) => string); schema?: ZodTypeAny; onSynthesized?: (value: unknown, ctx: StepContext<TState>) => NextStepTarget; onError?: (error: RuntimeError, ctx: StepContext<TState>) => NextStepTarget }): this {
    this.handlers.set(name, (ctx) => {
      const dependencies = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies) : []
      const joinedLaneIds = new Set(dependencies.filter((dependency) => dependency.target.kind === 'lane').map((dependency) => dependency.target.id))
      const outcomeSource = options.sources?.outcomes
      const joined = dependencies.flatMap((dependency) => dependency.state === 'settled' && dependency.outcome.resultRef && (outcomeSource === undefined || outcomeSource === 'joined' || outcomeSource.includes(dependency.target.id)) ? [dependency.outcome.resultRef] : [])
      const proposalSource = options.sources?.proposals
      const proposals = ctx.mergeProposals.filter((proposal) => proposalSource === undefined || (proposalSource === 'joined' ? joinedLaneIds.has(proposal.sourceLaneId) : proposalSource.includes(proposal.sourceLaneId)))
      const instruction = options.instruction === undefined ? undefined : boundedInstruction(typeof options.instruction === 'string' ? options.instruction : options.instruction(ctx))
      return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-llm`, kind: 'llm', concurrencyClass: 'llm', input: programLLMInput(this.config, { task: options.task ?? 'reason', merge: true, sources: asJson(joined), proposals: asJson(proposals.map((proposal) => ({ id: proposal.id, sourceLaneId: proposal.sourceLaneId, delta: proposal.delta }))), ...(instruction === undefined ? {} : { instruction }) }), ...(joined.length ? { derivedFrom: joined } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: `${name}:decode` }
    })
    this.handlers.set(`${name}:decode`, (ctx) => {
      const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined
      const ref = dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined
      const value = ref ? readResult(ctx, ref) : undefined
      const fail = (runtimeError: RuntimeError): { next: NextStepTarget<TState> } => options.onError ? { next: options.onError(runtimeError, ctx) } : (() => { throw Object.assign(new Error(runtimeError.message), runtimeError) })()
      if (options.schema) {
        const parsed = options.schema.safeParse(value)
        if (!parsed.success) return fail({ code: 'OUTPUT_SCHEMA_VIOLATION', message: 'Merge result did not match schema.', retryable: false, details: parsed.error.message })
        const next = options.onSynthesized ? options.onSynthesized(parsed.data, ctx) : options.next
        if (!next) return fail({ code: 'MERGE_TARGET_MISSING', message: 'Merge step requires onSynthesized or next.', retryable: false })
        return { next }
      }
      const next = options.onSynthesized ? options.onSynthesized(value, ctx) : options.next
      if (!next) return fail({ code: 'MERGE_TARGET_MISSING', message: 'Merge step requires onSynthesized or next.', retryable: false })
      return { next }
    })
    return this
  }
  addWaitStep(name: string, spec: { dependencies: Array<{ key: string; target: { kind: 'lane' | 'effect'; id: string }; condition: 'success' | 'settled' }>; mode?: 'all' | 'any' | 'quorum'; quorum?: number; deadlineAt?: number; next: NextStepTarget } | { targets: (ctx: StepContext<TState>) => Array<{ key: string; target: { kind: 'lane' | 'effect'; id: string }; condition: 'success' | 'settled' }>; mode?: 'all' | 'any' | 'quorum'; quorum?: number; timeoutMs?: number; onResolved: (resolution: WaitResolution, ctx: StepContext<TState>) => NextStepTarget<TState>; onUnsatisfied?: (resolution: WaitResolution, ctx: StepContext<TState>) => NextStepTarget<TState> }): this {
    if ('dependencies' in spec) {
      this.handlers.set(name, () => ({ actions: [{ type: 'wait', spec: { ...spec, mode: spec.mode ?? 'all', ...(spec.quorum === undefined ? {} : { quorum: spec.quorum }), ...(spec.deadlineAt === undefined ? {} : { deadlineAt: spec.deadlineAt }), onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: spec.next }))
      return this
    }
    const resume = `${name}:resume`
    this.handlers.set(name, (ctx) => ({ actions: [{ type: 'wait', spec: { dependencies: spec.targets(ctx), mode: spec.mode ?? 'all', ...(spec.quorum === undefined ? {} : { quorum: spec.quorum }), ...(spec.timeoutMs === undefined ? {} : { deadlineAt: ctx.now + Math.max(0, spec.timeoutMs) }), onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: resume }))
    this.handlers.set(resume, (ctx) => {
      const resolution = ctx.resumeInput?.type === 'wait' ? ctx.resumeInput.resolution : undefined
      if (!resolution) throw Object.assign(new Error('WAIT_RESOLUTION_MISSING'), { code: 'WAIT_RESOLUTION_MISSING', retryable: false })
      if (resolution.status === 'satisfied') return { next: spec.onResolved(resolution, ctx) }
      if (spec.onUnsatisfied) return { next: spec.onUnsatisfied(resolution, ctx) }
      throw Object.assign(new Error(resolution.error?.message ?? 'WAIT_UNSATISFIED'), resolution.error ?? { code: 'WAIT_UNSATISFIED', retryable: false })
    })
    return this
  }
  addHumanStep<TOutput extends ZodTypeAny>(name: string, options: { prompt: string | ((view: InstructionView<TState>) => string); inputs?: (ctx: StepContext<TState>) => StepInputs; schema: TOutput; onReply: (reply: z.infer<TOutput>, ctx: StepContext<TState>) => NextStepTarget; onTimeout?: (ctx: StepContext<TState>) => NextStepTarget; timeoutMs?: number }): this {
    const decode = `${name}:decode`
    this.handlers.set(name, (ctx) => { const prompt = boundedInstruction(typeof options.prompt === 'string' ? options.prompt : options.prompt({ goal: ctx.goal, state: scalarProjection(ctx.laneState) as ScalarProjection<TState> })); const inputs = options.inputs?.(ctx) ?? {}; const inputResultRefs = [...new Set([...(inputs.results ?? []), ...(inputs.findings ?? []), ...(inputs.artifacts ?? [])])]; return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-human`, kind: 'human', concurrencyClass: 'none', input: asJson({ prompt, inputs }), ...(inputResultRefs.length ? { derivedFrom: inputResultRefs } : {}), ...(options.timeoutMs === undefined ? {} : { attemptTimeoutMs: options.timeoutMs }) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode } })
    this.handlers.set(decode, (ctx) => { const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined; const ref = dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined; const value = ref ? readResult(ctx, ref) : undefined; const parsed = options.schema.safeParse(value); if (parsed.success) return { next: options.onReply(parsed.data, ctx) }; return { next: options.onTimeout ? options.onTimeout(ctx) : decode } })
    return this
  }
  addTimerStep(name: string, options: { delayMs: number | ((ctx: StepContext<TState>) => number); onFire: (ctx: StepContext<TState>) => NextStepTarget }): this {
    const decode = `${name}:resume`
    this.handlers.set(name, (ctx) => ({ actions: [{ type: 'submit_effects', effects: [{ key: `${name}-timer`, kind: 'timer', concurrencyClass: 'none', input: { delayMs: typeof options.delayMs === 'number' ? options.delayMs : options.delayMs(ctx) } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode }))
    this.handlers.set(decode, (ctx) => ({ next: options.onFire(ctx) }))
    return this
  }
  build(entry = this.handlers.has('start') ? 'start' : [...this.handlers.keys()][0] ?? 'start'): LaneProgramDefinition {
    if (!this.handlers.has(entry)) this.handlers.set(entry, () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: entry }))
    const compaction = this.config.historyCompaction
    const compactSummarize = '$compact:summarize'
    const compactApply = '$compact:apply'
    if (compaction) {
      const keepRecentRounds = Math.max(0, Math.floor(compaction.keepRecentRounds))
      this.handlers.set(compactSummarize, (ctx) => {
        const candidates = ctx.history.slice(0, Math.max(0, ctx.history.length - keepRecentRounds))
        const upToSeq = candidates.at(-1)?.seq
        const locals = ordinaryLocals(ctx.lane.resume.locals)
        const sdk = sdkLocals(ctx.lane.resume.locals)
        const returnStep = typeof sdk.compactReturnStep === 'string' ? sdk.compactReturnStep : ctx.lane.resume.step
        if (upToSeq === undefined) return { next: returnStep === compactSummarize ? entry : returnStep, locals: { ...locals, $sdk: sdk } }
        return {
          actions: [{ type: 'submit_effects', effects: [{ key: '$compact-summary', kind: 'llm', concurrencyClass: 'llm', input: programLLMInput(this.config, { task: compaction.summarizeTask, historySeqs: candidates.map((record) => record.seq), upToSeq }) }], wait: { onUnsatisfied: 'resume_with_error' } }],
          next: compactApply,
          locals: { ...locals, $sdk: { ...sdk, compactPending: true, compactReturnStep: returnStep, compactUpToSeq: upToSeq } },
        }
      })
      this.handlers.set(compactApply, (ctx) => {
        const sdk = sdkLocals(ctx.lane.resume.locals)
        const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).find((item) => item.state === 'settled') : undefined
        const summaryRef = dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined
        const returnStep = typeof sdk.compactReturnStep === 'string' ? sdk.compactReturnStep : entry
        const upToSeq = typeof sdk.compactUpToSeq === 'number' ? sdk.compactUpToSeq : undefined
        const base = ordinaryLocals(ctx.lane.resume.locals)
        const nextSdk = { ...sdk }
        delete nextSdk.compactPending; delete nextSdk.compactReturnStep; delete nextSdk.compactUpToSeq
        if (!summaryRef || upToSeq === undefined) return { next: returnStep, locals: { ...base, $sdk: nextSdk } }
        return { contextDelta: { target: 'lane', baseVersion: ctx.lane.context.version, ops: [{ op: 'compact_history', upToSeq, summaryRef }] }, next: returnStep, locals: { ...base, $sdk: nextSdk } }
      })
    }
    const definition: LaneProgramDefinition = {
      id: this.config.id,
      version: this.config.version,
      entry,
      steps: [...this.handlers.keys()],
      debugSources: [...this.handlers.values()].map((handler) => handler.toString()),
      ...(this.config.system === undefined ? {} : { system: this.config.system }),
      ...(this.config.toolSet === undefined ? {} : { toolSet: this.config.toolSet }),
      step: (context) => {
        const sdk = sdkLocals(context.lane.resume.locals)
        const pressure = context.lane.historyPressure
        const shouldCompact = compaction !== undefined && !context.lane.resume.step.startsWith('$compact:') && context.lane.activeWaitId === undefined && sdk.compactPending !== true && pressure !== undefined && pressure.historyTokens > pressure.softTokens && context.lane.context.history.length > Math.max(0, Math.floor(compaction.keepRecentRounds))
        if (shouldCompact) return { actions: [], next: { programId: this.config.id, programVersion: this.config.version, step: compactSummarize, locals: { ...ordinaryLocals(context.lane.resume.locals), $sdk: { ...sdk, compactPending: true, compactReturnStep: context.lane.resume.step } } } }
        const requestedStep = shouldCompact ? compactSummarize : context.lane.resume.step
        const handler = this.handlers.get(requestedStep) ?? this.handlers.get(entry)!
        const state = this.config.state ? this.config.state.parse(context.lane.context.state) : context.lane.context.state as TState
        const { ctx, getDelta, getActions, getDerivedRefs, getAdoptImmediately } = makeContext(context, state)
        const result = handler(ctx)
        const derivedFrom = getDerivedRefs()
        const delta = result.contextDelta ?? getDelta()
        const derivedDelta = delta && delta.derivedFrom === undefined && derivedFrom.length ? { ...delta, derivedFrom } : delta
        const mergedDelta = derivedDelta && derivedFrom.length ? { ...derivedDelta, derivedFrom: [...new Set([...derivedFrom, ...(derivedDelta.derivedFrom ?? [])])] } : derivedDelta
        const destination = target(result.next, context.lane.resume.step)
        const actions = [...getActions(), ...(result.actions ?? []), ...(destination.action === undefined ? [] : [destination.action])].map((action) => annotateAction(action, derivedFrom))
        return { actions, next: { programId: this.config.id, programVersion: this.config.version, step: destination.step, locals: result.locals ?? ctx.lane.resume.locals }, ...(mergedDelta ? { contextDelta: mergedDelta } : {}), ...((result.adoptCommittedContext || getAdoptImmediately()) ? { adoptCommittedContext: true } : {}) }
      },
      ...(this.boundaryHandler === undefined ? {} : { errorBoundary: (error: RuntimeError, context: LaneStepContext): LaneStepOutput => { const state = this.config.state ? this.config.state.parse(context.lane.context.state) : context.lane.context.state as TState; const { ctx, getDelta, getActions, getDerivedRefs, getAdoptImmediately } = makeContext(context, state); const result = this.boundaryHandler!(error, ctx); const derivedFrom = getDerivedRefs(); const delta = getDelta(); const mergedDelta = delta && derivedFrom.length ? { ...delta, derivedFrom: [...new Set([...derivedFrom, ...(delta.derivedFrom ?? [])])] } : delta; const destination = target(result, context.lane.resume.step); const actions = [...getActions(), ...(destination.action === undefined ? [] : [destination.action])].map((action) => annotateAction(action, derivedFrom)); return { actions, next: { programId: this.config.id, programVersion: this.config.version, step: destination.step, locals: context.lane.resume.locals }, ...(mergedDelta ? { contextDelta: mergedDelta } : {}), ...(getAdoptImmediately() ? { adoptCommittedContext: true } : {}) } } })
    }
    return definition
  }
}

export function defineLaneProgram<TState = JsonValue>(config: { id: string; version: string; system?: string; toolSet?: string; state?: z.ZodType<TState>; historyCompaction?: HistoryCompactionOptions }, define: (builder: StepBuilder<TState>) => void): LaneProgramDefinition { const builder = new StepBuilder(config); define(builder); return builder.build() }

export function assertProgramPure(program: LaneProgramDefinition | LaneProgram): void {
  const candidate = program as LaneProgramDefinition
  const source = [program.step.toString(), program.errorBoundary?.toString() ?? '', ...(candidate.debugSources ?? []), program.seriesMemberProgram?.step.toString() ?? '', program.seriesMemberProgram?.errorBoundary?.toString() ?? ''].join('\n')
  for (const forbidden of ['Date.now(', 'Math.random(', 'fetch(', 'await ']) if (source.includes(forbidden)) throw new Error(`ASYNC_STEP_NOT_ALLOWED:${forbidden}`)
  if ((candidate.steps ?? []).some((step) => step.includes('undefined'))) throw new Error('INVALID_STEP_NAME')
}
