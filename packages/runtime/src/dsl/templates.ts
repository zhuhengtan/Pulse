import { defineLaneProgram, type LaneProgramDefinition, type StepContext, type InstructionView, type NextStepTarget, type StepInputs } from './program.js'
import type { LaneProgram } from '../scheduler/runtime.js'
import type { Outcome, JsonValue } from '../core/types.js'
import type { ZodTypeAny } from 'zod'

export interface ProgramRef { programId: string; programVersion: string; step?: string; locals?: JsonValue }

export function defineReActLane(config: { id: string; version?: string; system?: string; toolSet?: string; task?: string; instruction: string | ((view: InstructionView<JsonValue>) => string); inputs?: (ctx: StepContext<JsonValue>) => StepInputs; toolAllow?: string[]; maxTurns?: number; outputSchema?: ZodTypeAny; requirements?: Record<string, JsonValue>; historyCompaction?: { summarizeTask: string; keepRecentRounds: number } }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1', ...(config.system === undefined ? {} : { system: config.system }), ...(config.toolSet === undefined ? {} : { toolSet: config.toolSet }), ...(config.historyCompaction === undefined ? {} : { historyCompaction: config.historyCompaction }) }, (builder) => {
    const onFinish = config.outputSchema === undefined
      ? { text: (resultRef: string) => ({ complete: { value: { textRef: resultRef } } }) }
      : { text: (resultRef: string) => ({ complete: { value: { textRef: resultRef } } }), structured: { schema: config.outputSchema, onParsed: (value: unknown) => ({ complete: { value: value as JsonValue } }) } }
    builder.addReActLoopStep('react', { ...(config.task === undefined ? {} : { task: config.task }), instruction: config.instruction, ...(config.inputs === undefined ? {} : { inputs: config.inputs }), ...(config.toolAllow === undefined ? {} : { toolAllow: config.toolAllow }), ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }), ...(config.outputSchema === undefined ? {} : { outputSchema: config.outputSchema }), ...(config.requirements === undefined ? {} : { requirements: config.requirements }), onFinish })
  })
}

export function defineSeriesLane(config: { id: string; version?: string; steps: string[] } | { id: string; version?: string; member: LaneProgram | ProgramRef; keys?: string[]; onMemberFailure?: 'continue' | 'abort' }): LaneProgramDefinition {
  if ('steps' in config) return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { config.steps.forEach((step, index) => builder.addStep(step, () => ({ actions: [{ type: 'complete', result: { step } }], next: config.steps[index + 1] ?? 'finish' }))); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
  const member = config.member
  const ref = 'id' in member ? { programId: member.id, programVersion: member.version, step: member.entry ?? 'start', locals: {} } : { programId: member.programId, programVersion: member.programVersion, step: member.step ?? 'start', locals: member.locals ?? {} }
  const wrapper = defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { results: {} } }], next: 'start' })) })
  wrapper.entry = 'start'
  wrapper.seriesMember = ref
  if ('id' in member && 'step' in member) wrapper.seriesMemberProgram = member
  wrapper.seriesKeys = [...(config.keys ?? ['member'])]
  wrapper.seriesOnMemberFailure = config.onMemberFailure ?? 'continue'
  return wrapper
}

export interface PlanWorker extends ProgramRef { goal?: string }
export interface PlanAndExecuteConfig {
  id: string
  version?: string
  system?: string
  toolSet?: string
  planInstruction?: string
  planner?: { task?: string; instruction: string; schema?: ZodTypeAny }
  workers: Record<string, PlanWorker | { goal: string; programId: string; programVersion?: string }>
  affinity?: 'collapse' | 'ack'
  synthesizer?: { task?: string; instruction: string | ((ctx: StepContext) => string); schema?: ZodTypeAny }
}

const permissiveSchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) } as never

export function definePlanAndExecuteLane(config: PlanAndExecuteConfig): LaneProgramDefinition {
  const planner = config.planner ?? { task: 'plan', instruction: config.planInstruction ?? 'Create an executable plan for the goal.' }
  const synthesizer = config.synthesizer ?? { task: 'merge', instruction: 'Synthesize the joined worker outcomes into a concise final report.' }
  return defineLaneProgram({ id: config.id, version: config.version ?? '1', ...(config.system === undefined ? {} : { system: config.system }), ...(config.toolSet === undefined ? {} : { toolSet: config.toolSet }) }, (builder) => {
    builder.addStructuredLLMStep('plan', {
      task: planner.task ?? 'plan',
      instruction: planner.instruction,
      schema: planner.schema ?? permissiveSchema,
      onSuccess: (plan, ctx) => {
        ctx.mutateLane((draft) => {
          if (draft && typeof draft === 'object' && !Array.isArray(draft)) (draft as Record<string, JsonValue>).plan = plan as JsonValue
        })
        return 'dispatch'
      },
    })
    builder.addDynamicForkStep('dispatch', {
      lanes: () => Object.fromEntries(Object.entries(config.workers).map(([key, worker]) => {
        const program = { programId: worker.programId, programVersion: worker.programVersion ?? '1', ...(!('step' in worker) || worker.step === undefined ? {} : { step: worker.step }), ...(!('locals' in worker) || worker.locals === undefined ? {} : { locals: worker.locals }) }
        return [key, { goal: 'goal' in worker && worker.goal !== undefined ? worker.goal : key, program }]
      })),
      affinity: config.affinity === 'ack' ? 'ack' : 'collapse',
      next: 'synthesize',
    })
    builder.addMergeStep('synthesize', {
      task: synthesizer.task ?? 'merge',
      instruction: synthesizer.instruction,
      ...(synthesizer.schema === undefined ? {} : { schema: synthesizer.schema }),
      sources: { proposals: 'joined', outcomes: 'joined' },
      onSynthesized: (report, ctx) => {
        ctx.commitGlobal({ ops: [{ op: 'set', path: ['synthesis'], value: report as JsonValue }], adoptImmediately: true })
        return 'finish'
      },
      next: 'finish',
    })
    builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: { ok: true, globalVersion: ctx.globalVersion } }], next: 'finish' }))
  })
}

export function defineScatterGatherLane<TItem>(config: { id: string; version?: string; items: (ctx: StepContext) => TItem[]; worker: ProgramRef; batch?: number; reducer: (outcomes: Outcome[], ctx: StepContext) => NextStepTarget }): LaneProgramDefinition {
  const batch = Math.max(1, Math.floor(config.batch ?? 1))
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => {
    builder.addDynamicForkStep('scatter', {
      lanes: (ctx) => {
        const items = config.items(ctx)
        const lanes: Record<string, { goal: string; program: ProgramRef; affinityKey?: string }> = {}
        for (let index = 0; index < items.length; index += batch) {
          const group = items.slice(index, index + batch)
          const key = `item-${index}`
          lanes[key] = { goal: JSON.stringify(group), program: { ...config.worker, locals: { items: group as unknown as JsonValue } } }
        }
        return lanes
      }, affinity: 'ack', onJoin: (outcomes, ctx) => config.reducer([...outcomes.values()], ctx), next: 'finish',
    })
    builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: { gathered: true, outcomes: (ctx.resumeInput?.type === 'wait' ? Object.fromEntries(Object.entries(ctx.resumeInput.resolution.dependencies).map(([key, value]) => [key, value.state === 'pending' ? null : value.outcome])) : {}) as unknown as JsonValue } }], next: 'finish' }))
  })
}
