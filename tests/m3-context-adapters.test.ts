import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ContextBuilder, InMemoryModelRegistry, ModelFallbackController, ModelRouter, OutputValidationError, PulseRuntime, appendHistory, createAgent, createRuntimeState, modelFallbackError, stableSerialize, validateActionToolCalls, validateAdapterResult, validateStructuredOutput, MemoryStorage } from '@pulse/runtime'
import { FilesystemTool, normalizeAnthropicResponse, normalizeOpenAIResponse, runShell } from '@pulse/adapters'
import { defineTool } from '@pulse/tool-sdk'

const resume = { programId: 'context', programVersion: '1', step: 'start', locals: {} }

describe('M1-3 context, models and adapters', () => {
  it('keeps the stable prefix byte order while Lane history grows append-only', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'goal', resume)
    state.results.set('r1', { id: 'r1', value: { answer: 1 }, privacy: 'public', derivedFrom: [] })
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
  })

  it('validates provider, structured, and action output as separate layers', () => {
    const result = validateAdapterResult({ text: '', structured: { ok: true }, toolCalls: [{ toolCallId: 'pulse-tool-1', name: 'read', input: {} }], finishReason: 'tool_calls' })
    expect(validateStructuredOutput(result, z.object({ ok: z.boolean() }))).toEqual({ ok: true })
    expect(() => validateActionToolCalls(result, new Set(['write']))).toThrowError(OutputValidationError)
    expect(() => validateStructuredOutput({ ...result, structured: { ok: 'bad' } }, z.object({ ok: z.boolean() }))).toThrowError(/Structured output/)
    expect(() => validateAdapterResult({ ...result, finishReason: 'invalid' as never })).toThrowError(/normalized LLMResult/)
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
