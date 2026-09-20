import { z, type ZodTypeAny } from 'zod'
import type { LaneProgram, LaneStepContext } from '../scheduler/runtime.js'
import type { ContextDelta, JsonValue, LaneRecord, LaneStepOutput, ResultRef, RuntimeAction, RuntimeState, ResumeInput, HistoryRecord, ProgressWatchdogState, ContextOp, LaneId, PrivacyLabel, RuntimeError, MergeProposal, ResourceLockSpec, Outcome } from '../core/types.js'
import { createDraftProxy } from './context-proxy.js'

export type NextStepTarget<TState = unknown> = string | { step: string }
export interface InstructionView<TState> { goal: string; state: TState }
export interface StepInputs { results?: ResultRef[]; findings?: ResultRef[]; events?: string[] }
export interface HistoryCompactionOptions { summarizeTask: string; keepRecentRounds: number }
export interface HistoryRecordMeta { seq: number; resultRefs: ResultRef[]; privacy: PrivacyLabel }
export interface ResultMeta { ref: ResultRef; privacy: PrivacyLabel; derivedFrom: string[]; summary?: JsonValue }
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
  proposeGlobal(delta: { ops: ContextOp[]; privacy?: PrivacyLabel }): void
  commitGlobal(delta: { ops: ContextOp[]; privacy?: PrivacyLabel; adoptImmediately?: boolean }): void
  adoptContext(version: number | 'latest'): void
  cancelLane(target: LaneId, reason: 'SUPERSEDED' | 'USER_REQUESTED' | 'POLICY'): void
  proposeCancel(target: LaneId, reason: 'SUPERSEDED' | 'POLICY'): void
  trace(message: string | { kind: string; data?: JsonValue }): void
}

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

function target(step: NextStepTarget): string { return typeof step === 'string' ? step : step.step }
function clone<T>(value: T): T { return structuredClone(value) }
function asJson(value: unknown): JsonValue { return value as JsonValue }

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

function makeContext<TState>(context: LaneStepContext, initialState: TState): { ctx: StepContext<TState>; getDelta: () => ContextDelta | undefined; getActions: () => RuntimeAction[]; getDerivedRefs: () => ResultRef[]; getAdoptImmediately: () => boolean } {
  const draft = clone(initialState)
  const draftProxy = draft && typeof draft === 'object' && !Array.isArray(draft) ? createDraftProxy(draft as Record<string, unknown>) : undefined
  let delta: ContextDelta | undefined
  const actions: RuntimeAction[] = []
  const derivedRefs = new Set<ResultRef>()
  let adoptImmediately = false
  const agent = context.state.agents.get(context.lane.agentId)
  const globalVersion = context.lane.contextSnapshotVersion
  const global = clone(agent?.globalVersions.get(globalVersion) ?? {})
  const history = context.lane.context.history.map((record: HistoryRecord): HistoryRecordMeta => ({ seq: record.seq, resultRefs: [...record.resultRefs], privacy: record.privacy }))
  const resultMeta = (ref: ResultRef): ResultMeta | undefined => { const result = resultVisible(context, ref) ? context.state.results.get(ref) : undefined; if (result) derivedRefs.add(ref); return result ? { ref, privacy: result.privacy, derivedFrom: [...result.derivedFrom], ...(result.summary === undefined ? {} : { summary: clone(result.summary) }) } : undefined }
  const globalDelta = (value: { ops: ContextOp[]; privacy?: PrivacyLabel; proposal: boolean }): void => { delta = { target: 'global', baseVersion: agent?.latestGlobalVersion ?? 0, sourceLaneId: context.lane.id, ops: clone(value.ops), ...(value.privacy === undefined ? {} : { privacy: value.privacy }), proposal: value.proposal } }
  const ctx: InternalStepContext<TState> = {
    lane: context.lane, goal: context.lane.goal, global, globalVersion, laneState: draft, history, now: context.now, ...(context.lane.progressWatchdog === undefined ? {} : { watchdog: context.lane.progressWatchdog }), ...(context.resumeInput ? { resumeInput: context.resumeInput } : {}),
    [RESULT_READER]: (ref) => { if (context.state.results.has(ref) && resultVisible(context, ref)) derivedRefs.add(ref); return findResult(context, ref) },
    results: { meta: resultMeta, summary: (ref) => { if (context.state.results.has(ref) && resultVisible(context, ref)) derivedRefs.add(ref); return resultMeta(ref)?.summary } },
    mergeProposals: [...context.state.mergeProposals.values()].filter((proposal) => proposal.agentId === context.lane.agentId).map((proposal) => clone(proposal)),
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
    selfCorrect?: { maxRounds: 0 | 1 }
    onSuccess: (data: z.infer<TOutput>, ctx: StepContext<TState>) => NextStepTarget<TState>
    onError?: (error: Error, ctx: StepContext<TState>) => NextStepTarget<TState>
  }): this {
    const submit = `${name}:submit`; const decode = `${name}:decode`
    this.handlers.set(name, (ctx) => {
      const instruction = typeof options.instruction === 'string' ? options.instruction : options.instruction({ goal: ctx.goal, state: ctx.laneState })
      const inputs = options.inputs?.(ctx) ?? {}
      const inputResultRefs = [...new Set([...(inputs.results ?? []), ...(inputs.findings ?? [])])]
      const outputSchema = zodJsonSchema(options.schema)
      return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-llm`, kind: 'llm', concurrencyClass: 'llm', input: asJson({ task: options.task, instruction, inputs, outputSchema, requirements: { structuredOutput: true } }), ...(inputResultRefs.length ? { derivedFrom: inputResultRefs } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode }
    })
    this.handlers.set(submit, (ctx) => ({ next: decode }))
    this.handlers.set(decode, (ctx) => {
      const input = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).find((dependency) => dependency.state !== 'pending') : undefined
      const ref = input?.state === 'settled' ? input.outcome.resultRef : undefined
      const rejectedRef = input?.state === 'settled' ? input.outcome.rejectedOutputRefs?.[0] : undefined
      const value = rejectedRef ? readResult(ctx, rejectedRef) : ref ? readResult(ctx, ref) : undefined
      const parsed = options.schema.safeParse(value)
      if (!parsed.success) {
        if (options.selfCorrect?.maxRounds === 0) return { next: options.onError ? options.onError(new Error('OUTPUT_SCHEMA_VIOLATION'), ctx) : decode }
        const inputResultRefs = rejectedRef ? [rejectedRef] : []
        const outputSchema = zodJsonSchema(options.schema)
        return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-correct`, kind: 'llm', concurrencyClass: 'llm', input: { task: options.task, instruction: `${typeof options.instruction === 'string' ? options.instruction : 'structured'}\nValidation errors: ${parsed.error.message}`, inputs: { rejectedOutputRefs: inputResultRefs }, outputSchema, requirements: { structuredOutput: true } }, ...(inputResultRefs.length ? { derivedFrom: inputResultRefs } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode }
      }
      const next = options.onSuccess(parsed.data, ctx)
      return { next }
    })
    return this
  }
  addReActLoopStep(name: string, options: { task?: string; instruction: string | ((view: InstructionView<TState>) => string); inputs?: (ctx: StepContext<TState>) => StepInputs; toolAllow?: string[]; maxTurns?: number; onFinish: (resultRef: ResultRef, ctx: StepContext<TState>) => NextStepTarget<TState>; onMaxTurns?: (ctx: StepContext<TState>) => NextStepTarget<TState>; onError?: (error: Error, ctx: StepContext<TState>) => NextStepTarget<TState> }): this {
    const readTurns = (ctx: StepContext<TState>): number => { const sdk = sdkLocals(ctx.lane.resume.locals); const turn = sdk[`${name}Turns`]; return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : 0 }
    const writeTurns = (ctx: StepContext<TState>, turns: number): JsonValue => { const locals = ctx.lane.resume.locals; const base = locals && typeof locals === 'object' && !Array.isArray(locals) ? locals as Record<string, JsonValue> : {}; return { ...base, $sdk: { ...sdkLocals(locals), [`${name}Turns`]: turns } } }
    const resultRefFromWait = (ctx: StepContext<TState>): ResultRef | undefined => { const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined; return dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined }
    const resultRefsFromWait = (ctx: StepContext<TState>): ResultRef[] => ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).flatMap((dependency) => dependency.state === 'settled' && dependency.outcome.resultRef ? [dependency.outcome.resultRef] : []) : []
    const instruction = (ctx: StepContext<TState>): string => typeof options.instruction === 'string' ? options.instruction : options.instruction({ goal: ctx.goal, state: ctx.laneState })
    const submitModel = (ctx: StepContext<TState>, turn: number, resultRefs: ResultRef[] = []): LaneStepOutput => ({ actions: [{ type: 'submit_effects', effects: [{ key: `${name}-turn-${turn}`, kind: 'llm', concurrencyClass: 'llm', input: { task: options.task ?? 'reason', instruction: instruction(ctx), inputs: { results: resultRefs }, turn, ...(options.toolAllow === undefined ? {} : { requirements: { toolCalling: true } }) }, ...(resultRefs.length ? { derivedFrom: resultRefs } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: this.config.id, programVersion: this.config.version, step: `${name}:decode`, locals: writeTurns(ctx, turn) }, locals: writeTurns(ctx, turn) })
    this.handlers.set(name, (ctx) => { const turn = readTurns(ctx) + 1; const inputs = options.inputs?.(ctx) ?? {}; const refs = [...new Set([...(inputs.results ?? []), ...(inputs.findings ?? [])])]; const output = submitModel(ctx, turn, refs); return { ...output, next: `${name}:decode` } })
    this.handlers.set(`${name}:tools`, (ctx) => { const turn = readTurns(ctx); const refs = resultRefsFromWait(ctx); return { ...submitModel(ctx, turn + 1, refs), next: `${name}:decode` } })
    this.handlers.set(`${name}:decode`, (ctx) => {
      const turns = readTurns(ctx)
      const ref = resultRefFromWait(ctx)
      const value = ref ? readResult(ctx, ref) ?? null : null
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined
      const finishReason = record?.finishReason
      const toolCalls = Array.isArray(record?.toolCalls) ? record.toolCalls : []
      if (finishReason === 'tool_calls') {
        if (turns >= (options.maxTurns ?? 10) || toolCalls.length === 0) return { next: options.onMaxTurns ? options.onMaxTurns(ctx) : `${name}:decode` }
        const invalidTool = toolCalls.find((call) => { const item = call && typeof call === 'object' && !Array.isArray(call) ? call as Record<string, JsonValue> : {}; const toolName = typeof item.name === 'string' ? item.name : ''; return !toolName || (options.toolAllow !== undefined && !options.toolAllow.includes(toolName)) })
        if (invalidTool !== undefined) return { next: options.onError ? options.onError(new Error('ACTION_TOOL_NOT_ALLOWED'), ctx) : (options.onMaxTurns ? options.onMaxTurns(ctx) : `${name}:decode`) }
        const sourceEffectId = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).find((dependency) => dependency.state === 'settled' && dependency.target.kind === 'effect')?.target.id : undefined
        const effects = toolCalls.map((call, index) => {
          const item = call && typeof call === 'object' && !Array.isArray(call) ? call as Record<string, JsonValue> : {}
          const originalId = typeof item.toolCallId === 'string' ? item.toolCallId : `call-${index + 1}`
          const toolName = typeof item.name === 'string' ? item.name : ''
          return { key: `${name}-tool-${turns}-${index + 1}`, toolCallId: `${name}:${turns}:${originalId}`, ...(sourceEffectId === undefined ? {} : { llmEffectId: sourceEffectId }), kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { toolCallId: `${name}:${turns}:${originalId}`, name: toolName, arguments: item.input ?? {} } }
        })
        return { actions: [{ type: 'submit_effects', effects, wait: { onUnsatisfied: 'resume_with_error' } }], next: `${name}:tools` }
      }
      if (turns >= (options.maxTurns ?? 10)) return { next: options.onMaxTurns ? options.onMaxTurns(ctx) : `${name}:decode` }
      return ref ? { next: options.onFinish(ref, ctx) } : { next: options.onError ? options.onError(new Error('MISSING_RESULT_REF'), ctx) : `${name}:decode` }
    })
    return this
  }
  addParallelStep(name: string, options: { lanes: Record<string, { goal: string; program: { programId: string; programVersion: string; step?: string; locals?: JsonValue }; priority?: number; contextVersion?: 'parent' | 'latest' | number; affinityKey?: string; resources?: ResourceLockSpec[]; dependsOn?: Array<{ key: string; target: { local: string } | { kind: 'lane' | 'effect'; id: string }; condition: 'success' | 'settled' }> }>; condition?: 'success' | 'settled'; mode?: 'all' | 'any' | 'quorum'; quorum?: number; affinity?: 'collapse' | 'ack'; next?: NextStepTarget; onJoin?: (outcomes: Record<string, Outcome>, ctx: StepContext<TState>) => NextStepTarget }): this {
    const joinStep = `${name}:join`
    this.handlers.set(name, () => ({ actions: [{ type: 'fork', affinityAck: options.affinity === 'ack', lanes: Object.entries(options.lanes).map(([key, lane]) => ({ key, goal: lane.goal, program: { programId: lane.program.programId, programVersion: lane.program.programVersion, step: lane.program.step ?? 'start', locals: lane.program.locals ?? {} }, ...(lane.priority === undefined ? {} : { priority: lane.priority }), ...(lane.contextVersion === undefined ? {} : { contextVersion: lane.contextVersion }), ...(lane.affinityKey === undefined ? {} : { affinityKey: lane.affinityKey }), ...(lane.resources === undefined ? {} : { resources: lane.resources }), ...(lane.dependsOn ? { dependsOn: lane.dependsOn } : {}) })), join: { condition: options.condition ?? 'settled', mode: options.mode ?? 'all', ...(options.quorum === undefined ? {} : { quorum: options.quorum }), onUnsatisfied: 'resume_with_error' } }], next: options.onJoin ? joinStep : options.next ?? joinStep }));
    if (options.onJoin) this.handlers.set(joinStep, (ctx) => { const outcomes: Record<string, Outcome> = {}; if (ctx.resumeInput?.type === 'wait') for (const [key, dependency] of Object.entries(ctx.resumeInput.resolution.dependencies)) if (dependency.state !== 'pending') outcomes[key] = dependency.outcome; return { next: options.onJoin!(outcomes, ctx) } })
    return this
  }
  addDynamicForkStep(name: string, options: { lanes: (ctx: StepContext<TState>) => Record<string, { goal: string; program: { programId: string; programVersion: string }; affinityKey?: string; resources?: ResourceLockSpec[]; inputResultRefs?: ResultRef[] }>; condition?: 'success' | 'settled'; mode?: 'all' | 'any' | 'quorum'; quorum?: number; affinity?: 'collapse' | 'ack'; next?: NextStepTarget; onJoin?: (outcomes: Map<string, Outcome>, ctx: StepContext<TState>) => NextStepTarget }): this {
    const joinStep = `${name}:join`
    this.handlers.set(name, (ctx) => ({ actions: [{ type: 'fork', affinityAck: options.affinity === 'ack', lanes: Object.entries(options.lanes(ctx)).map(([key, lane]) => ({ key, goal: lane.goal, program: { ...lane.program, step: 'start', locals: {} }, ...(lane.affinityKey === undefined ? {} : { affinityKey: lane.affinityKey }), ...(lane.resources === undefined ? {} : { resources: lane.resources }), ...(lane.inputResultRefs === undefined ? {} : { inputResultRefs: lane.inputResultRefs }) })), join: { condition: options.condition ?? 'settled', mode: options.mode ?? 'all', ...(options.quorum === undefined ? {} : { quorum: options.quorum }), onUnsatisfied: 'resume_with_error' } }], next: options.onJoin ? joinStep : options.next ?? joinStep }));
    if (options.onJoin) this.handlers.set(joinStep, (ctx) => { const outcomes = new Map<string, Outcome>(); if (ctx.resumeInput?.type === 'wait') for (const [key, dependency] of Object.entries(ctx.resumeInput.resolution.dependencies)) if (dependency.state !== 'pending') outcomes.set(key, dependency.outcome); return { next: options.onJoin!(outcomes, ctx) } })
    return this
  }
  addMergeStep(name: string, options: { task: string; next: NextStepTarget; sources?: { proposals?: 'joined' | LaneId[]; outcomes?: 'joined' | LaneId[] }; instruction?: string | ((ctx: StepContext<TState>) => string); schema?: ZodTypeAny; onSynthesized?: (value: unknown, ctx: StepContext<TState>) => NextStepTarget }): this {
    this.handlers.set(name, (ctx) => {
      const dependencies = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies) : []
      const joinedLaneIds = new Set(dependencies.filter((dependency) => dependency.target.kind === 'lane').map((dependency) => dependency.target.id))
      const outcomeSource = options.sources?.outcomes
      const joined = dependencies.flatMap((dependency) => dependency.state === 'settled' && dependency.outcome.resultRef && (outcomeSource === undefined || outcomeSource === 'joined' || outcomeSource.includes(dependency.target.id)) ? [dependency.outcome.resultRef] : [])
      const proposalSource = options.sources?.proposals
      const proposals = ctx.mergeProposals.filter((proposal) => proposalSource === undefined || (proposalSource === 'joined' ? joinedLaneIds.has(proposal.sourceLaneId) : proposalSource.includes(proposal.sourceLaneId)))
      return { actions: [{ type: 'submit_effects', effects: [{ key: `${name}-llm`, kind: 'llm', concurrencyClass: 'llm', input: asJson({ task: options.task, merge: true, sources: joined, proposals: proposals.map((proposal) => ({ id: proposal.id, sourceLaneId: proposal.sourceLaneId, delta: proposal.delta })), ...(options.instruction === undefined ? {} : { instruction: typeof options.instruction === 'string' ? options.instruction : options.instruction(ctx) }) }), ...(joined.length ? { derivedFrom: joined } : {}) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: `${name}:decode` }
    })
    this.handlers.set(`${name}:decode`, (ctx) => {
      const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined
      const ref = dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined
      const value = ref ? readResult(ctx, ref) : undefined
      if (options.schema) {
        const parsed = options.schema.safeParse(value)
        if (!parsed.success) return { next: options.next }
        return { next: options.onSynthesized ? options.onSynthesized(parsed.data, ctx) : options.next }
      }
      return { next: options.onSynthesized ? options.onSynthesized(value, ctx) : options.next }
    })
    return this
  }
  addWaitStep(name: string, spec: { dependencies: Array<{ key: string; target: { kind: 'lane' | 'effect'; id: string }; condition: 'success' | 'settled' }>; mode?: 'all' | 'any' | 'quorum'; quorum?: number; deadlineAt?: number; next: NextStepTarget }): this { this.handlers.set(name, () => ({ actions: [{ type: 'wait', spec: { ...spec, mode: spec.mode ?? 'all', ...(spec.quorum === undefined ? {} : { quorum: spec.quorum }), ...(spec.deadlineAt === undefined ? {} : { deadlineAt: spec.deadlineAt }), onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: spec.next })); return this }
  addHumanStep<TOutput extends ZodTypeAny>(name: string, options: { prompt: string | ((view: InstructionView<TState>) => string); schema: TOutput; onReply: (reply: z.infer<TOutput>, ctx: StepContext<TState>) => NextStepTarget; onTimeout?: (ctx: StepContext<TState>) => NextStepTarget; timeoutMs?: number }): this {
    const decode = `${name}:decode`
    this.handlers.set(name, (ctx) => ({ actions: [{ type: 'submit_effects', effects: [{ key: `${name}-human`, kind: 'human', concurrencyClass: 'none', input: asJson({ prompt: typeof options.prompt === 'string' ? options.prompt : options.prompt({ goal: ctx.goal, state: ctx.laneState }) }), ...(options.timeoutMs === undefined ? {} : { attemptTimeoutMs: options.timeoutMs }) }], wait: { onUnsatisfied: 'resume_with_error' } }], next: decode }))
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
          actions: [{ type: 'submit_effects', effects: [{ key: '$compact-summary', kind: 'llm', concurrencyClass: 'llm', input: { task: compaction.summarizeTask, historySeqs: candidates.map((record) => record.seq), upToSeq } }], wait: { onUnsatisfied: 'resume_with_error' } }],
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
        const annotate = (action: RuntimeAction): RuntimeAction => {
          if (!derivedFrom.length) return action
          if (action.type === 'complete' || action.type === 'fail') return action.derivedFrom === undefined ? { ...action, derivedFrom } : action
          if (action.type === 'submit_effects') return { ...action, effects: action.effects.map((effect) => effect.derivedFrom === undefined ? { ...effect, derivedFrom } : effect) }
          return action
        }
        const delta = result.contextDelta ?? getDelta()
        const derivedDelta = delta && delta.derivedFrom === undefined && derivedFrom.length ? { ...delta, derivedFrom } : delta
        return { actions: [...getActions(), ...(result.actions ?? [])].map(annotate), next: { programId: this.config.id, programVersion: this.config.version, step: target(result.next), locals: result.locals ?? ctx.lane.resume.locals }, ...(derivedDelta ? { contextDelta: derivedDelta } : {}), ...((result.adoptCommittedContext || getAdoptImmediately()) ? { adoptCommittedContext: true } : {}) }
      },
      ...(this.boundaryHandler === undefined ? {} : { errorBoundary: (error: RuntimeError, context: LaneStepContext): LaneStepOutput => { const state = this.config.state ? this.config.state.parse(context.lane.context.state) : context.lane.context.state as TState; const { ctx, getDelta, getActions, getAdoptImmediately } = makeContext(context, state); const result = this.boundaryHandler!(error, ctx); const isFailure = typeof result === 'object' && result !== null && 'fail' in result; const delta = getDelta(); const next = isFailure ? context.lane.resume.step : target(result as NextStepTarget<TState>); return { actions: [...getActions(), ...(isFailure ? [{ type: 'fail' as const, error: (result as { fail: RuntimeError }).fail }] : [])], next: { programId: this.config.id, programVersion: this.config.version, step: next, locals: context.lane.resume.locals }, ...(delta ? { contextDelta: delta } : {}), ...(getAdoptImmediately() ? { adoptCommittedContext: true } : {}) } } })
    }
    return definition
  }
}

export function defineLaneProgram<TState = JsonValue>(config: { id: string; version: string; system?: string; toolSet?: string; state?: z.ZodType<TState>; historyCompaction?: HistoryCompactionOptions }, define: (builder: StepBuilder<TState>) => void): LaneProgramDefinition { const builder = new StepBuilder(config); define(builder); return builder.build() }

export function assertProgramPure(program: LaneProgramDefinition): void {
  const source = [program.step.toString(), ...(program.debugSources ?? [])].join('\n')
  for (const forbidden of ['Date.now(', 'Math.random(', 'fetch(', 'await ']) if (source.includes(forbidden)) throw new Error(`ASYNC_STEP_NOT_ALLOWED:${forbidden}`)
  if (program.steps.some((step) => step.includes('undefined'))) throw new Error('INVALID_STEP_NAME')
}
