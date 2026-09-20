import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { EffectRecord, LaneProgram } from '@pulse/runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('runtime control boundaries', () => {
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
    expect(runtime.state.effects.get('effect-1')?.state).toBe('reconcile_required')
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'setLane' && mutation.laneId === laneId && mutation.record.status === 'cancelled'))).toBe(true)
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'setEffect' && mutation.effectId === 'effect-1' && mutation.record.state === 'reconcile_required'))).toBe(true)
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
