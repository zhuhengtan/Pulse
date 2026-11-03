import { describe, expect, it } from 'vitest'
import { ContextBuilder, appendHistory, createAgent, createRuntimeState, PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { toOpenAIMessages } from '../packages/adapters/src/providers/openai-compat.js'
import { normalizeOpenAIResponse, normalizeAnthropicResponse } from '../packages/adapters/src/providers/normalize.js'
import { RequestDiagnostics } from '../packages/adapters/src/providers/request-diagnostics.js'
import { toAnthropicPayload, resolveModelCapability, lowerProjectionToCanonical } from '../packages/adapters/src/providers/canonical/index.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { initialController } from '../packages/server/src/task-controller/state.js'

const tools = { tools: [{ name: 'fs.read', description: 'UNIQUE_SCHEMA', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] }
function fixture(nativeToolHistory = true) {
  const state = createRuntimeState(), { agent, root } = createAgent(state, 'task', { programId: 'test', programVersion: '57', step: 'work', locals: {} })
  let lane = root
  const build = (used = 1, extra = {}) => new ContextBuilder(state).build({ agent, lane, contextProtocolVersion: 2, contextStream: 'work', explicitContext: true, includeLaneHistory: true, nativeToolHistory, system: 'Stable rules', instruction: 'Continue safely', toolSetId: 'test', tools, conversation: [{ role: 'user', content: 'Original requirement. '.repeat(100) }, { role: 'user', content: JSON.stringify({ usedTurns: used, activeStage: { id: 'stage-a' } }) }], ...extra })
  const settle = (projection: ReturnType<typeof build>, seq = 1) => {
    const id = `llm-${seq}`, ref = `receipt-${seq}`
    state.effects.set(id, { id, kind: 'llm', input: { request: projection } } as any)
    state.results.set(ref, { id: ref, value: { content: `UNIQUE_RECEIPT_${seq}` }, privacy: 'public', derivedFrom: [] } as any)
    lane.visibleResultRefs!.add(ref)
    const call = `call-${seq}`
    state.toolCallCorrelations.set(call, { toolCallId: call, llmEffectId: id, toolEffectId: `tool-${seq}`, resultRef: ref })
    lane = appendHistory(lane, { effectId: id, instruction: 'inspect', resultRefs: [ref], output: { text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: call, providerToolCallId: `provider-${seq}`, name: 'fs.read', input: { path: 'a' } }] }, privacy: 'public' })
    state.lanes.set(lane.id, lane)
    return ref
  }
  return { state, agent, build, settle, lane: () => lane }
}

describe('versioned context protocol', () => {
  it('keeps the entire submitted message prefix and emits schemas and tool evidence once', () => {
    const f = fixture(), first = f.build(), a = toOpenAIMessages(first)
    f.settle(first)
    const second = f.build(2), b = toOpenAIMessages(second)
    expect(b.slice(0, a.length)).toEqual(a)
    expect(second.contextSpec.journal?.segment).toBe(first.contextSpec.journal?.segment)
    expect(second.contextSpec.journal?.reason).toBe('append')
    expect(JSON.stringify(b)).not.toContain('UNIQUE_SCHEMA')
    expect(JSON.stringify(b).split('UNIQUE_RECEIPT_1')).toHaveLength(2)
    expect(JSON.stringify(b)).toContain('contextUpdate')
    expect(second.blocks.find(block => block.kind === 'tools')).toMatchObject({ content: tools })
  })

  it('does not duplicate evidence in a later non-native continuation', () => {
    const f = fixture(false), first = f.build()
    const ref = f.settle(first)
    const second = f.build(2, { resultRefs: [ref] })
    f.settle(second, 2)
    const third = f.build(3, { resultRefs: [ref, 'receipt-2'] })
    expect(JSON.stringify(toOpenAIMessages(third)).split('UNIQUE_RECEIPT_1')).toHaveLength(2)
    expect(toOpenAIMessages(third).slice(0, toOpenAIMessages(second).length)).toEqual(toOpenAIMessages(second))
  })

  it('never represents a missing tool receipt as completed or leaks a hidden prior receipt', () => {
    const f = fixture(), first = f.build(), ref = f.settle(first), second = f.build(2)
    f.settle(second, 2)
    f.lane().visibleResultRefs!.delete(ref)
    const third = f.build(3)
    expect(third.contextSpec.journal?.segment).not.toBe(second.contextSpec.journal?.segment)
    expect(JSON.stringify(toOpenAIMessages(third))).not.toContain('UNIQUE_RECEIPT_1')
    expect(JSON.stringify(toOpenAIMessages(third))).toContain('incomplete')
  })

  it('starts a new segment after compaction or a tool/phase change', () => {
    const f = fixture(), first = f.build(); f.settle(first)
    expect(f.build(2, { contextStream: 'verify' }).contextSpec.journal?.reason).toBe('phase')
    expect(f.build(2, { tools: { tools: [] } }).contextSpec.journal?.segment).not.toBe(first.contextSpec.journal?.segment)
    f.lane().context.history.unshift({ seq: 0, instruction: '[history compacted]', resultRefs: [], output: { text: 'Verified checkpoint' }, privacy: 'public' })
    const compacted = f.build(2)
    expect(compacted.contextSpec.journal?.reason).toBe('compaction')
    expect(JSON.stringify(toOpenAIMessages(compacted))).toContain('Verified checkpoint')
  })

  it('keeps legacy projection shape without the new version', () => {
    const f = fixture(), legacy = f.build(1, { contextProtocolVersion: undefined })
    expect(legacy.contextSpec.journal).toBeUndefined()
    expect(JSON.stringify(toOpenAIMessages(legacy))).toContain('UNIQUE_SCHEMA')
  })

  it('reports local prefix reuse separately from provider-reported cache usage', () => {
    const tracker = new RequestDiagnostics(), a = { model: 'test', messages: [{ role: 'user', content: 'a' }] }
    expect(tracker.measure('lane', a).prefixChange).toBe('initial')
    expect(tracker.measure('lane', { ...a, messages: [...a.messages, { role: 'assistant', content: 'b' }] })).toMatchObject({ prefixChange: 'append', reusablePrefixBytes: Buffer.byteLength(JSON.stringify(a.messages[0])) })
    expect(tracker.measure('lane', { ...a, tools: [{ name: 'changed' }] }).prefixChange).toBe('request-shape')
  })

  it('normalizes DeepSeek hit/miss fields and preserves unknowns', () => {
    const response = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }
    expect(normalizeOpenAIResponse({ ...response, usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } }, undefined, 'deepseek').usage).toMatchObject({ cachedInputTokens: 80, uncachedInputTokens: 20 })
    expect(normalizeOpenAIResponse({ ...response, usage: { prompt_tokens: 100 } }, undefined, 'deepseek').usage).not.toHaveProperty('cachedInputTokens')
    expect(() => normalizeOpenAIResponse({ ...response, usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 30 } }, undefined, 'deepseek')).toThrow()
  })

  it('includes Anthropic reads and writes in total input without inventing unknown cache fields', () => {
    const response = { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
    expect(normalizeAnthropicResponse({ ...response, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 80, cache_creation_input_tokens: 15 } }).usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 80, uncachedInputTokens: 20, cacheWriteInputTokens: 15 })
    expect(normalizeAnthropicResponse({ ...response, usage: { input_tokens: 5 } }).usage).not.toHaveProperty('cachedInputTokens')
  })

  it('marks Anthropic conversation cache boundaries only on explicitly supported transports', () => {
    const request = fixture().build(), { canonical } = lowerProjectionToCanonical({ request, model: 'claude-test' })
    const supported = toAnthropicPayload(canonical, resolveModelCapability('claude-test', 'anthropic')) as any
    expect(supported.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    const unknown = toAnthropicPayload(canonical, resolveModelCapability('claude-test', 'anthropic', undefined, 'https://unverified.example'))
    expect(JSON.stringify(unknown)).not.toContain('cache_control')
  })

  it('sorts schemas without rewriting tool argument text and retains privacy across continuations', () => {
    const f = fixture(), a = { name: 'a.tool', inputSchema: { type: 'object' } }, z = { name: 'z.tool', inputSchema: { type: 'object' } }
    const first = f.build(1, { tools: { tools: [z, a] } })
    const ref = f.settle(first)
    f.state.results.get(ref)!.privacy = 'local_only'
    const next = f.build(2, { tools: { tools: [a, z] } })
    expect(next.contextSpec.journal?.segment).toBe(first.contextSpec.journal?.segment)
    expect(next.privacy).toBe('local_only')
    expect(next.contextSpec.resultRefs).toContain(ref)
  })

  it.each(['missing-evidence', 'missing-stage', 'unmet-dependency'])('rejects an invalid committed handoff (%s)', async kind => {
    const state = initialController(10)
    state.tasks = [{ id: 'a', goal: 'Inspect local file', kind: 'analyze', check: 'Cite actual contents', criterionIds: ['criterion-1'], dependsOn: kind === 'unmet-dependency' ? ['missing'] : [], status: 'pending', attempts: 0, evidenceRefs: kind === 'missing-evidence' ? ['result-missing'] : [] }]
    const program = buildTaskControllerProgram({ version: '56', contextProtocolVersion: 2, system: 'test', toolNames: [], approvalMode: 'ask', maxTurns: 10 })
    let calls = 0
    const runtime = new PulseRuntime({ effectExecutor: async () => { calls++; return { value: {} } } })
    const { agentId, laneId } = runtime.createAgent({ goal: 'Inspect', program, initialGlobal: { taskController: state } as any })
    runtime.state.lanes.get(laneId)!.resume = { programId: program.id, programVersion: program.version, step: 'chain-start', locals: { stageIds: [kind === 'missing-stage' ? 'absent' : 'a'] } }
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('failed')
    expect(outcome.error?.code).toMatch(/^HANDOFF_/)
    expect(calls).toBe(0)
  })

  it('compacts a pressured lane while preserving corrections and completed tool receipts', async () => {
    let calls = 0, summaries = 0, writes = 0
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'v2-compact', version: '1', contextProtocolVersion: 2, explicitContext: true, includeLaneHistory: true, nativeToolHistory: true,
      historyCompaction: { summarizeTask: 'reason', keepRecentRounds: 4, maxContextTokens: 7000, outputReserveTokens: 1000, maxSummaryRetries: 2 },
    }, b => b.addReActLoopStep('work', { instruction: 'Complete the original task', continuousExecution: true, maxTurns: 12, inputs: () => ({ conversation: [{ role: 'user', content: 'Correction: write each file only once, then inspect.' }] }), onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ historySoftTokens: 100000, historyHardTokens: 200000, effectExecutor: async effect => {
      if (effect.kind === 'tool') { writes++; return { value: { written: true, content: 'Evidence '.repeat(800) } } }
      requests.push(effect.input)
      if (effect.key === '$compact-summary') { summaries++; return { value: { text: 'Original task; each completed write has a retained receipt. Correction: write each file only once. Next inspect.', finishReason: 'stop', toolCalls: [] } } }
      calls++
      return { value: calls <= 8 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ providerToolCallId: `p-${calls}`, name: 'fs.write', input: { path: `file-${calls}`, content: 'done' } }] } : { text: 'Done', finishReason: 'stop', toolCalls: [] } }
    } })
    expect(await runtime.start(runtime.createAgent('Original requirement', program).agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(writes).toBe(8); expect(summaries).toBeGreaterThan(0); expect(summaries).toBeLessThan(8)
    expect(requests.filter(input => input.historySeqs).every(input => JSON.stringify(input.request).includes('Correction: write each file only once'))).toBe(true)
    expect([...runtime.state.results.values()].filter(result => (result.value as any)?.written === true)).toHaveLength(8)
  })

  it('persists and restores submitted prefixes without replaying settled tools', async () => {
    let models = 0, writes = 0, interrupted: ReturnType<PulseRuntime['exportPersistence']> | undefined
    const program = defineLaneProgram({ id: 'journal-recovery', version: '1', contextProtocolVersion: 2, includeLaneHistory: true, nativeToolHistory: true, explicitContext: true }, b => b.addReActLoopStep('work', { instruction: 'Complete task', continuousExecution: true, maxTurns: 5, onFinish: () => ({ complete: {} }) }))
    const requests: any[] = []
    const executor = async (effect: any) => {
      if (effect.kind === 'tool') { writes++; return { value: { written: true } } }
      requests.push(structuredClone(effect.input.request)); models++
      if (models === 2) interrupted = runtime.exportPersistence()
      return { value: models === 1 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'a', content: 'done' }, providerToolCallId: 'provider-call' }] } : { text: 'Done', finishReason: 'stop', toolCalls: [] } }
    }
    const runtime = new PulseRuntime({ effectExecutor: executor })
    const { agentId } = runtime.createAgent('write once', program)
    await runtime.start(agentId).outcome()
    const snapshot = runtime.exportPersistence()
    expect(snapshot).toBeTruthy(); expect(writes).toBe(1)
    expect(requests[1].contextSpec.journal).toBeTruthy()
    expect(toOpenAIMessages(requests[1]).slice(0, toOpenAIMessages(requests[0]).length)).toEqual(toOpenAIMessages(requests[0]))
    const restored = new PulseRuntime({ persistence: interrupted!, programs: [program], effectExecutor: executor })
    expect(await restored.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(writes).toBe(1)
    expect(toOpenAIMessages(requests[2])).toEqual(toOpenAIMessages(requests[1]))
  })
})
