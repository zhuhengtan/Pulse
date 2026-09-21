import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ContextBuilder, InMemoryModelRegistry, ModelFallbackController, ModelRouter, OutputValidationError, PulseRuntime, appendHistory, createAgent, createRuntimeState, modelFallbackError, stableSerialize, validateActionToolCalls, validateAdapterResult, validateStructuredOutput, MemoryStorage } from '@pulse/runtime'
import { AnthropicAdapter, createModelEffectExecutor, FilesystemTool, normalizeAnthropicResponse, normalizeOpenAIResponse, OpenAICompatibleAdapter, runShell } from '@pulse/adapters'
import { defineTool } from '@pulse/tool-sdk'

const resume = { programId: 'context', programVersion: '1', step: 'start', locals: {} }

describe('M1-3 context, models and adapters', () => {
  it('keeps the stable prefix byte order while Lane history grows append-only', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'goal', resume)
    state.results.set('r1', { id: 'r1', value: { answer: 1 }, privacy: 'public', derivedFrom: [] })
    root.visibleResultRefs!.add('r1')
    const builder = new ContextBuilder(state)
    const first = builder.build({ agent, lane: root, resultRefs: ['r1'], instruction: 'one', system: 'system', policy: { p: 1 }, tools: { tool: 'v1' }, toolSetId: 'tools@1' })
    const withHistory = appendHistory(root, { instruction: 'one', resultRefs: ['r1'], output: { ok: true }, privacy: 'public' })
    const second = builder.build({ agent, lane: withHistory, resultRefs: ['r1'], instruction: 'two', system: 'system', policy: { p: 1 }, tools: { tool: 'v1' }, toolSetId: 'tools@1' })
    expect(second.blocks.slice(0, 4)).toEqual(first.blocks.slice(0, 4))
    expect(stableSerialize(second.blocks.slice(0, 4))).toBe(stableSerialize(first.blocks.slice(0, 4)))
    expect(second.blocks[4]?.kind).toBe('history')
    expect(second.contextSpec.laneSnapshotVersion).toBe(1)
    expect(first.prefixHash).not.toBe(second.prefixHash)
  })

  it('blocks cloud candidates for local_only projected data', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'goal', resume)
    state.results.set('secret', { id: 'secret', value: 'private', privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('secret')
    const projection = new ContextBuilder(state).build({ agent, lane: root, resultRefs: ['secret'], instruction: 'summarize', toolSetId: 'tools@1' })
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'cloud', providerId: 'cloud', tasks: ['summarize'], capabilities: { maxContextTokens: 8_000, local: false }, priority: 10 })
    registry.register({ id: 'local', providerId: 'local', tasks: ['summarize'], capabilities: { maxContextTokens: 8_000, local: true }, priority: 1 })
    expect(new ModelRouter(registry).routeProjection('summarize', projection).map((candidate) => candidate.id)).toEqual(['local'])
    expect(projection.privacy).toBe('local_only')
  })

  it('normalizes OpenAI-compatible and Anthropic tool calls with Pulse ids', () => {
    const openai = normalizeOpenAIResponse({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'provider-id', function: { name: 'read', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }] })
    const anthropic = normalizeAnthropicResponse({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'provider-id', name: 'read', input: { path: 'a' } }] })
    expect(openai.toolCalls[0]).toEqual({ toolCallId: 'pulse-tool-1', name: 'read', input: { path: 'a' } })
    expect(anthropic.toolCalls[0]?.toolCallId).toBe('pulse-tool-1')
    expect(openai.finishReason).toBe('tool_calls')
    expect(normalizeOpenAIResponse({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }).usage).toMatchObject({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, uncachedInputTokens: 7 })
    expect(normalizeOpenAIResponse({ choices: [{ message: { content: null, refusal: 'not allowed' }, finish_reason: 'stop' }] })).toMatchObject({ finishReason: 'refusal', refusal: 'not allowed' })
    expect(normalizeAnthropicResponse({ content: [{ type: 'refusal', text: 'not allowed' }], stop_reason: 'refusal' })).toMatchObject({ finishReason: 'refusal', refusal: 'not allowed' })
  })

  it('fails closed on malformed provider JSON and malformed tool arguments', async () => {
    expect(() => normalizeOpenAIResponse({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'read', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] })).toThrow('INVALID_TOOL_ARGUMENTS')
    expect(() => normalizeAnthropicResponse({ content: [{ type: 'tool_use', name: 'read', input: '{bad' }] })).toThrow('INVALID_TOOL_ARGUMENTS')
    const stream = new Response('data: {bad\n\n', { headers: { 'content-type': 'text/event-stream' } })
    await expect(import('@pulse/adapters').then(({ consumeProviderSse }) => consumeProviderSse(stream))).rejects.toThrow('PROVIDER_STREAM_INVALID_JSON')
  })

  it('maps tool and structured-output contracts into real provider request bodies', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const request = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'tools@1', instruction: 'inspect', privacy: 'public' as const, privacyRefs: [] }, blocks: [{ kind: 'system' as const, content: 'system' }, { kind: 'tools' as const, content: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] }, { kind: 'instruction' as const, content: 'inspect' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'tools@1', privacy: 'public' as const, privacyRefs: [] }
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    await new OpenAICompatibleAdapter('openai', { provider: 'openai', defaultModel: 'fallback', toolChoice: 'required' }).executeAttempt({ request, signal: new AbortController().signal, model: 'candidate', outputSchema: schema, maxOutputTokens: 77 })
    const openaiBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(openaiBody.model).toBe('candidate')
    expect(openaiBody.max_tokens).toBe(77)
    expect(openaiBody.tools[0].function.parameters).toEqual(request.blocks[1].content[0].inputSchema)
    expect(openaiBody.tool_choice).toBe('required')
    expect(openaiBody.response_format.json_schema.schema).toEqual(schema)
    fetchMock.mockClear()
    await new AnthropicAdapter('anthropic', { provider: 'anthropic', defaultModel: 'fallback', maxOutputTokens: 1234, toolChoice: 'required' }).executeAttempt({ request, signal: new AbortController().signal, model: 'candidate', outputSchema: schema })
    const anthropicBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(anthropicBody.model).toBe('candidate')
    expect(anthropicBody.max_tokens).toBe(1234)
    expect(anthropicBody.tools[0].input_schema).toEqual(request.blocks[1].content[0].inputSchema)
    expect(anthropicBody.tool_choice).toEqual({ type: 'any' })
    expect(anthropicBody.output_format.schema).toEqual(schema)
    vi.unstubAllGlobals()
  })

  it('normalizes provider fetch cancellation into a non-retryable adapter error', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancellationRequest = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'cancel@1', instruction: 'cancel', privacy: 'public' as const, privacyRefs: [] }, blocks: [{ kind: 'instruction' as const, content: 'cancel' }], prefixHash: 'cancel-prefix', projectionHash: 'cancel-projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'cancel@1', privacy: 'public' as const, privacyRefs: [] }
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted by fetch'), { name: 'AbortError' }) }))
    await expect(new OpenAICompatibleAdapter('cancelled-provider', { provider: 'openai' }).executeAttempt({ request: cancellationRequest, signal: controller.signal })).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_CANCELLED', retryable: false })
    await expect(new AnthropicAdapter('cancelled-anthropic', { provider: 'anthropic' }).executeAttempt({ request: cancellationRequest, signal: controller.signal })).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_CANCELLED', retryable: false })
    vi.unstubAllGlobals()
  })

  it('normalizes provider stream cancellation into the same non-retryable adapter error', async () => {
    const request = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'cancel-stream@1', instruction: 'cancel stream', privacy: 'public' as const, privacyRefs: [] }, blocks: [{ kind: 'instruction' as const, content: 'cancel stream' }], prefixHash: 'cancel-stream-prefix', projectionHash: 'cancel-stream-projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'cancel-stream@1', privacy: 'public' as const, privacyRefs: [] }
    const controller = new AbortController()
    const streamResponse = (): Response => ({ ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => ({ read: async () => { controller.abort(); throw new Error('stream aborted') } }) } } as unknown as Response)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse()))
    await expect(new OpenAICompatibleAdapter('cancelled-stream-provider', { provider: 'openai', defaultModel: 'stream-model' }).executeAttempt({ request, signal: controller.signal, onObservation: () => undefined })).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_CANCELLED', retryable: false })
    controller.abort()
    await expect(new AnthropicAdapter('cancelled-stream-anthropic', { provider: 'anthropic', defaultModel: 'stream-model' }).executeAttempt({ request, signal: controller.signal, onObservation: () => undefined })).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_CANCELLED', retryable: false })
    vi.unstubAllGlobals()
  })

  it('streams provider text as observations but only normalizes complete tool arguments', async () => {
    const request = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'stream@1', instruction: 'stream', privacy: 'public' as const, privacyRefs: [] }, blocks: [{ kind: 'instruction' as const, content: 'stream' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'stream@1', privacy: 'public' as const, privacyRefs: [] }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const openaiStream = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'provider-call', function: { name: 'read', arguments: '{"path":"a' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    fetchMock.mockResolvedValueOnce(new Response(openaiStream, { headers: { 'content-type': 'text/event-stream' } }))
    const openaiChunks: string[] = []
    const openai = await new OpenAICompatibleAdapter('openai-stream', { provider: 'openai', defaultModel: 'stream-model' }).executeAttempt({ request, signal: new AbortController().signal, onObservation: (chunk) => openaiChunks.push(chunk) })
    expect(openaiChunks).toEqual(['Hel', 'lo '])
    expect(openai.text).toBe('Hello ')
    expect(openai.toolCalls[0]).toMatchObject({ name: 'read', input: { path: 'a' } })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).stream).toBe(true)

    const anthropicStream = [
      ['message_start', { message: { usage: { input_tokens: 5 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } }],
      ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'provider-call', name: 'read', input: {} } }],
      ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }],
      ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    fetchMock.mockResolvedValueOnce(new Response(anthropicStream, { headers: { 'content-type': 'text/event-stream' } }))
    const anthropicChunks: string[] = []
    const anthropic = await new AnthropicAdapter('anthropic-stream', { provider: 'anthropic', defaultModel: 'stream-model' }).executeAttempt({ request, signal: new AbortController().signal, onObservation: (chunk) => anthropicChunks.push(chunk) })
    expect(anthropicChunks).toEqual(['Hi'])
    expect(anthropic.text).toBe('Hi')
    expect(anthropic.toolCalls[0]).toMatchObject({ name: 'read', input: { path: 'a' } })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).stream).toBe(true)
    vi.unstubAllGlobals()
  })

  it('fails closed when a Tool schema cannot be represented in JSON Schema', () => {
    expect(() => defineTool({ name: 'unsupported', description: 'unsupported', input: z.date(), output: z.string(), execute: (input) => input.toISOString() })).toThrow('UNSUPPORTED_SCHEMA_TYPE:ZodDate')
    const schema = z.object({ kind: z.literal('ok'), value: z.number().int().min(1) }).strict()
    const tool = defineTool({ name: 'strict', description: 'strict', input: schema, output: z.string(), execute: () => 'ok' })
    expect(tool.manifest.inputSchema).toEqual({ type: 'object', properties: { kind: { const: 'ok' }, value: { type: 'integer', minimum: 1 } }, required: ['kind', 'value'], additionalProperties: false })
  })

  it('validates provider, structured, and action output as separate layers', () => {
    const result = validateAdapterResult({ text: '', structured: { ok: true }, toolCalls: [{ toolCallId: 'pulse-tool-1', name: 'read', input: {} }], finishReason: 'tool_calls' })
    expect(validateStructuredOutput(result, z.object({ ok: z.boolean() }))).toEqual({ ok: true })
    expect(() => validateActionToolCalls(result, new Set(['write']))).toThrowError(OutputValidationError)
    expect(() => validateStructuredOutput({ ...result, structured: { ok: 'bad' } }, z.object({ ok: z.boolean() }))).toThrowError(/Structured output/)
    expect(() => validateAdapterResult({ ...result, finishReason: 'invalid' as never })).toThrowError(/normalized LLMResult/)
  })

  it('rejects cyclic and non-JSON provider output before publishing a value', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'unsafe', providerId: 'unsafe-provider', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 })
    const projection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'tools@1', instruction: 'reason', privacy: 'public' as const, privacyRefs: [] }, blocks: [{ kind: 'instruction' as const, content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'tools@1', privacy: 'public' as const, privacyRefs: [] } as import('@pulse/runtime').LLMRequestProjection
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const providers = new Map<string, ProviderAdapter>([['unsafe-provider', { id: 'unsafe-provider', name: 'unsafe', executeAttempt: async () => ({ text: '', structured: cyclic, toolCalls: [], finishReason: 'stop' }) }]])
    const executor = createModelEffectExecutor({ router: new ModelRouter(registry), providers })
    const effect = { id: 'unsafe-effect', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection }, attemptId: 'attempt-1', attemptNo: 0, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
    await expect(executor(effect, new AbortController().signal)).rejects.toThrow('LLM_OUTPUT_NOT_SERIALIZABLE')
  })

  it('falls back across candidates with one stable EffectId and blocks in-doubt replay', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'first', providerId: 'mock', tasks: ['plan'], capabilities: { maxContextTokens: 100 }, priority: 2 })
    registry.register({ id: 'second', providerId: 'mock', tasks: ['plan'], capabilities: { maxContextTokens: 100 }, priority: 1 })
    const candidates = new ModelRouter(registry).route('plan', 'public')
    const controller = new ModelFallbackController()
    const attempts: string[] = []
    const result = await controller.execute('effect-1', candidates, async (attempt) => { attempts.push(`${attempt.effectId}:${attempt.attemptId}`); if (attempt.attemptNo === 1) throw modelFallbackError({ retryable: true, localClosed: true, sideEffectState: 'none', cause: new Error('retry') }); return { text: 'ok', toolCalls: [], finishReason: 'stop' } })
    expect(result.result.text).toBe('ok')
    expect(attempts).toEqual(['effect-1:effect-1-attempt-1', 'effect-1:effect-1-attempt-2'])
    await expect(controller.execute('effect-2', candidates, async () => { throw modelFallbackError({ retryable: true, localClosed: true, sideEffectState: 'unknown', cause: new Error('in doubt') }) })).rejects.toThrow('in doubt')
  })

  it('creates an auditable tool manifest from Zod schemas', async () => {
    const tool = defineTool({ name: 'echo', description: 'Echo', input: z.object({ text: z.string() }), output: z.object({ text: z.string() }), sideEffectPolicy: 'none', execute: (input) => input })
    expect(tool.manifest.inputSchema).toMatchObject({ type: 'object', required: ['text'] })
    await expect(tool.execute({ text: 'hi' }, new AbortController().signal)).resolves.toEqual({ text: 'hi' })
  })

  it('enforces filesystem sandbox and runs bounded shell output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-m3-'))
    try {
      const filesystem = new FilesystemTool(root)
      await filesystem.write('nested/file.txt', 'ok')
      await expect(filesystem.read('nested/file.txt')).resolves.toBe('ok')
      await expect(filesystem.read('../outside.txt')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      const result = await runShell(process.execPath, ['-e', 'process.stdout.write("hello")'], { maxOutputBytes: 3 })
      expect(result.stdout).toBe('hel')
      expect(result.truncated).toBe(true)
      expect(await readFile(join(root, 'nested/file.txt'), 'utf8')).toBe('ok')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects sandbox symlink escapes for reads, listings, hashes, and writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-symlink-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'pulse-symlink-outside-'))
    try {
      const outsideFile = join(outside, 'secret.txt')
      await writeFile(outsideFile, 'secret', 'utf8')
      await symlink(outsideFile, join(root, 'escape.txt'))
      await symlink(outside, join(root, 'escape-dir'))
      const filesystem = new FilesystemTool(root)
      await expect(filesystem.read('escape.txt')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      await expect(filesystem.hash('escape.txt')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      await expect(filesystem.list('escape-dir')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      await expect(filesystem.write('escape.txt', 'overwrite')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      await expect(filesystem.writeIfUnchanged('escape.txt', 'overwrite', await filesystem.hash('escape.txt').catch(() => '0'.repeat(64)))).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      expect(await readFile(outsideFile, 'utf8')).toBe('secret')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('applies filesystem writes only when the baseline hash still matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-filesystem-baseline-'))
    try {
      const filesystem = new FilesystemTool(root)
      await filesystem.write('file.txt', 'before')
      const baseline = await filesystem.hash('file.txt')
      await expect(filesystem.writeIfUnchanged('file.txt', 'after', baseline)).resolves.toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 5 })
      await expect(filesystem.read('file.txt')).resolves.toBe('after')
      await expect(filesystem.writeIfUnchanged('file.txt', 'stale', baseline)).rejects.toThrow('FILE_BASELINE_CONFLICT')
      await expect(filesystem.writeIfUnchanged('../outside.txt', 'bad', baseline)).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('cancels a shell process group instead of leaving a spawned child running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-shell-'))
    const marker = join(root, 'leaked.txt')
    const script = 'const {spawn}=require("node:child_process"); const fs=require("node:fs"); spawn(process.execPath,["-e",`setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},"leaked"),400)`],{stdio:"ignore"}); setTimeout(()=>{},10000)'
    const controller = new AbortController()
    const pending = runShell(process.execPath, ['-e', script], { signal: controller.signal })
    setTimeout(() => controller.abort(), 25)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it('reports shell timeout and escalates after the grace period', async () => {
    const result = await runShell(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 25 })
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })

  it('rejects memory writes beyond the M1 hard cap', () => {
    const storage = new MemoryStorage(10)
    storage.put('small', '12345')
    expect(() => storage.put('large', '01234567890')).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(storage.get('small')).toBe('12345')
  })

  it('keeps Step state inspection detached from live Runtime state', () => {
    const runtime = new PulseRuntime()
    const program = { id: 'snapshot', version: '1', step: ({ state }: { state: any }) => { state.now = 999; state.lanes.clear(); return { actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'snapshot', programVersion: '1', step: 'done', locals: {} } } } }
    const { laneId } = runtime.createAgent('snapshot', program)
    runtime.tick()
    expect(runtime.state.now).toBe(0)
    expect(runtime.state.lanes.has(laneId)).toBe(true)
  })
})
