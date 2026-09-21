import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('Host command API', () => {
  it('queues requestCancel and applies it only after the current Step returns', () => {
    const runtime = new PulseRuntime()
    let observedBeforeNextTick = false
    const program: LaneProgram = {
      id: 'host-cancel',
      version: '1',
      step: ({ lane }) => {
        if (lane.resume.step === 'start') {
          runtime.requestCancel(agentId)
          observedBeforeNextTick = runtime.state.agents.get(agentId)?.state === 'running'
          return { actions: [], next: point('host-cancel', 'done') }
        }
        return { actions: [{ type: 'complete', result: { ok: true } }], next: point('host-cancel', 'done') }
      },
    }
    const { agentId } = runtime.createAgent('cancel from host', program)
    runtime.tick()
    expect(observedBeforeNextTick).toBe(true)
    expect(runtime.state.agents.get(agentId)?.state).toBe('running')
    runtime.tick()
    expect(runtime.state.agents.get(agentId)?.state).toBe('cancelled')
    expect(runtime.state.events.some((event) => event.type === 'agent.cancelled' && event.agentId === agentId)).toBe(true)
    const cancellation = runtime.mutationLog.entries.find((entry) => entry.mutations.some((mutation) => mutation.op === 'setAgent' && mutation.agentId === agentId && mutation.record.state === 'cancelling'))
    expect(cancellation?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'appendEvent', event: expect.objectContaining({ type: 'command.applied', data: { eventId: 'host-command-1' } }) }),
    ]))
  })

  it('applies setLanePriority through one state-and-event transaction', () => {
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 0 })
    const program: LaneProgram = { id: 'host-priority', version: '1', step: () => ({ actions: [], next: point('host-priority', 'done') }) }
    const { laneId } = runtime.createAgent('priority from host', program)
    runtime.setLanePriority(laneId, 9)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)).toMatchObject({ priority: 9, version: 1 })
    const transaction = runtime.mutationLog.entries.find((entry) => entry.mutations.some((mutation) => mutation.op === 'appendEvent' && mutation.event.type === 'lane.priority_changed'))
    expect(transaction?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'setLane', laneId, record: expect.objectContaining({ priority: 9 }) }),
      expect.objectContaining({ op: 'appendEvent', event: expect.objectContaining({ type: 'lane.priority_changed', laneId }) }),
      expect.objectContaining({ op: 'appendEvent', event: expect.objectContaining({ type: 'command.applied', data: { eventId: 'host-command-1' } }) }),
    ]))
    expect(runtime.inspectLane(laneId)).toMatchObject({ lanes: [{ id: laneId, basePriority: 9 }] })
  })

  it('rejects a priority command atomically when event storage admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1 } })
    const program: LaneProgram = { id: 'host-priority-admission', version: '1', step: () => ({ actions: [], next: point('host-priority-admission', 'done') }) }
    const { laneId } = runtime.createAgent('priority admission', program)
    runtime.setLanePriority(laneId, 9)
    expect(() => runtime.tick()).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.lanes.get(laneId)?.priority).toBe(0)
    expect(runtime.mutationLog.entries.some((entry) => entry.transactionId === `lane:${laneId}:priority:1`)).toBe(false)
  })

  it('exposes an EffectHandle whose cancellation is also queued through FactInbox', () => {
    const runtime = new PulseRuntime({ maxRunning: { tool: 0 } })
    const program: LaneProgram = { id: 'effect-handle', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'blocked', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('effect-handle', 'done') }) }
    runtime.createAgent('effect handle', program)
    runtime.tick()
    const handle = runtime.effectHandle('effect-1')
    expect(handle.status()).toBe('queued')
    handle.requestCancel('HOST_REQUESTED')
    expect(handle.status()).toBe('queued')
    runtime.tick()
    expect(handle.status()).toBe('cancelled')
    expect(runtime.state.events.some((event) => event.type === 'command.applied')).toBe(true)
    const settlement = runtime.mutationLog.entries.find((entry) => entry.mutations.some((mutation) => mutation.op === 'appendEvent' && mutation.event.type === 'effect.settled' && mutation.event.effectId === 'effect-1'))
    expect(settlement?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'appendEvent', event: expect.objectContaining({ type: 'command.applied', data: { eventId: 'host-command-1' } }) }),
    ]))
  })
})
