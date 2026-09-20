import { describe, expect, it } from 'vitest'
import { ModelRouter, PulseRuntime, type LaneProgram } from '@pulse/runtime'

const program: LaneProgram = { id: 'runtime-model-registry', version: '1', step: () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'runtime-model-registry', programVersion: '1', step: 'start', locals: {} } }) }

describe('Runtime model registry and task routes', () => {
  it('exposes the architecture registry and explicit task route API', () => {
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'cloud:primary', providerId: 'provider', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 99 })
    runtime.models.register({ id: 'local:backup', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 })
    runtime.modelRouter.register({ task: 'reason', candidates: ['local:backup', 'cloud:primary'] })

    expect(runtime.modelRouter.route('reason', 'cloud_allowed').map((candidate) => candidate.id)).toEqual(['local:backup', 'cloud:primary'])
    expect(runtime.modelRouter.route('reason', 'local_only').map((candidate) => candidate.id)).toEqual(['local:backup'])
    expect(runtime.modelRouter.diagnostics('reason', 'cloud_allowed')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'local:backup', accepted: true }), expect.objectContaining({ id: 'cloud:primary', accepted: true })]))
  })

  it('explains candidates excluded by an explicit task route', () => {
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'not-selected', providerId: 'provider', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 10 })
    runtime.models.register({ id: 'selected', providerId: 'provider', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 1 })
    runtime.modelRouter.register({ task: 'reason', candidates: ['selected'] })
    expect(runtime.modelRouter.diagnostics('reason', 'cloud_allowed')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'not-selected', accepted: false, reasons: ['TASK_ROUTE_EXCLUDED'] })]))
  })

  it('reuses a supplied router registry when only a router is configured', () => {
    const router = new ModelRouter({ register: () => {}, list: () => [{ id: 'local:only', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 }] })
    const runtime = new PulseRuntime({ modelRouter: router, programs: [program] })
    expect(runtime.models).toBe(router.registry)
    expect(runtime.modelRouter).toBe(router)
  })
})
