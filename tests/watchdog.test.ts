import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, observeProgress, progressFingerprint, PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

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
    let watchdog = observeProgress(root, output, state, undefined, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    expect(watchdog.interventionLevel).toBe(0)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    expect(watchdog.interventionLevel).toBe(1)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    expect(watchdog.interventionLevel).toBe(1)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    expect(watchdog.interventionLevel).toBe(2)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    expect(watchdog.interventionLevel).toBe(2)
    watchdog = observeProgress(root, output, state, watchdog, { noProgressThreshold: 2, repeatedActionThreshold: 1 }).state
    expect(watchdog.interventionLevel).toBe(3)
  })

  it('rejects a repeated external action before dispatch and eventually fails the Lane', async () => {
    let calls = 0
    const runtime = new PulseRuntime({
      watchdogNoProgressThreshold: 1,
      watchdogRepeatedActionThreshold: 2,
      effectExecutor: async () => { calls += 1; return { value: { ok: true } } },
    })
    const program: LaneProgram = { id: 'watchdog-admission', version: '1', step: () => ({
      actions: [{ type: 'submit_effects', effects: [{ key: 'same-action', kind: 'tool', concurrencyClass: 'tool', input: { query: 'same' } }], wait: { onUnsatisfied: 'resume_with_error' } }],
      next: { programId: 'watchdog-admission', programVersion: '1', step: 'loop', locals: {} },
    }) }
    const { agentId } = runtime.createAgent('repeat same action', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(calls).toBe(1)
    expect(runtime.state.events.some((event) => event.type === 'lane.failed' && JSON.stringify(event.data).includes('NO_PROGRESS_DETECTED'))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'progress.intervention_applied')).toBe(true)
  })
})
