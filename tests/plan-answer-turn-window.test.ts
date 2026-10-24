import { expect, it } from 'vitest'
import { defineLaneProgram, PulseRuntime } from '@hunterzhu/pulse-runtime'

it.each([false, true])('continues a late caller answer only with the versioned opt-in: %s', async enabled => {
  let models = 0, writes = 0, humans = 0
  const ids: string[] = []
  const program = defineLaneProgram({ id: 'plan-answer-window', version: '1' }, builder => {
    builder.addReActLoopStep('repair', { instruction: 'repair plan only', maxTurns: 2, ...(enabled ? { maxHumanTurnResets: 1 as const } : {}), scopeToolCallsToEffect: true, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; return { value: { value: 'sliding window; CSV' } } }
    if (effect.kind === 'tool') { if ((effect.input as any).name === 'fs.apply_patch') writes++; ids.push((effect.input as any).toolCallId); return { value: { content: 'plan', changed: true } } }
    models++
    if (models === 4) {
      expect(JSON.stringify(effect.input)).toContain('sliding window; CSV')
      return { value: { text: 'saved reviewed plan' } }
    }
    return { value: { finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'provider-reused-id', name: models === 1 ? 'fs.read' : models === 2 ? 'ask.input' : 'fs.apply_patch', input: models === 2 ? { prompt: 'Which contract?' } : { path: 'docs/plans/feature.md', find: 'pending', replace: 'confirmed' } }] } }
  } })
  const { agentId } = runtime.createAgent('repair', program)
  expect((await runtime.start(agentId).outcome()).status).toBe(enabled ? 'succeeded' : 'failed')
  expect(writes).toBe(enabled ? 1 : 0)
  expect(humans).toBe(1)
  expect(models).toBe(enabled ? 4 : 3)
  expect(new Set(ids).size).toBe(ids.length)
  expect([...runtime.state.effects.values()].filter(e => e.kind === 'llm')).toHaveLength(models)
})

it('does not refill the window when the caller closes without answering', async () => {
  let models = 0, humans = 0
  const program = defineLaneProgram({ id: 'plan-answer-dismiss', version: '1' }, builder => {
    builder.addReActLoopStep('repair', { instruction: 'repair', maxTurns: 2, maxHumanTurnResets: 1, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; return { value: { dismissed: true } } }
    models++
    if (models === 2) expect(JSON.stringify(effect.input)).toContain('No answer or permission was supplied')
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.input', input: { prompt: 'Which contract?' } }] } }
  } })
  const { agentId } = runtime.createAgent('repair', program)
  expect((await runtime.start(agentId).outcome()).status).toBe('failed')
  expect(humans).toBe(2)
  expect(models).toBe(3)
})

it('does not refill the window for replayed questions or reset cumulative effect accounting', async () => {
  let models = 0, humans = 0
  const program = defineLaneProgram({ id: 'plan-answer-replay', version: '1' }, builder => {
    builder.addReActLoopStep('repair', { instruction: 'repair', maxTurns: 2, maxHumanTurnResets: 1, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; return { value: { value: 'CSV' } } }
    models++
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.input', input: { prompt: 'Which contract?' } }] } }
  } })
  const { agentId } = runtime.createAgent('repair', program)
  expect((await runtime.start(agentId).outcome()).status).toBe('failed')
  expect(humans).toBe(1)
  expect(models).toBeLessThanOrEqual(4)
  expect([...runtime.state.effects.values()].filter(e => e.kind === 'llm')).toHaveLength(models)
})
