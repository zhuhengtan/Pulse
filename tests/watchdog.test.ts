import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, observeProgress, progressFingerprint } from '@pulse/runtime'

describe('progress watchdog', () => {
  it('ignores SDK bookkeeping while fingerprinting Lane progress', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'watch', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const first = { actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'p', programVersion: '1', step: 'next', locals: { $sdk: { turn: 1 } } } }
    const second = { ...first, next: { ...first.next, locals: { $sdk: { turn: 2 } } } }
    expect(progressFingerprint(root, first, state)).toBe(progressFingerprint(root, second, state))
  })

  it('escalates repeated no-progress observations through three intervention levels', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'watch', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const output = { actions: [{ type: 'wait' as const, spec: { dependencies: [], mode: 'all' as const, onUnsatisfied: 'resume_with_error' as const, reason: 'dependency' as const } }], next: { programId: 'p', programVersion: '1', step: 'next', locals: {} } }
    let watchdog = observeProgress(root, output, state, undefined, { noProgressThreshold: 2 }).state
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2 }).state
    expect(watchdog.interventionLevel).toBe(0)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2 }).state
    expect(watchdog.interventionLevel).toBe(1)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2 }).state
    expect(watchdog.interventionLevel).toBe(1)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2 }).state
    expect(watchdog.interventionLevel).toBe(2)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2 }).state
    expect(watchdog.interventionLevel).toBe(2)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2 }).state
    expect(watchdog.interventionLevel).toBe(3)
  })
})
