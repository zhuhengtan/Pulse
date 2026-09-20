import { describe, expect, it } from 'vitest'
import { ModelRouter, PulseRuntime, type LaneProgram, type LLMRequestProjection } from '@pulse/runtime'

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

  it('treats reasoning as a minimum capability instead of an exact label', () => {
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'low', providerId: 'local', tasks: ['reason'], capabilities: { local: true, reasoning: 'low', maxContextTokens: 4096 }, priority: 3 })
    runtime.models.register({ id: 'high', providerId: 'local', tasks: ['reason'], capabilities: { local: true, reasoning: 'high', maxContextTokens: 4096 }, priority: 1 })
    runtime.modelRouter.register({ task: 'reason', candidates: ['low', 'high'] })
    expect(runtime.modelRouter.route('reason', 'local_only', { reasoning: 'medium' }).map((candidate) => candidate.id)).toEqual(['high'])
    expect(runtime.modelRouter.diagnostics('reason', 'local_only', { reasoning: 'medium' })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'low', accepted: false, reasons: ['CAPABILITY_MISSING:reasoning'] })]))
  })

  it('enforces an explicit minimum context size in route admission', () => {
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'small', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 2 })
    runtime.models.register({ id: 'large', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 16384 }, priority: 1 })
    runtime.modelRouter.register({ task: 'reason', candidates: ['small', 'large'] })
    expect(runtime.modelRouter.route('reason', 'local_only', { contextSize: 8192 }).map((candidate) => candidate.id)).toEqual(['large'])
    expect(runtime.modelRouter.diagnostics('reason', 'local_only', { contextSize: 8192 })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'small', accepted: false, reasons: ['CONTEXT_WINDOW_TOO_SMALL'] })]))
  })

  it('reuses a supplied router registry when only a router is configured', () => {
    const router = new ModelRouter({ register: () => {}, list: () => [{ id: 'local:only', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 }] })
    const runtime = new PulseRuntime({ modelRouter: router, programs: [program] })
    expect(runtime.models).toBe(router.registry)
    expect(runtime.modelRouter).toBe(router)
  })

  it('executes an LLM Effect through the Adapter bound to a registered model', async () => {
    const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'public', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'public', privacyRefs: [] }
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'local:primary', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1, adapter: { executeAttempt: async () => ({ text: 'registered result', toolCalls: [], finishReason: 'stop' }) } })
    runtime.modelRouter.register({ task: 'reason', candidates: ['local:primary'] })
    const program: LaneProgram = { id: 'registered-model-execution', version: '1', step: ({ lane }) => lane.resume.step === 'start' ? { actions: [{ type: 'submit_effects', effects: [{ key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'registered-model-execution', programVersion: '1', step: 'finish', locals: {} } } : { actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'registered-model-execution', programVersion: '1', step: 'finish', locals: {} } } }
    const { agentId } = runtime.createAgent('registered model', program)
    await expect(runtime.start(agentId).outcome()).resolves.toMatchObject({ status: 'succeeded' })
    expect([...runtime.state.results.values()].some((result) => result.value && typeof result.value === 'object' && !Array.isArray(result.value) && result.value.text === 'registered result')).toBe(true)
  })

  it('fails a refusal and falls back to the next registered model', async () => {
    const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'public', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'public', privacyRefs: [] }
    const runtime = new PulseRuntime()
    const calls: string[] = []
    runtime.models.register({ id: 'refusing', providerId: 'p1', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 2, adapter: { executeAttempt: async () => { calls.push('refusing'); return { text: '', refusal: 'no', toolCalls: [], finishReason: 'refusal' } } } })
    runtime.models.register({ id: 'fallback', providerId: 'p2', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 1, adapter: { executeAttempt: async () => { calls.push('fallback'); return { text: 'ok', toolCalls: [], finishReason: 'stop' } } } })
    runtime.modelRouter.register({ task: 'reason', candidates: ['refusing', 'fallback'] })
    const effect = { id: 'effect-refusal', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as any
    await expect((runtime as any).executor(effect, new AbortController().signal)).resolves.toMatchObject({ value: { text: 'ok' } })
    expect(calls).toEqual(['refusing', 'fallback'])
  })

  it('does not publish an adapter error as a successful Result', async () => {
    const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'public', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'public', privacyRefs: [] }
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'error-model', providerId: 'local', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1, adapter: { executeAttempt: async () => ({ text: '', toolCalls: [], finishReason: 'error' }) } })
    runtime.modelRouter.register({ task: 'reason', candidates: ['error-model'] })
    const effect = { id: 'effect-error', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as any
    await expect((runtime as any).executor(effect, new AbortController().signal)).resolves.toMatchObject({ status: 'failed', error: { code: 'MODEL_ERROR' } })
  })

  it('enforces structured output capability and schema contract in the built-in executor', async () => {
    const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'public', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'public', privacyRefs: [] }
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    const calls: string[] = []
    const runtime = new PulseRuntime()
    runtime.models.register({ id: 'plain', providerId: 'p1', tasks: ['reason'], capabilities: { maxContextTokens: 4096, structuredOutput: false }, priority: 100, adapter: { executeAttempt: async () => { calls.push('plain'); return { text: '{"ok":true}', structured: { ok: true }, toolCalls: [], finishReason: 'stop' } } } })
    runtime.models.register({ id: 'structured', providerId: 'p2', tasks: ['reason'], capabilities: { maxContextTokens: 4096, structuredOutput: true }, priority: 1, adapter: { executeAttempt: async () => { calls.push('structured'); return { text: '{"ok":true}', structured: { ok: true }, toolCalls: [], finishReason: 'stop' } } } })
    runtime.modelRouter.register({ task: 'reason', candidates: ['plain', 'structured'] })
    const effect = { id: 'effect-structured', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection, outputSchema: schema, requirements: { structuredOutput: { schema } } }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as any
    await expect((runtime as any).executor(effect, new AbortController().signal)).resolves.toMatchObject({ value: { ok: true } })
    expect(calls).toEqual(['structured'])
  })
})
