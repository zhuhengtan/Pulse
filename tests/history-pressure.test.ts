import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, defineLaneProgram, validateStep } from '@pulse/runtime'

const point = (step: string) => ({ programId: 'history', programVersion: '1', step, locals: {} })

describe('history pressure and compaction', () => {
  it('rejects a step beyond hardTokens until it submits a valid compaction', () => {
    const state = createRuntimeState(8, { historySoftTokens: 1, historyHardTokens: 2 })
    const { root } = createAgent(state, 'history', point('start'))
    root.context.history = [{ seq: 7, instruction: 'old', resultRefs: [], output: { long: 'history' }, privacy: 'public' }]
    const rejected = validateStep(state, root.id, { actions: [], next: point('next') })
    expect('rejection' in rejected && rejected.rejection.code).toBe('CONTEXT_TOO_LARGE')
    state.results.set('summary', { id: 'summary', value: { compacted: true }, summary: { compacted: true }, privacy: 'public', derivedFrom: [] })
    root.visibleResultRefs!.add('summary')
    const accepted = validateStep(state, root.id, { contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'compact_history', upToSeq: 7, summaryRef: 'summary' }] }, actions: [], next: point('next') })
    expect('rejection' in accepted).toBe(false)
    if (!('rejection' in accepted)) {
      apply(state, accepted.mutations)
      expect(state.lanes.get(root.id)?.context.history).toMatchObject([{ seq: 7, resultRefs: ['summary'] }])
    }
  })

  it('inserts summarize/apply steps at a macro boundary', () => {
    const program = defineLaneProgram({ id: 'history', version: '1', historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 } }, (builder) => {
      builder.addStep('work', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'work' }))
    })
    const state = createRuntimeState()
    const { root } = createAgent(state, 'history', point('work'))
    root.historyPressure = { historyTokens: 100, softTokens: 10, hardTokens: 200 }
    root.context.history = [
      { seq: 3, instruction: 'old', resultRefs: [], output: { old: true }, privacy: 'public' },
      { seq: 9, instruction: 'recent', resultRefs: [], output: { recent: true }, privacy: 'public' },
    ]
    const output = program.step({ lane: root, state, now: 0 })
    expect(output.next.step).toBe('$compact:summarize')
    expect((output.next.locals as Record<string, any>).$sdk.compactPending).toBe(true)
    const summarize = program.step({ lane: { ...root, resume: output.next, historyPressure: root.historyPressure }, state, now: 0 })
    expect(summarize.next.step).toBe('$compact:apply')
    expect(summarize.actions[0]).toMatchObject({ type: 'submit_effects', effects: [{ key: '$compact-summary', input: { task: 'summarize', upToSeq: 3 } }] })
  })
})
