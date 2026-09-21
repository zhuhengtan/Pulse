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

  it('publishes non-JSON Tool output as an ArtifactRef', async () => {
    const registry = new ToolRegistry()
    registry.register({ manifest: { name: 'binary', version: '1', description: 'returns binary output', inputSchema: { type: 'object' }, outputSchema: {}, concurrencyClass: 'tool', locks: [], supportsAbortSignal: true, sideEffectPolicy: 'none', retrySafety: 'read_only', defaultTimeoutMs: 1000 }, execute: () => new Uint8Array([0, 1, 2, 255]) })
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(registry) })
    const program: LaneProgram = { id: 'artifact-tool', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'binary', kind: 'tool', concurrencyClass: 'tool', input: { name: 'binary', arguments: {} } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('artifact-tool', 'finish') }
      : { actions: [{ type: 'complete', result: { done: true } }], next: point('artifact-tool', 'finish') } }
    const { agentId } = runtime.createAgent('binary output', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const result = [...runtime.state.results.values()].find((item) => item.effectId === 'effect-1')
    const artifactRef = result?.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value.artifactRef : undefined
    expect(typeof artifactRef).toBe('string')
    expect(runtime.state.artifacts.get(artifactRef as string)).toMatchObject({ mediaType: 'application/octet-stream', sizeBytes: 4 })
    expect([...runtime.readArtifact(artifactRef as string)]).toEqual([0, 1, 2, 255])
  })

  it('drops an oversized Tool summary while retaining the successful output', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'bounded-summary', description: 'bounded summary', input: z.object({}), output: z.object({ ok: z.boolean() }), maxResultSummaryBytes: 8, summarize: () => ({ text: '你好你好' }), execute: () => ({ ok: true }) }))
    const executor = createToolEffectExecutor(registry)
    const effect = { id: 'effect-summary', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'bounded-summary', kind: 'tool', concurrencyClass: 'tool', input: { name: 'bounded-summary', arguments: {} }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
    await expect(executor(effect, new AbortController().signal)).resolves.toMatchObject({ value: { ok: true }, executionState: 'succeeded' })
    await expect(registry.executeDetailed('bounded-summary', {}, new AbortController().signal)).resolves.toMatchObject({ output: { ok: true } })
    await expect(registry.executeDetailed('bounded-summary', {}, new AbortController().signal)).resolves.not.toHaveProperty('summary')
  })

  it('executes a registered typed tool and preserves tool correlation', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'add', version: '2', description: 'adds', input: z.object({ a: z.number(), b: z.number() }), output: z.object({ sum: z.number() }), normalize: (output) => ({ sum: output.sum }), summarize: (output) => ({ sum: output.sum }), execute: ({ a, b }, context) => { context.emit({ type: 'progress', data: { phase: 'computed' } }); return { sum: a + b } } }))
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
    expect(result?.normalized).toEqual({ sum: 5 })
    expect(runtime.observationInbox.snapshot()).toMatchObject([{ agentId, type: 'progress', data: { phase: 'computed' } }])
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.payload).includes('"toolVersion":"2"'))).toBe(true)
  })

  it('streams Tool observations before the Effect settles', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'progressive', description: 'emits progress while running', input: z.object({}), output: z.object({ ok: z.boolean() }), execute: async (_input, context) => {
      context.emit({ type: 'progress', data: { phase: 'started' } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { ok: true }
    } }))
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(registry) })
    const program: LaneProgram = { id: 'live-observation', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'progressive', kind: 'tool', concurrencyClass: 'tool', input: { name: 'progressive', arguments: {} } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('live-observation', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('live-observation', 'finish') } }
    const { agentId } = runtime.createAgent('live observation', program)
    const session = runtime.start(agentId)
    let liveObservation: import('@pulse/runtime').SessionEvent | undefined
    for await (const event of session.stream()) {
      if (event.kind === 'observation') {
        liveObservation = event
        break
      }
    }
    expect(liveObservation?.observation).toMatchObject({ type: 'progress', data: { phase: 'started' } })
    expect(runtime.state.effects.get('effect-1')?.outcome).toBeUndefined()
    await expect(session.outcome()).resolves.toMatchObject({ status: 'succeeded' })
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

  it('keeps a cancelled external Tool in remote-unknown state', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'external-job', description: 'remote external job', input: z.object({}), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'external', execute: async (_input, context) => { await new Promise<void>((_resolve, reject) => { context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) }); return { ok: true } } }))
    const controller = new AbortController()
    const executor = createToolEffectExecutor(registry)
    const effect = { id: 'effect-external', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'external-job', kind: 'tool', concurrencyClass: 'tool', input: { name: 'external-job', arguments: {} }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
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
    expect(prepared).toMatchObject({ sideEffectPolicy: 'write', toolVersion: '1', attemptTimeoutMs: 2500, locks: [{ resource: 'file:a.txt', mode: 'exclusive' }] })
  })

  it('rejects invalid tool input during admission before queueing or execution', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'typed-write', description: 'typed write', input: z.object({ path: z.string() }), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'write', resolveResources: ({ path }) => [{ resource: `file:${path}`, mode: 'exclusive' }], execute: () => ({ ok: true }) }))
    const prepare = createToolEffectSubmissionPreparer(registry)
    expect(() => prepare({ key: 'invalid', kind: 'tool', concurrencyClass: 'tool', input: { name: 'typed-write', arguments: {} } })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    expect(() => prepare({ key: 'missing-name', kind: 'tool', concurrencyClass: 'tool', input: {} })).toThrow('INVALID_TOOL_EFFECT_INPUT')
    let executed = false
    const runtime = new PulseRuntime({ effectSubmissionPreparer: prepare, effectExecutor: async () => { executed = true; return { value: { ok: true } } } })
    const program: LaneProgram = { id: 'invalid-tool-input', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'invalid', kind: 'tool', concurrencyClass: 'tool', input: { name: 'typed-write', arguments: {} } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('invalid-tool-input', 'done') }) }
    const { agentId } = runtime.createAgent('invalid input', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(executed).toBe(false)
    expect(runtime.state.events.some((event) => event.type === 'step.rejected' && JSON.stringify(event.data).includes('INVALID_TOOL_INPUT'))).toBe(true)
    expect(runtime.state.effects.size).toBe(0)
  })

  it('enforces JSON Schema for low-level manifest tools as well as defineTool tools', async () => {
    const registry = new ToolRegistry()
    registry.register({ manifest: { name: 'manual', version: '1', description: 'manual schema', inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'integer', minimum: 1 } }, additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false }, concurrencyClass: 'tool', locks: [], supportsAbortSignal: true, sideEffectPolicy: 'none', retrySafety: 'read_only', defaultTimeoutMs: 1000 }, execute: () => ({ ok: 'yes' }) })
    expect(() => registry.admission('manual', { value: 0 })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    const executor = createToolEffectExecutor(registry)
    await expect(registry.execute('manual', { value: 0 }, new AbortController().signal)).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    await expect(registry.executeDetailed('manual', { value: 0 }, new AbortController().signal)).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    const effect = { id: 'manual-effect', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'manual', kind: 'tool', concurrencyClass: 'tool', input: { name: 'manual', arguments: { value: 1 } }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
    await expect(registry.execute('manual', { value: 1 }, new AbortController().signal)).rejects.toThrowError(expect.objectContaining({ code: 'TOOL_OUTPUT_SCHEMA_VIOLATION' }))
    await expect(executor(effect, new AbortController().signal)).rejects.toThrowError(expect.objectContaining({ code: 'TOOL_OUTPUT_SCHEMA_VIOLATION' }))
  })

  it('validates low-level executionRef input before deriving a remote identity', () => {
    const definition = {
      manifest: { name: 'ref-input', version: '1', description: 'validated execution reference', inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false }, outputSchema: {}, concurrencyClass: 'tool' as const, locks: [], supportsAbortSignal: true, sideEffectPolicy: 'external' as const, retrySafety: 'unsafe' as const, defaultTimeoutMs: 1000,
      },
      executionRef: (input: { value: string }) => `ref:${input.value}`,
      resolveResources: (input: { value: string }) => [{ resource: `value:${input.value}`, mode: 'shared' as const }],
      execute: () => ({ ok: true }),
    }
    const context = { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: new AbortController().signal, emit: () => {} }
    const runtimeRegistry = new PulseRuntime().tools
    runtimeRegistry.register(definition)
    expect(() => runtimeRegistry.executionRef('ref-input', { value: 1 }, context)).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    const sdkRegistry = new ToolRegistry()
    sdkRegistry.register(definition as never)
    expect(() => sdkRegistry.executionRef('ref-input', { value: 1 }, context)).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    expect(() => runtimeRegistry.resolveResources('ref-input', { value: 1 })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    expect(() => sdkRegistry.resolveResources('ref-input', { value: 1 })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }))
    expect(sdkRegistry.resolveResources('ref-input', { value: 'ok' })).toEqual([{ resource: 'value:ok', mode: 'shared' }])
  })

  it('rejects malformed dynamic resource locks at the Tool Registry boundary', () => {
    const definition = {
      manifest: { name: 'bad-resources', version: '1', description: 'malformed dynamic resources', inputSchema: {}, outputSchema: {}, concurrencyClass: 'tool' as const, locks: [], supportsAbortSignal: true, sideEffectPolicy: 'write' as const, retrySafety: 'unsafe' as const, defaultTimeoutMs: 1000 },
      resolveResources: () => [{ resource: '', mode: 'shared' }],
      execute: () => ({ ok: true }),
    }
    const runtimeRegistry = new PulseRuntime().tools
    runtimeRegistry.register(definition)
    expect(() => runtimeRegistry.resolveResources('bad-resources', {})).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_RESOURCE_LOCKS', retryable: false }))
    const sdkRegistry = new ToolRegistry()
    sdkRegistry.register(definition as never)
    expect(() => sdkRegistry.resolveResources('bad-resources', {})).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_RESOURCE_LOCKS', retryable: false }))
  })

  it('rejects non-JSON execution refs, normalized outputs, and reconcile outputs', async () => {
    const definition = {
      manifest: { name: 'bad-json-contracts', version: '1', description: 'bad JSON contracts', inputSchema: {}, outputSchema: {}, concurrencyClass: 'tool' as const, locks: [], supportsAbortSignal: true, sideEffectPolicy: 'external' as const, retrySafety: 'unsafe' as const, defaultTimeoutMs: 1000 },
      executionRef: () => new Date() as never,
      normalize: () => new Date() as never,
      reconcile: async () => ({ status: 'succeeded' as const, output: new Date() }),
      execute: () => ({ ok: true }),
    }
    const runtimeRegistry = new PulseRuntime().tools
    runtimeRegistry.register(definition)
    const context = { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: new AbortController().signal, emit: () => {} }
    expect(() => runtimeRegistry.executionRef('bad-json-contracts', {}, context)).toThrowError(expect.objectContaining({ code: 'TOOL_EXECUTION_REF_INVALID' }))
    await expect(runtimeRegistry.executeDetailed('bad-json-contracts', {}, context)).rejects.toThrowError(expect.objectContaining({ code: 'TOOL_NORMALIZED_OUTPUT_INVALID' }))
    await expect(runtimeRegistry.reconcileDetailed('bad-json-contracts', 'ref', context)).rejects.toThrowError(expect.objectContaining({ code: 'TOOL_RECONCILE_OUTPUT_INVALID' }))
    const sdkRegistry = new ToolRegistry()
    sdkRegistry.register(definition as never)
    expect(() => sdkRegistry.executionRef('bad-json-contracts', {}, context)).toThrowError(expect.objectContaining({ code: 'TOOL_EXECUTION_REF_INVALID' }))
    await expect(sdkRegistry.executeDetailed('bad-json-contracts', {}, context)).rejects.toThrowError(expect.objectContaining({ code: 'TOOL_NORMALIZED_OUTPUT_INVALID' }))
    await expect(sdkRegistry.reconcileDetailed('bad-json-contracts', 'ref', context)).rejects.toThrowError(expect.objectContaining({ code: 'TOOL_RECONCILE_OUTPUT_INVALID' }))
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
