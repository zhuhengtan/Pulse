import { describe, expect, it } from 'vitest'
import { MonotonicClock, PulseRuntime, VirtualClock } from '@pulse/runtime'
import type { EffectRecord, LaneProgram } from '@pulse/runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('runtime control boundaries', () => {
  it('rejects invalid RuntimeConfig values before constructing scheduler state', () => {
    expect(() => new PulseRuntime({ maxLaneStepsPerTick: -1 })).toThrow('INVALID_RUNTIME_CONFIG:maxLaneStepsPerTick')
    expect(() => new PulseRuntime({ agingIntervalMs: 0 })).toThrow('INVALID_RUNTIME_CONFIG:agingIntervalMs')
    expect(() => new PulseRuntime({ historySoftTokens: 100, historyHardTokens: 99 })).toThrow('INVALID_RUNTIME_CONFIG:historyHardTokens')
    expect(() => new PulseRuntime({ maxRunning: { tool: Number.NaN } })).toThrow('INVALID_RUNTIME_CONFIG:maxRunning.tool')
    expect(() => new PulseRuntime({ budget: { maxCostByCurrency: { USD: -1 } } })).toThrow('INVALID_RUNTIME_CONFIG:budget.maxCostByCurrency')
    expect(() => new PulseRuntime({ forkAffinity: 'invalid' as never })).toThrow('INVALID_RUNTIME_CONFIG:forkAffinity')
    expect(() => new PulseRuntime({ maxObservationEntries: -1 })).toThrow('INVALID_RUNTIME_CONFIG:maxObservationEntries')
    expect(() => new PulseRuntime({ maxObservationBytes: 0 })).not.toThrow()
  })

  it('uses the host-provided RuntimeClock', () => {
    const clock = new VirtualClock()
    const runtime = new PulseRuntime({ clock })
    expect(runtime.clock).toBe(clock)
    expect(runtime.clock.now()).toBe(0)
  })

  it('waits for a real monotonic timer instead of fast-forwarding it', async () => {
    const clock = new MonotonicClock()
    let fired = false
    clock.schedule(10, () => { fired = true })
    const deadline = clock.timers.nextAt()!
    await clock.waitUntil!(deadline)
    expect(fired).toBe(true)
    expect(clock.now()).toBeGreaterThanOrEqual(deadline)
  })

  it('runs Timer Effects against a real monotonic clock', async () => {
    const runtime = new PulseRuntime({ clock: new MonotonicClock() })
    const program: LaneProgram = { id: 'monotonic-timer', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'timer', kind: 'timer', concurrencyClass: 'none', input: { delayMs: 10 } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('monotonic-timer', 'finish') }
      : { actions: [{ type: 'complete', result: { fired: true } }], next: point('monotonic-timer', 'finish') } }
    const { agentId } = runtime.createAgent('monotonic timer', program)
    await expect(runtime.start(agentId).outcome()).resolves.toMatchObject({ status: 'succeeded' })
    expect(runtime.state.now).toBeGreaterThan(0)
  })

  it('treats maxRuntimeMs as a duration with a monotonic clock', () => {
    const clock = new MonotonicClock()
    const runtime = new PulseRuntime({ clock, maxRuntimeMs: 1_000, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'monotonic-runtime-limit', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'pending', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('monotonic-runtime-limit', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('monotonic-runtime-limit', 'finish') } }
    const { agentId } = runtime.createAgent('monotonic runtime limit', program)
    runtime.tick()
    expect(runtime.state.agents.get(agentId)?.state).toBe('running')

    clock.advance(1_001)
    runtime.tick()
    expect(runtime.state.agents.get(agentId)?.state).not.toBe('running')
  })

  it('anchors a restored runtime limit to the new host clock', () => {
    const source = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'restored-runtime-limit', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'pending', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('restored-runtime-limit', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('restored-runtime-limit', 'finish') } }
    const { agentId } = source.createAgent('restored runtime limit', program)
    source.tick()
    const restored = new PulseRuntime({ persistence: source.exportPersistence(), programs: [program], clock: new MonotonicClock(), maxRuntimeMs: 1_000, effectExecutor: async () => await new Promise(() => undefined) })
    restored.tick()
    expect(restored.state.agents.get(agentId)?.state).toBe('running')
  })

  it('fails a Lane after the configured consecutive control-error limit', () => {
    const runtime = new PulseRuntime({ maxConsecutiveControlErrors: 2 })
    const program: LaneProgram = { id: 'control-loop', version: '1', step: () => ({ actions: [], next: point('control-loop', '') }) }
    const { laneId } = runtime.createAgent('invalid program output', program)
    runtime.tick()
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'lane.failed' && (event.data as any)?.code === 'CONTROL_ERROR_LOOP')).toBe(true)
  })

  it('fails closed when an untyped async Step crosses the synchronous boundary', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'async-step', version: '1', step: (() => Promise.resolve({ actions: [], next: point('async-step', 'done') })) as unknown as LaneProgram['step'] }
    const { laneId } = runtime.createAgent('async step', program)
    expect(() => runtime.tick()).not.toThrow()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'lane.failed' && (event.data as any)?.code === 'ASYNC_STEP_FORBIDDEN')).toBe(true)
  })

  it('still commits a Lane failure when the fact-event budget cannot fit the audit event', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1 } })
    const program: LaneProgram = { id: 'lane-failure-event-limit', version: '1', step: (() => Promise.resolve({ actions: [], next: point('lane-failure-event-limit', 'done') })) as unknown as LaneProgram['step'] }
    const { laneId } = runtime.createAgent('lane failure event limit', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('ASYNC_STEP_FORBIDDEN')
    expect(runtime.state.events).toHaveLength(0)
  })

  it('rejects impure Steps before they enter the scheduler', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'impure-step', version: '1', step: () => ({ actions: [{ type: 'complete', result: Date.now() }], next: point('impure-step', 'done') }) }
    expect(() => runtime.createAgent('impure step', program)).toThrow('ASYNC_STEP_NOT_ALLOWED:Date.now(')
  })

  it('turns a stuck attempt timeout into a terminal outcome without waiting forever', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'attempt-timeout', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'slow', kind: 'tool', concurrencyClass: 'tool', input: {}, attemptTimeoutMs: 5, cancelGraceMs: 0 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('attempt-timeout', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('attempt-timeout', 'finish') } }
    const { agentId, laneId } = runtime.createAgent('timeout', program)
    runtime.tick()
    runtime.clock.advance(5)
    expect(runtime.state.effects.get('effect-1')?.outcome?.status).toBe('cancelled')
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.lanes.get(laneId)?.status).toBe('succeeded')
  })

  it('lets an Agent reach cancelled while an uncooperative Executor remains quarantined', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'cancel-quarantine', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write', cancelGraceMs: 10 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('cancel-quarantine', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('cancel-quarantine', 'finish') } }
    const { agentId, laneId } = runtime.createAgent('cancel', program)
    runtime.tick()
    runtime.cancelAgent(agentId)
    runtime.clock.advance(10)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('cancelled')
    expect(runtime.mutationLog.entries.some((entry) =>
      entry.mutations.some((mutation) => mutation.op === 'setAgent' && mutation.agentId === agentId && mutation.record.state === 'cancelled')
    )).toBe(true)
    expect(outcome.unresolvedEffectIds).toEqual(['effect-1'])
    expect(runtime.state.lanes.get(laneId)?.unresolvedEffectIds).toEqual(['effect-1'])
    expect(runtime.state.lanes.get(laneId)?.cancelReason).toBe('USER_REQUESTED')
    expect(runtime.inspectLane(laneId)).toMatchObject({ lanes: [{ id: laneId, status: 'cancelled', cancelReason: 'USER_REQUESTED' }] })
    expect(runtime.state.effects.get('effect-1')?.state).toBe('reconcile_required')
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'setLane' && mutation.laneId === laneId && mutation.record.status === 'cancelled'))).toBe(true)
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'setEffect' && mutation.effectId === 'effect-1' && mutation.record.state === 'reconcile_required'))).toBe(true)
  })

  it('preserves a closing Lane pending Outcome when cancellation arrives during child cleanup', () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const childPoint = (step: string) => ({ programId: 'cancel-closing', programVersion: '1', step, locals: {} })
    const program: LaneProgram = { id: 'cancel-closing', version: '1', step: ({ lane }) => {
      if (lane.goal === 'parent' && lane.resume.step === 'start') return { actions: [{ type: 'fork', lanes: [{ key: 'child', goal: 'child', program: childPoint('child') }] }], next: childPoint('close') }
      if (lane.goal === 'parent' && lane.resume.step === 'close') return { actions: [{ type: 'complete', result: { joined: true }, children: 'await' }], next: childPoint('close') }
      if (lane.resume.step === 'child') return { actions: [{ type: 'submit_effects', effects: [{ key: 'child-work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: childPoint('child-done') }
      return { actions: [{ type: 'complete', result: { child: true } }], next: childPoint('child-done') }
    } }
    const { agentId, laneId } = runtime.createAgent('parent', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)).toMatchObject({ status: 'waiting', closingResult: { value: { joined: true } } })
    runtime.cancelAgent(agentId, 'USER_REQUESTED')
    expect(runtime.state.lanes.get(laneId)).toMatchObject({ status: 'succeeded', cancelReason: 'USER_REQUESTED' })
    expect(runtime.state.agents.get(agentId)?.state).toBe('succeeded')
    expect([...runtime.state.results.values()].some((result) => (result.value as { joined?: boolean }).joined === true)).toBe(true)
  })

  it('rejects cancellation before mutating state when event storage admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1 } })
    const program: LaneProgram = { id: 'cancel-admission', version: '1', step: () => ({ actions: [], next: point('cancel-admission', 'done') }) }
    const { agentId, laneId } = runtime.createAgent('cancel admission', program)
    expect(() => runtime.cancelAgent(agentId)).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.agents.get(agentId)?.state).toBe('running')
    expect(runtime.state.lanes.get(laneId)?.status).toBe('ready')
    expect(runtime.state.events).toHaveLength(0)
  })

  it('rejects immediate effect quarantine before mutating state when event storage admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 100_000 }, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'quarantine-admission', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write' }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('quarantine-admission', 'done') }) }
    runtime.createAgent('quarantine admission', program)
    runtime.tick()
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = 1
    const eventCount = runtime.state.events.length
    expect(() => runtime.cancelEffect('effect-1')).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.effects.get('effect-1')).toMatchObject({ state: 'running', executionState: 'running' })
    expect(runtime.state.effects.get('effect-1')?.cancelRequested).toBeUndefined()
    expect(runtime.state.events).toHaveLength(eventCount)
  })

  it('pre-admits the complete Agent cancellation cascade before mutating any target', () => {
    const build = () => {
      const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1_000_000 }, effectExecutor: async () => await new Promise(() => undefined) })
      const program: LaneProgram = { id: 'cancel-cascade-admission', version: '1', step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write' }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('cancel-cascade-admission', 'finish') }
        : { actions: [{ type: 'complete', result: { ok: true } }], next: point('cancel-cascade-admission', 'finish') } }
      const { agentId, laneId } = runtime.createAgent('cancel cascade', program)
      runtime.tick()
      return { runtime, agentId, laneId }
    }
    const probe = build()
    const beforeBytes = probe.runtime.storagePolicy.snapshot().records.filter((record) => record.kind === 'event').reduce((total, record) => total + record.bytes, 0)
    probe.runtime.cancelAgent(probe.agentId)
    const cancellationBytes = probe.runtime.storagePolicy.snapshot().records.filter((record) => record.kind === 'event').reduce((total, record) => total + record.bytes, 0) - beforeBytes

    const candidate = build()
    ;(candidate.runtime.storagePolicy as any).limits.maxEventLogBytes = beforeBytes + cancellationBytes - 1
    const beforeEvents = candidate.runtime.state.events.length
    const beforeLaneStatus = candidate.runtime.state.lanes.get(candidate.laneId)?.status
    expect(() => candidate.runtime.cancelAgent(candidate.agentId)).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(candidate.runtime.state.agents.get(candidate.agentId)?.state).toBe('running')
    expect(candidate.runtime.state.lanes.get(candidate.laneId)?.status).toBe(beforeLaneStatus)
    expect(candidate.runtime.state.effects.get('effect-1')).toMatchObject({ state: 'running', executionState: 'running' })
    expect(candidate.runtime.state.events).toHaveLength(beforeEvents)
  })

  it('rejects remote-unknown admission before mutating the Effect or quarantine', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1 } })
    const { agentId, laneId } = runtime.createAgent('remote unknown admission', { id: 'remote-unknown-admission', version: '1', step: () => ({ actions: [], next: point('remote-unknown-admission', 'done') }) })
    const effect: EffectRecord = { id: 'effect-1', agentId, ownerLaneId: laneId, key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'running', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'running', sideEffectState: 'none' }
    runtime.state.effects.set(effect.id, effect)
    runtime.state.lanes.get(laneId)!.ownedEffectIds.add(effect.id)
    expect(() => runtime.markRemoteUnknown(effect.id, 'unknown')).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.effects.get(effect.id)).toMatchObject({ state: 'running', executionState: 'running', sideEffectState: 'none' })
    expect(runtime.quarantine.unresolvedEffectIds).toEqual([])
    expect(runtime.state.events).toHaveLength(0)
  })

  it('does not partially mutate a retryable Remote Unknown when retry admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 100_000 } })
    const { agentId, laneId } = runtime.createAgent('remote retry admission', { id: 'remote-retry-admission', version: '1', step: () => ({ actions: [], next: point('remote-retry-admission', 'done') }) })
    const effect: EffectRecord = { id: 'effect-1', agentId, ownerLaneId: laneId, key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'running', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'running', sideEffectState: 'none', duplicateExecutionPolicy: 'allow', maxUnknownAttempts: 2, retryPolicy: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }
    runtime.state.effects.set(effect.id, effect)
    runtime.state.lanes.get(laneId)!.ownedEffectIds.add(effect.id)
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = 1
    expect(() => runtime.markRemoteUnknown(effect.id, 'known')).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.effects.get(effect.id)).toMatchObject({ state: 'running', attemptNo: 1, attemptId: 'effect-1-attempt-1', executionState: 'running' })
  })

  it('rejects reconciliation abandonment before removing the quarantine entry', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 100_000 } })
    const { agentId, laneId } = runtime.createAgent('abandon admission', { id: 'abandon-admission', version: '1', step: () => ({ actions: [], next: point('abandon-admission', 'done') }) })
    const effect: EffectRecord = { id: 'effect-1', agentId, ownerLaneId: laneId, key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'reconcile_required', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'remote_unknown', sideEffectState: 'unknown' }
    runtime.state.effects.set(effect.id, effect)
    runtime.state.lanes.get(laneId)!.ownedEffectIds.add(effect.id)
    runtime.state.lanes.get(laneId)!.unresolvedEffectIds = [effect.id]
    runtime.quarantine.add(effect.id, 0, 'in_doubt')
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = 1
    expect(() => runtime.abandonEffect(effect.id)).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.quarantine.unresolvedEffectIds).toEqual([effect.id])
    expect(runtime.state.effects.get(effect.id)).toMatchObject({ state: 'reconcile_required', executionState: 'remote_unknown' })
    expect(runtime.state.events).toHaveLength(0)
  })

  it('rejects wait deadline settlement before mutating the Wait or Lane when event storage admission fails', () => {
    const runtime = new PulseRuntime({ maxRunning: { tool: 0 }, storagePolicy: { maxEventLogBytes: 100_000 } })
    const program: LaneProgram = { id: 'wait-deadline-admission', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'blocked', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { deadlineAt: 0, onUnsatisfied: 'resume_with_error' } }], next: point('wait-deadline-admission', 'done') }) }
    runtime.createAgent('wait deadline admission', program)
    runtime.tick()
    const waitId = runtime.state.lanes.get('lane-1')?.activeWaitId
    expect(waitId).toBeDefined()
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = 1
    expect(() => runtime.clock.advance(0)).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.waits.get(waitId as string)?.state).toBe('pending')
    expect(runtime.state.lanes.get('lane-1')?.status).toBe('waiting')
  })

  it('does not mutate a Wait or Lane when dependency resolution storage admission fails', () => {
    const runtime = new PulseRuntime({ maxRunning: { tool: 0 }, storagePolicy: { maxSnapshotBytes: 100_000 } })
    const program: LaneProgram = { id: 'wait-resolution-admission', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'blocked', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('wait-resolution-admission', 'done') }) }
    runtime.createAgent('wait resolution admission', program)
    runtime.tick()
    const waitId = runtime.state.lanes.get('lane-1')?.activeWaitId
    expect(waitId).toBeDefined()
    runtime.state.effects.get('effect-1')!.outcome = { status: 'succeeded', resultRef: 'result-1' }
    ;(runtime.storagePolicy as any).limits.maxSnapshotBytes = 1
    expect(() => (runtime as any).refreshWaits()).not.toThrow()
    expect(runtime.state.waits.get(waitId as string)?.state).toBe('pending')
    expect(runtime.state.lanes.get('lane-1')?.status).toBe('waiting')
  })

  it('commits a Lane failure through MutationLog when Step storage admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxResultBytes: 100_000 } })
    const program: LaneProgram = { id: 'step-storage-limit', version: '1', step: () => ({ actions: [{ type: 'complete', result: { too: 'large' } }], next: point('step-storage-limit', 'done') }) }
    const { laneId } = runtime.createAgent('step storage limit', program)
    ;(runtime.storagePolicy as any).limits.maxResultBytes = 1
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('failed')
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'setLane' && mutation.laneId === laneId && mutation.record.status === 'failed'))).toBe(true)
  })

  it('contains Executor failures when dispatch audit events cannot fit the event budget', async () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 100_000 }, effectExecutor: async () => { throw new Error('executor failed') } })
    const program: LaneProgram = { id: 'dispatch-failure-admission', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('dispatch-failure-admission', 'done') }) }
    runtime.createAgent('dispatch failure admission', program)
    runtime.tick()
    const existingEventBytes = runtime.storagePolicy.inspect().filter((record) => record.kind === 'event').reduce((total, record) => total + record.bytes, 0)
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = existingEventBytes
    await expect(runtime.waitForIdle()).resolves.toBeUndefined()
    expect(runtime.state.effects.get('effect-1')?.outcome?.status).toBe('failed')
  })

  it('supports explicit quarantine abandonment without claiming side-effect absence', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'abandon-quarantine', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write', cancelGraceMs: 1 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('abandon-quarantine', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('abandon-quarantine', 'finish') } }
    const { agentId } = runtime.createAgent('abandon', program)
    runtime.tick()
    runtime.cancelAgent(agentId)
    runtime.clock.advance(1)
    runtime.abandonEffect('effect-1')
    expect(runtime.quarantine.unresolvedEffectIds).toEqual([])
    expect(runtime.state.effects.get('effect-1')?.outcome?.error?.code).toBe('RESOURCE_ABANDONED')
    expect(runtime.state.effects.get('effect-1')?.sideEffectState).toBe('unknown')
    expect(runtime.state.events.some((event) => event.type === 'resource.abandoned')).toBe(true)
  })

  it('does not report success when a root Lane is blocked without runnable work', async () => {
    const runtime = new PulseRuntime({ maxRunning: { tool: 0 } })
    const program: LaneProgram = { id: 'blocked', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'blocked', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('blocked', 'done') }) }
    const { agentId } = runtime.createAgent('blocked', program)
    runtime.tick()
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'runtime.idle_blocked')).toBe(true)
  })

  it('exposes lane, effect, and quarantine reasons through explain', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'explain', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('explain', 'done') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('explain', 'done') } }
    const { laneId } = runtime.createAgent('diagnose', program)
    runtime.tick()
    expect(runtime.explain(laneId)).toMatchObject({ lanes: [{ id: laneId, status: 'succeeded', consecutiveControlErrors: 0 }], effects: [{ id: 'effect-1', state: 'running' }] })
  })

  it('terminates a repeated no-progress Step at watchdog level 3', async () => {
    const runtime = new PulseRuntime({ watchdogNoProgressThreshold: 1, maxLaneStepsPerTick: 20 })
    const program: LaneProgram = { id: 'watchdog-runtime', version: '1', step: () => ({ actions: [], next: point('watchdog-runtime', 'loop') }) }
    const { agentId } = runtime.createAgent('loop', program)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'progress.no_progress_detected')).toBe(true)
  })

  it('commits Step mutations before dispatch and requeues a claimed Effect after persistence recovery', () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'outbox-runtime', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('outbox-runtime', 'done') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('outbox-runtime', 'done') } }
    const { agentId } = runtime.createAgent('outbox', program)
    runtime.tick()
    expect(runtime.mutationLog.entries.some((entry) => entry.transactionId === 'effect:effect-1:effect-1-attempt-1:dispatched')).toBe(true)
    expect(runtime.outbox.claimed().map((entry) => entry.effectId)).toEqual(['effect-1'])
    const recovered = new PulseRuntime({ persistence: runtime.exportPersistence(), effectExecutor: async () => await new Promise(() => undefined) })
    expect(recovered.outbox.pending().map((entry) => entry.effectId)).toEqual(['effect-1'])
    expect(recovered.state.events.some((event) => event.type === 'outbox.requeued')).toBe(true)
    expect(recovered.state.agents.has(agentId)).toBe(true)
  })

  it('commits control-error resume input and its audit event atomically', () => {
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1 })
    const program: LaneProgram = { id: 'atomic-control-error', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'bad', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'same', mode: 'shared' }, { resource: 'same', mode: 'exclusive' }] }] }], next: point('atomic-control-error', 'retry') }) }
    const { laneId } = runtime.createAgent('atomic control error', program)
    const lane = runtime.state.lanes.get(laneId)!
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)).toBe(lane)
    expect(lane.pendingResumeInput).toMatchObject({ type: 'control_error', error: { code: 'DUPLICATE_EFFECT_LOCK' } })
    expect(lane.version).toBe(1)
    const transaction = runtime.mutationLog.entries.find((entry) => entry.transactionId === `lane:${laneId}:control-error:1`)
    expect(transaction?.mutations.map((mutation) => mutation.op)).toEqual(['setLane', 'appendEvent'])
  })

  it('consumes control-error input and resets watchdog fields in the next Step transaction', () => {
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1 })
    const program: LaneProgram = { id: 'consume-control-error', version: '1', step: ({ resumeInput }) => resumeInput?.type === 'control_error'
      ? { actions: [{ type: 'complete', result: { recovered: true } }], next: point('consume-control-error', 'done') }
      : { actions: [{ type: 'submit_effects', effects: [{ key: 'bad', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'same', mode: 'shared' }, { resource: 'same', mode: 'exclusive' }] }] }], next: point('consume-control-error', 'retry') } }
    const { laneId } = runtime.createAgent('consume control error', program)
    runtime.tick()
    const lane = runtime.state.lanes.get(laneId)!
    expect(lane.pendingResumeInput?.type).toBe('control_error')
    runtime.tick()
    const recoveredLane = runtime.state.lanes.get(laneId)!
    expect(recoveredLane.pendingResumeInput).toBeUndefined()
    expect(recoveredLane.consecutiveControlErrors).toBeUndefined()
    expect(recoveredLane.status).toBe('succeeded')
    const transaction = runtime.mutationLog.entries.find((entry) => entry.transactionId === `step:${laneId}:2`)
    const committedLane = transaction?.mutations.find((mutation) => mutation.op === 'setLane' && mutation.laneId === laneId)
    expect(committedLane && committedLane.op === 'setLane' ? committedLane.record.pendingResumeInput : undefined).toBeUndefined()
  })

  it('does not hide Agent terminal-state storage rejection behind a Lane outcome', async () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'agent-state-storage-rejection', version: '1', step: () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: point('agent-state-storage-rejection', 'done') }) }
    const { agentId } = runtime.createAgent('agent state storage rejection', program)
    ;(runtime.storagePolicy as any).limits.maxSnapshotBytes = 1
    await expect(runtime.start(agentId).outcome()).rejects.toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.agents.get(agentId)?.state).toBe('running')
  })

  it('retains a Host Fact when its transaction is rejected by storage admission', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'fact-retry', version: '1', step: () => ({ actions: [], next: point('fact-retry', 'start') }) }
    const { laneId } = runtime.createAgent('fact retry', program)
    runtime.setLanePriority(laneId, 7)
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = runtime.storagePolicy.inspect().filter((record) => record.kind === 'event').reduce((total, record) => total + record.bytes, 0)
    expect(() => runtime.tick()).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.factInbox.snapshot().queue).toMatchObject([{ fact: { type: 'set_lane_priority', laneId, priority: 7 } }])
    expect(runtime.state.events.some((event) => event.id === 'host-command-1')).toBe(false)
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = 1_000_000
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.priority).toBe(7)
    expect(runtime.state.events.filter((event) => event.id === 'host-command-1' && event.type === 'command.enqueued')).toHaveLength(1)
  })

  it('rebuilds ready work after persistence recovery', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const program: LaneProgram = { id: 'recover-ready', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [], next: point('recover-ready', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('recover-ready', 'finish') } }
    const created = runtime.createAgent('recover', program)
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence(), effectExecutor: async () => ({ value: { ok: true } }) })
    restored.register(program)
    expect(restored.ready.has(created.laneId)).toBe(true)
    expect((await restored.start(created.agentId).outcome()).status).toBe('succeeded')
  })

  it('stops recovery when an active Lane program version is unavailable', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'versioned-recovery', version: '1', step: () => ({ actions: [], next: point('versioned-recovery', 'done') }) }
    runtime.createAgent('versioned', program)
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence() })
    expect(() => restored.tick()).toThrow('PROGRAM_VERSION_UNAVAILABLE:versioned-recovery@1')
    restored.register(program)
    expect(() => restored.tick()).not.toThrow()
  })

  it('stops recovery when an active Tool version is unavailable', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'tool-version-recovery', version: '1', step: () => ({ actions: [], next: point('tool-version-recovery', 'done') }) }
    const { laneId } = runtime.createAgent('tool version', program)
    runtime.state.effects.set('effect-1', { id: 'effect-1', agentId: 'agent-1', ownerLaneId: laneId, key: 'write-file', kind: 'tool', concurrencyClass: 'tool', input: { name: 'write-file', arguments: {} }, toolVersion: '1', state: 'running', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'running', sideEffectState: 'none' })
    const snapshot = runtime.exportPersistence()
    const incompatible = new PulseRuntime({ persistence: snapshot, programs: [program], toolVersions: { 'write-file': '2' } })
    expect(() => incompatible.tick()).toThrow('TOOL_VERSION_UNAVAILABLE:write-file@1')
    const compatible = new PulseRuntime({ persistence: snapshot, programs: [program], toolVersions: { 'write-file': '1' } })
    expect(() => compatible.tick()).not.toThrow()
  })

  it('fails queued Effects closed when the Runtime attempt budget is exhausted', async () => {
    const runtime = new PulseRuntime({ budget: { maxTotalAttempts: 1 }, effectExecutor: async () => ({ value: { ok: true } }) })
    const program: LaneProgram = { id: 'attempt-budget', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'first', kind: 'tool', concurrencyClass: 'tool', input: {} }, { key: 'second', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('attempt-budget', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('attempt-budget', 'finish') } }
    const { agentId } = runtime.createAgent('budget', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.effects.get('effect-1')?.outcome?.status).toBe('succeeded')
    expect(runtime.state.effects.get('effect-2')?.outcome?.error?.code).toBe('BUDGET_EXCEEDED')
    expect(runtime.budgetUsage().attempts).toBe(1)
  })
})
