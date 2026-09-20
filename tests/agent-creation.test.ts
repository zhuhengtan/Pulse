import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

const point = (programId: string) => ({ programId, programVersion: '1', step: 'start', locals: {} })

describe('Agent creation transaction', () => {
  it('commits the Agent, root Lane, and ID cursor as one MutationLog entry', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'creation', version: '1', step: () => ({ actions: [], next: point('creation') }) }
    const created = runtime.createAgent({ goal: 'atomic creation', program, maxActiveLanes: 3 })
    const entry = runtime.mutationLog.findTransaction(`agent:${created.agentId}:created`)
    expect(entry?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'setAgent', agentId: created.agentId, record: expect.objectContaining({ state: 'running', maxActiveLanes: 3 }) }),
      expect.objectContaining({ op: 'setLane', laneId: created.laneId, record: expect.objectContaining({ status: 'ready' }) }),
      expect.objectContaining({ op: 'setNextIds', nextIds: expect.objectContaining({ agent: 2, lane: 2 }) }),
    ]))
  })

  it('does not leave records or consume IDs when creation storage admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxSnapshotBytes: 1 } })
    const program: LaneProgram = { id: 'creation-limit', version: '1', step: () => ({ actions: [], next: point('creation-limit') }) }
    expect(() => runtime.createAgent('rejected creation', program)).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.agents.size).toBe(0)
    expect(runtime.state.lanes.size).toBe(0)
    expect(runtime.state.nextIds).toEqual(expect.objectContaining({ agent: 1, lane: 1 }))
    expect(runtime.mutationLog.findTransaction('agent:agent-1:created')).toBeUndefined()
  })
})
