import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextBuilder, PulseRuntime, appendHistory, createAgent, createRuntimeState, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { toOpenAIMessages } from '../packages/adapters/src/providers/openai-compat.js'
import { verificationFingerprint, reusableVerification } from '../packages/server/src/task-controller/verification-reuse.js'

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_MODEL_OR_NETWORK_REQUEST')) })
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks() })

function nativeFixture() {
  const state = createRuntimeState(), { agent, root } = createAgent(state, 'task', { programId: 'test', programVersion: '57', step: 'work', locals: {} })
  agent.globalVersions.set(0, { secretControl: 'PRIVATE_GLOBAL' }); root.context.state = { hidden: 'PRIVATE_LANE' }
  state.results.set('tool-result', { id: 'tool-result', value: { fact: 'UNIQUE_RECEIPT' }, privacy: 'local_only', derivedFrom: [] } as any)
  root.visibleResultRefs!.add('tool-result')
  state.toolCallCorrelations.set('call', { toolCallId: 'call', llmEffectId: 'llm', toolEffectId: 'tool', resultRef: 'tool-result' })
  const lane = appendHistory(root, { effectId: 'llm', instruction: 'inspect', resultRefs: ['tool-result'], output: { text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call', providerToolCallId: 'provider-call', name: 'fs.read', input: { path: 'a' } }] }, privacy: 'local_only' })
  const build = (nativeToolHistory = true) => new ContextBuilder(state).build({ agent, lane, explicitContext: true, includeLaneHistory: true, nativeToolHistory, instruction: 'continue', toolSetId: 'test' })
  return { state, lane, build }
}

it('projects native assistant/tool pairs without exposing control state or duplicating receipts', () => {
  const f = nativeFixture(), projection = f.build(), messages = toOpenAIMessages(projection, 'openai')
  expect(projection.privacy).toBe('local_only')
  expect(messages.some(m => m.role === 'tool' && (m as any).tool_call_id === 'provider-call')).toBe(true)
  const text = JSON.stringify(messages)
  expect(text.split('UNIQUE_RECEIPT')).toHaveLength(2)
  expect(text).toContain('runtimeResultRef')
  expect(text).toContain('tool-result')
  expect(text).not.toContain('PRIVATE_GLOBAL'); expect(text).not.toContain('PRIVATE_LANE')
  expect(f.build(false).contextSpec.providerHistory).toBeUndefined()
})

it('does not invent completed tool calls when native history loses a visible receipt', () => {
  const f = nativeFixture(); f.lane.visibleResultRefs!.delete('tool-result')
  const messages = toOpenAIMessages(f.build(), 'openai')
  expect(messages.some(m => m.role === 'tool')).toBe(false)
  expect(JSON.stringify(messages)).toContain('incomplete')
  expect(JSON.stringify(messages)).not.toContain('UNIQUE_RECEIPT')
})

it('preserves native continuity after a compacted checkpoint', () => {
  const f = nativeFixture()
  f.lane.context.history.unshift({ seq: 0, instruction: '[history compacted]', resultRefs: [], output: { text: 'Completed earlier work; next inspect a.' }, privacy: 'public' })
  expect(f.build().contextSpec.providerHistory?.some(m => m.role === 'tool')).toBe(true)
  expect(JSON.stringify(f.build().contextSpec.providerHistory)).toContain('Completed earlier work')
})

it('uses the full prompt for compression pressure and never recursively summarizes only summaries', async () => {
  let calls = 0, summaries = 0, tools = 0
  const program = defineLaneProgram({ id: 'complete-request', version: '1', explicitContext: true, includeLaneHistory: true, nativeToolHistory: true, system: 'x'.repeat(23000), historyCompaction: { summarizeTask: 'summary', keepRecentRounds: 2, maxSummaryRetries: 2, maxContextTokens: 7000, outputReserveTokens: 1000 } }, b => b.addReActLoopStep('work', { instruction: 'Read local evidence', maxTurns: 20, continuousExecution: true, onFinish: () => ({ complete: {} }) }))
  const runtime = new PulseRuntime({ historySoftTokens: 100000, historyHardTokens: 200000, effectExecutor: async e => {
    if (e.key === '$compact-summary') { summaries++; if (summaries > 20) throw new Error('COMPACTION_LOOP'); return { value: { text: 'Original goal and settled evidence retained.', finishReason: 'stop', toolCalls: [] } } }
    if (e.kind === 'tool') { tools++; return { value: { path: `p${tools}`, content: 'settled' } } }
    calls++
    return { value: calls <= 8 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `p${calls}` } }] } : { text: 'Done', finishReason: 'stop', toolCalls: [] } }
  } })
  expect(await runtime.start(runtime.createAgent('read', program).agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(tools).toBe(8); expect(calls).toBe(9); expect(summaries).toBeGreaterThan(0); expect(summaries).toBeLessThan(10)
})

it.each(['blank', 'tool-proposal', 'truncated'])('retains the checkpoint after two failed summary repairs (%s)', async kind => {
  let calls = 0, summaries = 0, writes = 0
  const program = defineLaneProgram({ id: `bad-${kind}`, version: '1', historyCompaction: { summarizeTask: 'summary', keepRecentRounds: 1, maxSummaryRetries: 2 } }, b => b.addReActLoopStep('work', { instruction: 'Read current evidence. '.repeat(30), maxTurns: 20, onFinish: () => ({ complete: {} }) }))
  const runtime = new PulseRuntime({ historySoftTokens: 300, historyHardTokens: 100000, effectExecutor: async e => {
    if (e.key === '$compact-summary') { summaries++; return { value: kind === 'tool-proposal' ? { text: 'write', finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'unsafe', content: 'never' } }] } : { text: kind === 'blank' ? '' : 'incomplete', finishReason: kind === 'truncated' ? 'length' : 'stop', toolCalls: [] } } }
    if (e.kind === 'tool') { if ((e.input as any).name === 'fs.write') writes++; return { value: { path: `p${calls}`, content: 'evidence' } } }
    calls++; return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `p${calls}` } }] } }
  } })
  const { agentId } = runtime.createAgent('inspect', program)
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'HISTORY_COMPACTION_INVALID' } })
  expect(summaries).toBe(3); expect(writes).toBe(0)
  expect([...runtime.state.results.values()].some(r => (r.value as any)?.content === 'evidence')).toBe(true)
  expect(runtime.exportPersistence()).toBeTruthy()
})

it('keys verification reuse by evidence and contract while ignoring only accounting counters', () => {
  const runtime = new PulseRuntime(), p = defineLaneProgram({ id: 'verify', version: '57' }, b => b.addStep('work', () => ({ actions: [], next: 'work' })))
  const { agentId } = runtime.createAgent('verify', p), lane = runtime.state.agents.get(agentId)!.rootLaneId
  runtime.state.results.set('r', { id: 'r', value: { hash: 'v1' }, privacy: 'public', derivedFrom: [] } as any)
  const effect: any = { id: 'v', ownerLaneId: lane, key: 'verify-stage-llm', input: { instruction: 'verify', inputs: { results: ['r'], originalContract: { goal: 'A' }, conversation: [{ role: 'user', content: JSON.stringify({ usedTurns: 3, activeStage: { id: 'a', goal: 'A' } }) }] } } }
  effect.input.inputs.userData = { maxTurns: 4 }
  const original = verificationFingerprint(effect, runtime)
  effect.input.inputs.userData.maxTurns = 5
  expect(verificationFingerprint(effect, runtime)).not.toBe(original)
  effect.input.inputs.userData.maxTurns = 4
  effect.input.inputs.conversation[0].content = JSON.stringify({ usedTurns: 9, activeStage: { id: 'a', goal: 'A' } })
  expect(verificationFingerprint(effect, runtime)).toBe(original)
  runtime.state.results.get('r')!.value = { hash: 'v2' }
  expect(verificationFingerprint(effect, runtime)).not.toBe(original)
  runtime.state.results.get('r')!.value = { hash: 'v1' }
  effect.input.inputs.originalContract.goal = 'B'
  expect(verificationFingerprint(effect, runtime)).not.toBe(original)
})

it('reuses only a passed verification without copying provider usage or accepting a failed check', () => {
  const runtime = new PulseRuntime()
  runtime.state.results.set('r', { id: 'r', value: { text: '', finishReason: 'stop', toolCalls: [], structured: { status: 'passed' }, usage: { inputTokens: 100 } }, privacy: 'public', derivedFrom: [] } as any)
  runtime.state.effects.set('v', { outcome: { status: 'succeeded', resultRef: 'r' } } as any)
  runtime.state.events.push({ type: 'effect.execution_metadata', effectId: 'v', data: { verificationFingerprint: 'key' } } as any)
  expect(reusableVerification(runtime, 'key')?.value).not.toHaveProperty('usage')
  ;(runtime.state.results.get('r')!.value as any).structured.status = 'needs_work'
  expect(reusableVerification(runtime, 'key')).toBeUndefined()
})

it('retains command identity for a cancelled asynchronous check with a null exit code', async () => {
  const program = defineLaneProgram({ id: 'cancelled-check', version: '57' }, b => {
    b.addStep('poll', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'poll', kind: 'tool', concurrencyClass: 'tool', input: { name: 'shell.poll', arguments: { processId: 'handle' } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
    b.addStep('finish', ctx => {
      const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined
      const ref = dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined
      const meta = ref ? ctx.results.meta(ref) : undefined
      return { actions: [{ type: 'complete', result: { command: meta?.toolCommand ?? null, args: meta?.toolArguments ?? null } }], next: 'finish' }
    })
  })
  const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { status: 'exited', code: null, aborted: true, command: { command: 'node', args: ['--test', 'check.test.mjs'], cwd: '.' } } }) })
  const outcome = await runtime.start(runtime.createAgent('check', program).agentId).outcome()
  expect(runtime.state.results.get(outcome.resultRef!)?.value).toMatchObject({ command: 'node --test check.test.mjs', args: { command: 'node', args: ['--test', 'check.test.mjs'] } })
})
