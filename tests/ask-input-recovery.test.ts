import { expect, it } from 'vitest'
import { defineLaneProgram, PulseRuntime } from '@hunterzhu/pulse-runtime'

it.each([false, true])('validates the whole ask batch before showing any question (recovery=%s)', async recover => {
  let models = 0, humans = 0
  const program = defineLaneProgram({ id: 'ask-input-correction', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'work', maxTurns: 5, recoverAskInputErrors: recover, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; expect(models).toBe(2); expect((effect.input as any).options).toEqual([{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }]); return { value: { value: 'A' } } }
    models++
    if (models === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.input', input: { prompt: 'Valid first question' } }, { name: 'ask.choice', input: { prompt: 'Which option?', options: [] } }] } }
    if (models === 2) { expect(humans).toBe(0); expect(JSON.stringify(effect.input)).toContain('Field: options'); expect(JSON.stringify(effect.input)).toContain('NONE of this ask batch'); const proposal = [...runtime.state.effects.values()].find(e => e.kind === 'llm' && e.outcome?.resultRef)!; expect(JSON.stringify(effect.input)).toContain(proposal.outcome!.resultRef); return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.choice', input: { prompt: 'Which option?', options: ['A', 'B'] } }] } } }
    return { value: { text: 'done' } }
  } })
  const { agentId } = runtime.createAgent('work', program)
  expect((await runtime.start(agentId).outcome()).status).toBe(recover ? 'succeeded' : 'failed')
  expect(humans).toBe(recover ? 1 : 0)
  expect(models).toBe(recover ? 3 : 1)
  expect([...runtime.state.effects.values()].filter(e => e.kind === 'llm')).toHaveLength(models)
})

it.each([
  { input: { prompt: '', options: ['A'] }, field: 'prompt' },
  { input: { prompt: 'Pick', options: [{ label: 'A', value: 'A' }, { label: 'Invalid', value: 2 }] }, field: 'options' },
  { input: { prompt: 'Pick', context: 42, options: ['A'] }, field: 'context' },
])('returns concrete native ask diagnostics without asking an altered question: $field', async fixture => {
  let models = 0, humans = 0
  const program = defineLaneProgram({ id: 'ask-input-fields', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'work', maxTurns: 4, recoverAskInputErrors: true, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; return { value: { value: 'A' } } }
    if (++models === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.choice', input: fixture.input }] } }
    expect(JSON.stringify(effect.input)).toContain(`Field: ${fixture.field}`)
    return { value: { text: 'The invalid question was not asked.' } }
  } })
  const { agentId } = runtime.createAgent('work', program)
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(humans).toBe(0)
  expect(models).toBe(2)
})

it.each([1, 8])('bounds ask corrections by local and cumulative model effects (maxTurns=%s)', async maxTurns => {
  let models = 0, humans = 0
  const program = defineLaneProgram({ id: 'ask-input-bound', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'work', maxTurns, recoverAskInputErrors: true, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') { humans++; return { value: null } }
    models++; return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.choice', input: { prompt: 'Pick', options: [] } }] } }
  } })
  const { agentId } = runtime.createAgent('work', program)
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'ASK_OPTIONS_REQUIRED' } })
  expect(models).toBe(maxTurns === 1 ? 1 : 3)
  expect(humans).toBe(0)
})
