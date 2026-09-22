import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, defineLaneProgram, validateStep } from '@hunterzhu/pulse-runtime'

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
    const instructed = defineLaneProgram({ id: 'history', version: '1', historyCompaction: { summarizeTask: 'reason', instruction: 'Keep the durable facts.', keepRecentRounds: 1 } }, (builder) => {
      builder.addStep('work', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'work' }))
    })
    const instructedStep = instructed.step({ lane: { ...root, resume: output.next, historyPressure: root.historyPressure }, state, now: 0 })
    expect(instructedStep.actions[0]).toMatchObject({ type: 'submit_effects', effects: [{ key: '$compact-summary', input: { task: 'reason', instruction: 'Keep the durable facts.', upToSeq: 3 } }] })
  })

  it('does not summarize a prefix that is already a single compaction record', () => {
    const program = defineLaneProgram({ id: 'history', version: '1', historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 } }, (builder) => {
      builder.addStep('work', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'work' }))
    })
    const state = createRuntimeState()
    const { root } = createAgent(state, 'history', point('work'))
    root.historyPressure = { historyTokens: 100, softTokens: 10, hardTokens: 200 }
    root.context.history = [
      { seq: 3, instruction: '[history compacted]', resultRefs: ['summary'], output: { compacted: true }, privacy: 'public' },
      { seq: 9, instruction: 'recent', resultRefs: [], output: { recent: true }, privacy: 'public' },
    ]
    const output = program.step({ lane: root, state, now: 0 })
    expect(output.next.step).toBe('work')
  })

  it('fails the compaction step when the summary Effect fails', () => {
    const program = defineLaneProgram({ id: 'history', version: '1', historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 } }, (builder) => {
      builder.addStep('work', () => ({ actions: [], next: 'work' }))
    })
    const state = createRuntimeState()
    const { root } = createAgent(state, 'history', point('work'))
    const lane = { ...root, resume: { ...root.resume, step: '$compact:apply', locals: { $sdk: { compactReturnStep: 'work', compactUpToSeq: 3 } } } }
    const resumeInput = { type: 'wait' as const, resolution: { waitId: 'wait-1', status: 'satisfied' as const, dependencies: { summary: { state: 'settled' as const, target: { kind: 'effect' as const, id: 'effect-1' }, outcome: { status: 'failed' as const, error: { code: 'SUMMARY_FAILED', message: 'summary provider failed' } } } } } }
    try {
      program.step({ lane, state, now: 0, resumeInput })
      throw new Error('expected compaction to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'SUMMARY_FAILED' })
    }
  })

  it('lets a ReAct decode hand off its current result before hard-limit compaction', () => {
    const program = defineLaneProgram({ id: 'react-history', version: '1', historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 } }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'inspect', onFinish: () => 'finish' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const state = createRuntimeState(8, { historySoftTokens: 1, historyHardTokens: 2 })
    const { root } = createAgent(state, 'react history', { programId: 'react-history', programVersion: '1', step: 'reason:decode', locals: { $sdk: { reasonTurns: 1 } } })
    root.context.history = [
      { seq: 1, instruction: 'old', resultRefs: [], output: { old: true }, privacy: 'public' },
      { seq: 2, instruction: 'recent', resultRefs: [], output: { recent: true }, privacy: 'public' },
    ]
    root.historyPressure = { historyTokens: 3, softTokens: 1, hardTokens: 2 }
    state.results.set('result-model', { id: 'result-model', value: { text: 'done', finishReason: 'stop', toolCalls: [] }, privacy: 'public', derivedFrom: [], producer: { kind: 'effect', id: 'effect-model' }, storageState: 'memory', pinCount: 0 })
    root.visibleResultRefs = new Set(['result-model'])
    const output = program.step({ lane: root, state, now: 0, resumeInput: { type: 'wait', resolution: { waitId: 'wait-model', status: 'satisfied', dependencies: { model: { state: 'settled', target: { kind: 'effect', id: 'effect-model' }, outcome: { status: 'succeeded', resultRef: 'result-model' } } } } } })
    expect(output.next.step).toBe('$compact:summarize')
    const accepted = validateStep(state, root.id, output)
    expect('rejection' in accepted).toBe(false)
    expect((output.next.locals as Record<string, any>).$sdk.reasonPendingResultRef).toBe('result-model')
    const summarize = program.step({ lane: { ...root, resume: output.next }, state, now: 0 })
    expect(summarize.next.step).toBe('$compact:apply')
    expect(summarize.actions[0]).toMatchObject({ type: 'submit_effects', effects: [{ key: '$compact-summary' }] })
    expect('rejection' in validateStep(state, root.id, summarize)).toBe(false)
  })
})
