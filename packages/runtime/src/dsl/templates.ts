import { defineLaneProgram, type LaneProgramDefinition, type StepContext } from './program.js'
import type { LaneProgram } from '../scheduler/runtime.js'
import type { Outcome, JsonValue } from '../core/types.js'

export interface ProgramRef { programId: string; programVersion: string; step?: string; locals?: JsonValue }

export function defineReActLane(config: { id: string; version?: string; instruction: string; maxTurns?: number }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addReActLoopStep('react', { instruction: config.instruction, ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }), onFinish: () => 'finish', onMaxTurns: () => 'finish' }); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
}

export function defineSeriesLane(config: { id: string; version?: string; steps: string[] } | { id: string; version?: string; member: LaneProgram | ProgramRef; keys?: string[]; onMemberFailure?: 'continue' | 'abort' }): LaneProgramDefinition {
  if ('steps' in config) return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { config.steps.forEach((step, index) => builder.addStep(step, () => ({ actions: [{ type: 'complete', result: { step } }], next: config.steps[index + 1] ?? 'finish' }))); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
  const member = config.member
  const ref = 'id' in member ? { programId: member.id, programVersion: member.version } : { programId: member.programId, programVersion: member.programVersion }
  const wrapper = defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { results: {} } }], next: 'start' })) })
  wrapper.entry = 'start'
  wrapper.seriesMember = ref
  if ('id' in member && 'step' in member) wrapper.seriesMemberProgram = member
  wrapper.seriesKeys = [...(config.keys ?? ['member'])]
  wrapper.seriesOnMemberFailure = config.onMemberFailure ?? 'continue'
  return wrapper
}

export function definePlanAndExecuteLane(config: { id: string; version?: string; planInstruction: string; workers: Record<string, { goal: string; programId: string; programVersion?: string }> }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addStructuredLLMStep('plan', { task: 'plan', instruction: config.planInstruction, schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never, onSuccess: () => 'dispatch' }); builder.addParallelStep('dispatch', { lanes: Object.fromEntries(Object.entries(config.workers).map(([key, value]) => [key, { goal: value.goal, program: { programId: value.programId, programVersion: value.programVersion ?? '1' } }])), next: 'finish' }); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
}

export function defineScatterGatherLane<TItem>(config: { id: string; version?: string; items: (ctx: StepContext) => TItem[]; worker: ProgramRef; batch?: number; reducer: (outcomes: Outcome[], ctx: StepContext) => string | { step: string } }): LaneProgramDefinition {
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
