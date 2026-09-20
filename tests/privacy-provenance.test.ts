import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, defineLaneProgram, PulseRuntime, validateStep } from '@pulse/runtime'

describe('result privacy provenance', () => {
  it('recomputes the strictest source label and preserves derivedFrom', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'privacy', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    state.results.set('local-result', { id: 'local-result', value: { secret: true }, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('local-result')
    const result = validateStep(state, root.id, { actions: [{ type: 'complete', result: { summary: true }, derivedFrom: ['local-result'] }], next: { programId: 'p', programVersion: '1', step: 'done', locals: {} } })
    expect('mutations' in result).toBe(true)
    if ('mutations' in result) { apply(state, result.mutations); expect([...state.results.values()].find((item) => item.derivedFrom.includes('local-result'))).toMatchObject({ privacy: 'local_only', derivedFrom: ['local-result'] }) }
  })

  it('rejects explicit privacy downgrades and unknown provenance references', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'privacy', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    state.results.set('local-result', { id: 'local-result', value: {}, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('local-result')
    expect('rejection' in validateStep(state, root.id, { actions: [{ type: 'complete', result: {}, privacy: 'public', derivedFrom: ['local-result'] }], next: { programId: 'p', programVersion: '1', step: 'done', locals: {} } })).toBe(true)
    expect('rejection' in validateStep(state, root.id, { actions: [{ type: 'complete', result: {}, derivedFrom: ['missing'] }], next: { programId: 'p', programVersion: '1', step: 'done', locals: {} } })).toBe(true)
  })

  it('derives DSL terminal results and effect results from synchronous ResultRef reads', async () => {
    const terminalProgram = defineLaneProgram({ id: 'dsl-provenance-terminal', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => { ctx.getResult('source'); return { actions: [{ type: 'complete', result: { ok: true } }], next: 'start' } })
    })
    const terminalRuntime = new PulseRuntime()
    const terminal = terminalRuntime.createAgent('terminal', terminalProgram)
    terminalRuntime.state.results.set('source', { id: 'source', value: { secret: true }, privacy: 'local_only', derivedFrom: [] })
    terminalRuntime.state.lanes.get(terminal.laneId)!.visibleResultRefs!.add('source')
    expect((await terminalRuntime.start(terminal.agentId).outcome()).status).toBe('succeeded')
    expect([...terminalRuntime.state.results.values()].find((result) => result.id !== 'source')).toMatchObject({ privacy: 'local_only', derivedFrom: ['source'] })

    const effectProgram = defineLaneProgram({ id: 'dsl-provenance-effect', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => { ctx.getResult('source'); return { actions: [{ type: 'submit_effects', effects: [{ key: 'derived-work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' } })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const effectRuntime = new PulseRuntime({ effectExecutor: async () => ({ value: { answer: 1 }, privacy: 'public' }) })
    const effectAgent = effectRuntime.createAgent('effect', effectProgram)
    effectRuntime.state.results.set('source', { id: 'source', value: { secret: true }, privacy: 'local_only', derivedFrom: [] })
    effectRuntime.state.lanes.get(effectAgent.laneId)!.visibleResultRefs!.add('source')
    expect((await effectRuntime.start(effectAgent.agentId).outcome()).status).toBe('succeeded')
    expect([...effectRuntime.state.results.values()].find((result) => result.effectId === 'effect-1')).toMatchObject({ privacy: 'local_only', derivedFrom: ['source'] })
  })

  it('keeps provenance while a parent waits for children to finish', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'closing', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const fork = validateStep(state, root.id, { actions: [{ type: 'fork', lanes: [{ key: 'child', goal: 'child', program: { programId: 'p', programVersion: '1', step: 'start', locals: {} } }] }], next: { programId: 'p', programVersion: '1', step: 'wait', locals: {} } })
    expect('rejection' in fork).toBe(false)
    if (!('rejection' in fork)) apply(state, fork.mutations)
    state.results.set('source', { id: 'source', value: {}, privacy: 'local_only', derivedFrom: [] })
    state.lanes.get(root.id)!.visibleResultRefs!.add('source')
    const closing = validateStep(state, root.id, { actions: [{ type: 'complete', result: { done: true }, derivedFrom: ['source'], children: 'await' }], next: { programId: 'p', programVersion: '1', step: 'wait', locals: {} } })
    expect('rejection' in closing).toBe(false)
    if (!('rejection' in closing)) expect(closing.mutations.find((mutation) => mutation.op === 'setLane' && mutation.laneId === root.id)).toMatchObject({ record: { closingResult: { privacy: 'local_only', derivedFrom: ['source'] } } })
  })
})
