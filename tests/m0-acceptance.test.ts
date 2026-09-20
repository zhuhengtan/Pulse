import { describe, expect, it } from 'vitest'
import { PulseRuntime, apply, createAgent, createRuntimeState, validateStep } from '@pulse/runtime'
import type { LaneProgram, LaneStepOutput, RuntimeState } from '@pulse/runtime'

const point = (step: string, programId = 'm0') => ({ programId, programVersion: '1', step, locals: {} })
const submit = (key: string, kind: 'tool' | 'human' | 'timer' = 'tool', concurrencyClass: 'tool' | 'none' = kind === 'tool' ? 'tool' : 'none') => ({ type: 'submit_effects' as const, effects: [{ key, kind, concurrencyClass, input: {} }], wait: { onUnsatisfied: 'resume_with_error' as const } })

describe('M0 acceptance matrix', () => {
  it('routes a failed success dependency into an error-handling Step', async () => {
    const program: LaneProgram = { id: 'm0', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start' ? { actions: [{ type: 'submit_effects', effects: [{ key: 'failing', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('wait') } : lane.resume.step === 'wait' ? { actions: [{ type: 'wait', spec: { mode: 'all', dependencies: [{ key: 'failing', target: { kind: 'effect', id: 'effect-1' }, condition: 'success' }], onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: point('handle') } : { actions: [{ type: 'complete', result: { handled: resumeInput?.type === 'wait' && resumeInput.resolution.status === 'unsatisfied' } }], next: point('handle') } }
    const runtime = new PulseRuntime({ effectExecutor: async () => { throw new Error('tool failed') } })
    const { agentId } = runtime.createAgent('failure', program)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect(runtime.mutationLog.entries.some((entry) =>
      entry.mutations.some((mutation) => mutation.op === 'setAgent' && mutation.agentId === agentId && mutation.record.state === 'succeeded')
    )).toBe(true)
    expect([...runtime.state.results.values()].some((result) => (result.value as any).handled === true)).toBe(true)
  })

  it('settled waits expose failed and cancelled Outcomes and ignore cancellation when requested', async () => {
    let release: (() => void) | undefined
    const program: LaneProgram = { id: 'm0-settled', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start' ? { actions: [{ ...submit('work'), wait: { onUnsatisfied: 'resume_with_error', onCancelled: 'ignore' } }], next: point('finish', 'm0-settled') } : { actions: [{ type: 'complete', result: { wait: resumeInput?.type === 'wait' ? resumeInput.resolution.status : 'none' } }], next: point('finish', 'm0-settled') } }
    const runtime = new PulseRuntime({ effectExecutor: async (_effect, signal) => await new Promise((resolve, reject) => { release = () => resolve({ value: { ok: true } }); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }) })
    const { agentId } = runtime.createAgent('cancel', program)
    runtime.tick()
    const effect = [...runtime.state.effects.values()][0]!
    runtime.completeEffect(effect.id, { value: null, status: 'cancelled' }, 'cancelled')
    expect(runtime.state.effects.get(effect.id)?.outcome).toMatchObject({ status: 'cancelled', reason: 'CANCELLED' })
    await runtime.start(agentId).outcome()
    expect([...runtime.state.results.values()].some((result) => (result.value as any).wait === 'satisfied')).toBe(true)
    release?.()
  })

  it('does not lose a completion that happens before a Wait is registered', async () => {
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1 })
    const program: LaneProgram = { id: 'late-wait', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'one', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('wait', 'late-wait') }
      : lane.resume.step === 'wait'
        ? { actions: [{ type: 'wait', spec: { mode: 'all', dependencies: [{ key: 'one', target: { kind: 'effect', id: 'effect-1' }, condition: 'success' }], onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: point('done', 'late-wait') }
        : { actions: [{ type: 'complete', result: { resumed: resumeInput?.type } }], next: point('done', 'late-wait') } }
    const { agentId } = runtime.createAgent('late wait', program)
    runtime.tick()
    runtime.completeEffect('effect-1', { value: { ok: true } })
    runtime.tick()
    runtime.tick()
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect([...runtime.state.waits.values()][0]?.state).toBe('satisfied')
  })

  it('rejects dynamic sibling cycles and leaves no created lanes', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'cycle', point('start'))
    const output: LaneStepOutput = { actions: [{ type: 'fork', lanes: [
      { key: 'a', goal: 'a', program: point('start'), dependsOn: [{ key: 'b', target: { local: 'b' }, condition: 'success' }] },
      { key: 'b', goal: 'b', program: point('start'), dependsOn: [{ key: 'a', target: { local: 'a' }, condition: 'success' }] },
    ] }], next: point('next') }
    const result = validateStep(state, root.id, output)
    expect('rejection' in result && result.rejection.code).toBe('DEPENDENCY_CYCLE')
    expect(state.lanes.size).toBe(1)
  })

  it('rejects a later invalid action atomically after Context and Effect proposals', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'atomic', point('start'))
    const other = createAgent(state, 'other', point('start')).root
    const result = validateStep(state, root.id, { contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'set', path: ['x'], value: 1 }] }, actions: [submit('one'), { type: 'cancel_lane', laneId: other.id, reason: 'POLICY' }], next: point('next') })
    expect('rejection' in result && result.rejection.code).toBe('CANCEL_NOT_OWNER')
    expect(state.effects.size).toBe(0)
    expect(state.lanes.get(root.id)?.context.state).toEqual({})
  })

  it('enforces a hard queued-effect cap and does not keep a partial batch', () => {
    const state = createRuntimeState(64, { maxQueuedEffects: 1 })
    const { root } = createAgent(state, 'cap', point('start'))
    const result = validateStep(state, root.id, { actions: [{ type: 'submit_effects', effects: [{ key: 'a', kind: 'tool', concurrencyClass: 'tool', input: {} }, { key: 'b', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('next') })
    expect('rejection' in result && result.rejection.code).toBe('EFFECT_QUEUE_FULL')
    expect(state.effects.size).toBe(0)
  })

  it('never exceeds running slots, while Human and Timer effects bypass execution slots', async () => {
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const runtime = new PulseRuntime({ maxRunning: { tool: 1, llm: 1, agent: 1 }, effectExecutor: async (effect) => { started.push(effect.key); if (effect.concurrencyClass === 'tool') await new Promise<void>((resolve) => releases.set(effect.key, resolve)); return { value: { key: effect.key } } } })
    const program: LaneProgram = { id: 'slot', version: '1', step: ({ lane }) => lane.resume.step === 'start' ? { actions: [{ type: 'submit_effects', effects: [{ key: lane.goal, kind: 'tool', concurrencyClass: 'tool', input: {} }, { key: `${lane.goal}-human`, kind: 'human', concurrencyClass: 'none', input: {} }, { key: `${lane.goal}-timer`, kind: 'timer', concurrencyClass: 'none', input: {} }] }], next: point('done', 'slot') } : { actions: [{ type: 'complete', result: { done: true } }], next: point('done', 'slot') } }
    runtime.createAgent('a', program); runtime.createAgent('b', program)
    runtime.tick()
    expect(started.filter((key) => key === 'a' || key === 'b')).toHaveLength(1)
    expect(started.filter((key) => key.endsWith('-human') || key.endsWith('-timer'))).toHaveLength(4)
    releases.get('a')?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    releases.get('b')?.()
    await runtime.waitForIdle()
  })

  it('delivers sibling cancel proposals to the owner instead of allowing cross-branch cancellation', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'owner', point('start'))
    const childA = { id: 'lane-a', agentId: root.agentId, ownerLaneId: root.id, status: 'ready' as const, version: 0, goal: 'a', resume: point('start'), contextSnapshotVersion: 0, context: { version: 0, history: [], state: {} }, children: new Set<string>(), priority: 0, enqueueSeq: 1, readySince: 0, ownedEffectIds: new Set<string>() }
    const childB = { ...childA, id: 'lane-b', goal: 'b' }
    state.lanes.set(childA.id, childA); state.lanes.set(childB.id, childB); root.children.add(childA.id); root.children.add(childB.id)
    const result = validateStep(state, childA.id, { actions: [{ type: 'cancel_lane', laneId: childB.id, reason: 'SUPERSEDED' }], next: point('next') })
    expect('rejection' in result && result.rejection.code).toBe('CANCEL_NOT_OWNER')
    const proposal = validateStep(state, childA.id, { actions: [{ type: 'propose_cancel', laneId: childB.id, reason: 'SUPERSEDED' }], next: point('next') })
    expect('mutations' in proposal).toBe(true)
    if ('mutations' in proposal) apply(state, proposal.mutations)
    expect(state.lanes.get(root.id)?.pendingResumeInput?.type).toBe('control_proposal')
  })

  it('supports children cancel and await completion semantics', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'parent', point('start'))
    const child = createAgent(state, 'child', point('start')).root
    child.ownerLaneId = root.id; root.children.add(child.id); state.lanes.set(child.id, child)
    const cancel = validateStep(state, root.id, { actions: [{ type: 'complete', result: { done: true }, children: 'cancel' }], next: point('done') })
    expect('mutations' in cancel).toBe(true)
    if ('mutations' in cancel) apply(state, cancel.mutations)
    expect(state.lanes.get(child.id)?.status).toBe('cancelled')
    expect(state.lanes.get(root.id)?.status).toBe('succeeded')
  })

  it('preserves a closing child outcome when its owner cancels it', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'parent', point('start'))
    const child = createAgent(state, 'child', point('start')).root
    child.ownerLaneId = root.id
    child.status = 'waiting'
    child.closingResult = { value: { joined: true }, privacy: 'public' }
    root.children.add(child.id)
    state.lanes.set(child.id, child)
    const cancel = validateStep(state, root.id, { actions: [{ type: 'cancel_lane', laneId: child.id, reason: 'SUPERSEDED' }], next: point('next') })
    expect('mutations' in cancel).toBe(true)
    if ('mutations' in cancel) apply(state, cancel.mutations)
    expect(state.lanes.get(child.id)).toMatchObject({ status: 'cancelling', cancelReason: 'SUPERSEDED', pendingOutcome: { status: 'succeeded', result: { joined: true } } })
  })

  it('atomically rejects context, effect, cancel intent, resume and event proposals', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'atomic resume', point('start'))
    const other = createAgent(state, 'other', point('start')).root
    const before = structuredClone(state)
    const result = validateStep(state, root.id, { contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'set', path: ['x'], value: 1 }] }, actions: [{ type: 'submit_effects', effects: [{ key: 'effect', kind: 'tool', concurrencyClass: 'tool', input: {} }] }, { type: 'cancel_lane', laneId: other.id, reason: 'POLICY' }], next: { ...point('next'), step: '' } })
    expect('rejection' in result && result.rejection.code).toBe('INVALID_RESUME_POINT')
    expect(state.effects.size).toBe(before.effects.size)
    expect(state.events).toEqual(before.events)
    expect(state.lanes.get(root.id)?.context.state).toEqual(before.lanes.get(root.id)?.context.state)
  })

  it('retains in_doubt side effects in reconcile_required quarantine and can reconcile', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'unknown', version: '1', step: () => ({ actions: [submit('write')], next: point('done', 'unknown') }) }
    const { agentId } = runtime.createAgent('unknown', program)
    runtime.tick()
    const effect = [...runtime.state.effects.values()][0]!
    runtime.markRemoteUnknown(effect.id, 'unknown')
    expect(effect.state).toBe('reconcile_required')
    expect(runtime.quarantine.unresolvedEffectIds).toContain(effect.id)
    runtime.reconcileEffect(effect.id, { reconciled: true })
    expect(effect.state).toBe('succeeded')
    expect(runtime.quarantine.unresolvedEffectIds).toEqual([])
    void agentId
  })
})
