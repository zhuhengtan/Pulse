import { expect, it } from 'vitest'
import { defineLaneProgram, PulseRuntime } from '@hunterzhu/pulse-runtime'

it.each([false, true])('keeps mixed ask/work batches unexecuted and optionally corrects them: %s', async enabled => {
  let models = 0, humans = 0, reads = 0
  const program = defineLaneProgram({ id: 'mixed-ask', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'work', maxTurns: 5, recoverMixedAskCalls: enabled, onFinish: () => ({ complete: {} }) })
  })
  const ask = { name: 'ask.input', input: { prompt: 'Which contract?' } }, read = { name: 'fs.read', input: { path: 'data.csv' } }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; expect(reads).toBe(0); return { value: { value: 'CSV' } } }
    if (effect.kind === 'tool') { reads++; expect(humans).toBe(1); return { value: 'observed' } }
    models++
    if (models === 2) { expect(JSON.stringify(effect.input)).toContain('NONE of the proposed calls ran'); expect(humans + reads).toBe(0) }
    return { value: models === 4 ? { text: 'done' } : { finishReason: 'tool_calls', toolCalls: models === 1 ? [ask, read] : models === 2 ? [ask] : [read] } }
  } })
  const { agentId } = runtime.createAgent('work', program)
  expect((await runtime.start(agentId).outcome()).status).toBe(enabled ? 'succeeded' : 'failed')
  expect(humans).toBe(enabled ? 1 : 0)
  expect(reads).toBe(enabled ? 1 : 0)
  expect([...runtime.state.effects.values()].filter(e => e.kind === 'llm')).toHaveLength(models)
})

it('bounds repeated mixed proposals without executing either operation', async () => {
  let models = 0, other = 0
  const program = defineLaneProgram({ id: 'mixed-ask-bound', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'work', maxTurns: 8, recoverMixedAskCalls: true, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind !== 'llm') { other++; return { value: true } }
    models++; return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.input', input: { prompt: 'Decision?' } }, { name: 'fs.write', input: { path: 'output', content: 'bad' } }] } }
  } })
  const { agentId } = runtime.createAgent('work', program)
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'ASK_MIXED_TOOL_CALLS' } })
  expect(models).toBe(3)
  expect(other).toBe(0)
})
