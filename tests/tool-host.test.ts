import { describe, expect, it } from 'vitest'
import { createToolEffectExecutor, createToolEffectSubmissionPreparer, reconcileToolEffect } from '@pulse/adapters'
import { defineTool, ToolError, ToolRegistry } from '@pulse/tool-sdk'
import { PulseRuntime } from '@pulse/runtime'
import type { EffectRecord, LaneProgram } from '@pulse/runtime'
import { z } from 'zod'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('Tool SDK to Runtime Effect host', () => {
  it('preserves a non-retryable ToolError and prevents duplicate attempts', async () => {
    let calls = 0
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'permanent-failure', description: 'fails permanently', input: z.object({}), output: z.object({ ok: z.boolean() }), execute: () => { calls += 1; throw new ToolError('PERMANENT_FAILURE', 'do not retry', { retryable: false, details: { source: 'tool' } }) } }))
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(registry) })
    const program: LaneProgram = { id: 'non-retryable-tool', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'permanent', kind: 'tool', concurrencyClass: 'tool', input: { name: 'permanent-failure', arguments: {} }, retryPolicy: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('non-retryable-tool', 'done') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('non-retryable-tool', 'done') } }
    const { agentId } = runtime.createAgent('permanent tool failure', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toBe(1)
    expect(runtime.state.effects.get('effect-1')?.attempts).toHaveLength(1)
    expect(runtime.state.effects.get('effect-1')?.outcome).toMatchObject({ error: { code: 'PERMANENT_FAILURE', retryable: false, details: { source: 'tool' } } })
  })

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

  it('carries a recoverable execution reference from a real write through cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-tool-reconcile-'))
    try {
      const target = join(directory, 'result.txt')
      const registry = new ToolRegistry()
      registry.register(defineTool({ name: 'write-file', description: 'write a file', input: z.object({ path: z.string(), content: z.string() }), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'write', executionRef: ({ path }) => path, reconcile: async (executionRef) => {
        try { await readFile(String(executionRef), 'utf8'); return { status: 'succeeded', output: { ok: true } } } catch { return { status: 'unknown' } }
      }, execute: async ({ path, content }, context) => { await writeFile(path, content, 'utf8'); await new Promise<void>((_resolve, reject) => { context.signal.addEventListener('abort', () => reject(new Error('cancelled after write')), { once: true }) }); return { ok: true } } }))
      const controller = new AbortController()
      const executor = createToolEffectExecutor(registry)
      const effect = { id: 'effect-file', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'write-file', kind: 'tool', concurrencyClass: 'tool', input: { name: 'write-file', arguments: { path: target, content: 'durable' } }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
      const pending = executor(effect, controller.signal)
      for (let attempt = 0; attempt < 20; attempt++) {
        try { if (await readFile(target, 'utf8') === 'durable') break } catch { /* write is still in flight */ }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(await readFile(target, 'utf8')).toBe('durable')
      controller.abort()
      const execution = await pending
      expect(execution.executionRef).toBe(target)
      await expect(reconcileToolEffect(registry, { ...effect, executionRef: execution.executionRef } as EffectRecord, new AbortController().signal)).resolves.toEqual({ status: 'succeeded', output: { ok: true } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('injects trusted manifest locks, side-effect policy, and timeout before admission', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'write-file', description: 'write', input: z.object({ path: z.string() }), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'write', defaultTimeoutMs: 2500, resolveResources: ({ path }) => [{ resource: `file:${path}`, mode: 'exclusive' }], execute: () => ({ ok: true }) }))
    const prepare = createToolEffectSubmissionPreparer(registry)
    const prepared = prepare({ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: { name: 'write-file', arguments: { path: 'a.txt' } } })
    expect(prepared).toMatchObject({ sideEffectPolicy: 'write', attemptTimeoutMs: 2500, locks: [{ resource: 'file:a.txt', mode: 'exclusive' }] })
  })

  it('compiles dynamic tool discovery into a versioned Context ToolSet', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'read-file', description: 'read a file', tags: ['filesystem', 'read'], input: z.object({ path: z.string() }), output: z.object({ text: z.string() }), execute: () => ({ text: '' }) }))
    registry.register(defineTool({ name: 'write-file', description: 'write a file', tags: ['filesystem', 'write'], input: z.object({ path: z.string() }), output: z.object({ ok: z.boolean() }), execute: () => ({ ok: true }) }))
    let captured: import('@pulse/runtime').EffectRecord | undefined
    const runtime = new PulseRuntime({
      effectSubmissionPreparer: createToolEffectSubmissionPreparer(registry),
      effectExecutor: async (effect) => { captured = structuredClone(effect); return { value: { ok: true } } },
    })
    const program: LaneProgram = { id: 'dynamic-tools', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', instruction: 'choose a file tool', toolDiscovery: { tags: ['read'], limit: 1 } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('dynamic-tools', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('dynamic-tools', 'finish') } }
    const { agentId } = runtime.createAgent('dynamic tools', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const input = captured?.input as Record<string, import('@pulse/runtime').JsonValue>
    expect(input.toolSetId).toMatch(/^dynamic@[0-9a-f]{16}$/)
    expect(input.tools).toEqual({ tools: [{ name: 'read-file', description: 'read a file', inputSchema: expect.any(Object) }] })
    const request = input.request as Record<string, import('@pulse/runtime').JsonValue>
    expect((request.blocks as Array<{ kind: string; content: import('@pulse/runtime').JsonValue }>).find((block) => block.kind === 'tools')?.content).toEqual(input.tools)
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
