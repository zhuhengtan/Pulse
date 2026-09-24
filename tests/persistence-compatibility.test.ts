import { describe, expect, it } from 'vitest'
import { PulseRuntime, validateRuntimePersistenceSnapshot } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

describe('runtime persistence compatibility', () => {
  it('persists and restores an AgentCreateRequest initialGlobal value', () => {
    const program: LaneProgram = { id: 'initial-global', version: '1', step: () => ({ actions: [], next: { programId: 'initial-global', programVersion: '1', step: 'start', locals: {} } }) }
    const runtime = new PulseRuntime({ programs: [program] })
    const { agentId, laneId } = runtime.createAgent({
      goal: 'seed task context',
      program,
      initialGlobal: { task: { id: 'task-1', status: 'executing' } },
    })

    const snapshot = runtime.exportPersistence()
    const restored = new PulseRuntime({ persistence: snapshot, programs: [program] })
    expect(restored.state.agents.get(agentId)?.globalVersions.get(0)).toEqual({ task: { id: 'task-1', status: 'executing' } })
    expect(restored.state.lanes.get(laneId)?.status).toBe('ready')
  })

  it('rejects conflicting initialGlobal and warmStart context sources', () => {
    const program: LaneProgram = { id: 'initial-global-conflict', version: '1', step: () => ({ actions: [], next: { programId: 'initial-global-conflict', programVersion: '1', step: 'start', locals: {} } }) }
    const runtime = new PulseRuntime({ programs: [program] })

    expect(() => runtime.createAgent({
      goal: 'conflicting context sources',
      program,
      initialGlobal: { task: { id: 'task-1' } },
      warmStart: { agentId: 'source-agent' },
    })).toThrow('AGENT_INITIAL_GLOBAL_WARM_START_CONFLICT')
  })

  it('persists program, tool, policy and router versions and rejects incompatible restore hosts', () => {
    const program: LaneProgram = { id: 'compatibility', version: '1', step: () => ({ actions: [], next: { programId: 'compatibility', programVersion: '1', step: 'start', locals: {} } }) }
    const runtime = new PulseRuntime({ programs: [program], toolVersions: { read: '2' }, policyVersion: 'policy-4', routerVersion: 'router-7' })
    const snapshot = runtime.exportPersistence()
    expect(snapshot.compatibility).toEqual({ schemaVersion: 1, programVersions: { 'compatibility@1': '1' }, toolVersions: { read: '2' }, policyVersion: 'policy-4', routerVersion: 'router-7' })
    const compatible = new PulseRuntime({ persistence: snapshot, programs: [program], toolVersions: { read: '2' }, policyVersion: 'policy-4', routerVersion: 'router-7' })
    expect(() => compatible.tick()).not.toThrow()
    expect(() => { const restored = new PulseRuntime({ persistence: snapshot, programs: [program], toolVersions: { read: '1' }, policyVersion: 'policy-4', routerVersion: 'router-7' }); restored.tick() }).toThrow('TOOL_VERSION_UNAVAILABLE')
    expect(() => { const restored = new PulseRuntime({ persistence: snapshot, programs: [program], toolVersions: { read: '2' }, policyVersion: 'policy-3', routerVersion: 'router-7' }); restored.tick() }).toThrow('POLICY_VERSION_UNAVAILABLE')
    expect(() => { const restored = new PulseRuntime({ persistence: snapshot, programs: [program], toolVersions: { read: '2' }, policyVersion: 'policy-4', routerVersion: 'router-6' }); restored.tick() }).toThrow('ROUTER_VERSION_UNAVAILABLE')
  })

  it('rejects a persisted program version that is absent from the restore host', () => {
    const program: LaneProgram = { id: 'compatibility-missing', version: '2', step: () => ({ actions: [], next: { programId: 'compatibility-missing', programVersion: '2', step: 'start', locals: {} } }) }
    const snapshot = new PulseRuntime({ programs: [program] }).exportPersistence()
    const restored = new PulseRuntime({ persistence: snapshot })
    expect(() => restored.tick()).toThrow('PROGRAM_VERSION_UNAVAILABLE:compatibility-missing@2')
  })

  it('rejects quarantine snapshots that do not match an unknown reconcile-required Effect', () => {
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('quarantine snapshot', { id: 'quarantine-snapshot', version: '1', step: () => ({ actions: [], next: { programId: 'quarantine-snapshot', programVersion: '1', step: 'start', locals: {} } }) })
    runtime.state.effects.set('effect-q', { id: 'effect-q', agentId, ownerLaneId: laneId, key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'reconcile_required', attemptId: 'effect-q-attempt-1', attemptNo: 1, executionState: 'remote_unknown', sideEffectState: 'unknown' })
    const snapshot = runtime.exportPersistence()
    snapshot.quarantine = [{ effectId: 'effect-q', unresolvedAt: 0, reason: '' }]
    delete snapshot.integrity
    expect(() => validateRuntimePersistenceSnapshot(snapshot)).toThrow('INVALID_RUNTIME_PERSISTENCE_QUARANTINE')
    snapshot.quarantine = [{ effectId: 'effect-q', unresolvedAt: 0, reason: 'in_doubt' }, { effectId: 'effect-q', unresolvedAt: 0, reason: 'duplicate' }]
    expect(() => validateRuntimePersistenceSnapshot(snapshot)).toThrow('INVALID_RUNTIME_PERSISTENCE_QUARANTINE')
  })
})
