import type { JsonValue } from '../core/types.js'
import { defineLaneProgram, type LaneProgramDefinition, type StepContext } from './program.js'

export function defineReActLane(config: { id: string; version?: string; instruction: string; maxTurns?: number }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addReActLoopStep('react', { instruction: config.instruction, ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }), onFinish: () => 'finish', onMaxTurns: () => 'finish' }); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
}

export function defineSeriesLane(config: { id: string; version?: string; steps: string[] }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { config.steps.forEach((step, index) => builder.addStep(step, () => ({ actions: [{ type: 'complete', result: { step } }], next: config.steps[index + 1] ?? 'finish' }))); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
}

export function definePlanAndExecuteLane(config: { id: string; version?: string; planInstruction: string; workers: Record<string, { goal: string; programId: string; programVersion?: string }> }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addStructuredLLMStep('plan', { task: 'plan', instruction: config.planInstruction, schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never, onSuccess: () => 'dispatch' }); builder.addParallelStep('dispatch', { lanes: Object.fromEntries(Object.entries(config.workers).map(([key, value]) => [key, { goal: value.goal, program: { programId: value.programId, programVersion: value.programVersion ?? '1' } }])), next: 'finish' }); builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' })) })
}

export function defineScatterGatherLane(config: { id: string; version?: string; workers: Record<string, { goal: string; programId: string; programVersion?: string }>; onGather?: (results: JsonValue, ctx: StepContext) => string }): LaneProgramDefinition {
  return defineLaneProgram({ id: config.id, version: config.version ?? '1' }, (builder) => { builder.addParallelStep('scatter', { lanes: Object.fromEntries(Object.entries(config.workers).map(([key, value]) => [key, { goal: value.goal, program: { programId: value.programId, programVersion: value.programVersion ?? '1' } }])), next: 'gather' }); builder.addStep('gather', (ctx) => ({ actions: [{ type: 'complete', result: { gathered: true } }], next: config.onGather?.([], ctx) ?? 'gather' })) })
}
