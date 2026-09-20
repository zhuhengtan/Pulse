import { describe, expect, it } from 'vitest'
import { createToolEffectExecutor, createToolEffectSubmissionPreparer, reconcileToolEffect } from '@pulse/adapters'
import { defineTool, ToolRegistry } from '@pulse/tool-sdk'
import { PulseRuntime } from '@pulse/runtime'
import type { EffectRecord, LaneProgram } from '@pulse/runtime'
import { z } from 'zod'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('Tool SDK to Runtime Effect host', () => {
  it('executes a registered typed tool and preserves tool correlation', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'add', version: '2', description: 'adds', input: z.object({ a: z.number(), b: z.number() }), output: z.object({ sum: z.number() }), summarize: (output) => ({ sum: output.sum }), execute: ({ a, b }, context) => { context.emit({ type: 'progress', data: { phase: 'computed' } }); return { sum: a + b } } }))
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(registry) })
    const program: LaneProgram = { id: 'tool-host', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'add-call', toolCallId: 'pulse-tool-1', kind: 'tool', concurrencyClass: 'tool', input: { name: 'add', arguments: { a: 2, b: 3 } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('tool-host', 'finish') }
      : { actions: [{ type: 'complete', result: { result: resumeInput?.type === 'wait' ? resumeInput.resolution.dependencies['add-call'] : null } }], next: point('tool-host', 'finish') } }
    const { agentId } = runtime.createAgent('tool', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect([...runtime.state.results.values()].some((result) => JSON.stringify(result.value).includes('result'))).toBe(true)
    expect(runtime.state.effects.get('effect-1')?.toolCallId).toBe('pulse-tool-1')
    const result = [...runtime.state.results.values()].find((item) => item.effectId === 'effect-1')
    expect(result?.summary).toEqual({ sum: 5 })
    expect(runtime.observationInbox.snapshot()).toMatchObject([{ agentId, type: 'progress', data: { phase: 'computed' } }])
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.payload).includes('"toolVersion":"2"'))).toBe(true)
  })

  it('rejects unknown tools through the normal dispatch failure path', async () => {
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(new ToolRegistry()) })
    const program: LaneProgram = { id: 'unknown-tool', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'missing', kind: 'tool', concurrencyClass: 'tool', input: { name: 'missing', arguments: {} } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('unknown-tool', 'done') }) }
    const { agentId } = runtime.createAgent('unknown', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'effect.dispatch_failed')).toBe(true)
  })

  it('reconciles an unknown write through the RecoverableTool contract', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'job', description: 'remote job', input: z.object({ id: z.string() }), output: z.object({ state: z.enum(['done', 'missing']) }), sideEffectPolicy: 'write', retrySafety: 'unsafe', reconcile: async (executionRef) => ({ status: executionRef === 'job-1' ? 'succeeded' : 'unknown', output: { state: 'done' } }), execute: () => ({ state: 'done' }) }))
    const effect = { id: 'effect-1', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'job', kind: 'tool', concurrencyClass: 'tool', input: { name: 'job', arguments: { id: 'job-1' } }, executionRef: 'job-1', attemptId: 'attempt-1', attemptNo: 0, state: 'reconcile_required', executionState: 'remote_unknown', sideEffectState: 'unknown' } as unknown as EffectRecord
    await expect(reconcileToolEffect(registry, effect, new AbortController().signal)).resolves.toEqual({ status: 'succeeded', output: { state: 'done' } })
  })

  it('keeps a cancelled write Tool in remote-unknown state', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'write-job', description: 'remote write', input: z.object({}), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'write', execute: async (_input, context) => { await new Promise<void>((_resolve, reject) => { context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) }); return { ok: true } } }))
    const controller = new AbortController()
    const executor = createToolEffectExecutor(registry)
    const effect = { id: 'effect-2', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'write-job', kind: 'tool', concurrencyClass: 'tool', input: { name: 'write-job', arguments: {} }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as import('@pulse/runtime').EffectRecord
    const pending = executor(effect, controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ executionState: 'remote_unknown', sideEffectState: 'unknown' })
  })

  it('injects trusted manifest locks, side-effect policy, and timeout before admission', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'write-file', description: 'write', input: z.object({ path: z.string() }), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'write', defaultTimeoutMs: 2500, resolveResources: ({ path }) => [{ resource: `file:${path}`, mode: 'exclusive' }], execute: () => ({ ok: true }) }))
    const prepare = createToolEffectSubmissionPreparer(registry)
    const prepared = prepare({ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: { name: 'write-file', arguments: { path: 'a.txt' } } })
    expect(prepared).toMatchObject({ sideEffectPolicy: 'write', attemptTimeoutMs: 2500, locks: [{ resource: 'file:a.txt', mode: 'exclusive' }] })
  })

  it('lets Runtime reconcile a quarantined effect and publish its terminal outcome', async () => {
    const runtime = new PulseRuntime()
    runtime.state.effects.set('effect-3', { id: 'effect-3', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'job', kind: 'tool', concurrencyClass: 'tool', input: {}, executionRef: 'job-3', state: 'reconcile_required', attemptId: 'attempt-3', attemptNo: 1, executionState: 'remote_unknown', sideEffectState: 'unknown' })
    runtime.quarantine.add('effect-3', 0, 'in_doubt')
    await expect(runtime.reconcileEffectWith('effect-3', async (executionRef) => ({ status: executionRef === 'job-3' ? 'succeeded' : 'unknown', output: { reconciled: true } }))).resolves.toMatchObject({ status: 'succeeded', output: { reconciled: true } })
    expect(runtime.state.effects.get('effect-3')?.outcome).toMatchObject({ status: 'succeeded', resultRef: expect.any(String) })
    expect(runtime.quarantine.has('effect-3')).toBe(false)
  })
})
