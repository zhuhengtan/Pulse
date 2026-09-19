import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, exportRuntimeState, importRuntimeState, serializeRuntimeState } from '@pulse/runtime'

describe('session serialization boundary', () => {
  it('round-trips Runtime state without losing Maps, Sets, references, events, or Infinity limits', () => {
    const state = createRuntimeState(9, { maxQueuedEffects: 3, maxRunning: { tool: 2 } })
    const { agent, root } = createAgent(state, 'serialize', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    root.children.add('lane-child')
    root.ownedEffectIds.add('effect-1')
    state.events.push({ seq: 1, type: 'agent.created', laneId: root.id, data: { goal: agent.goal ?? 'serialize' } })
    const snapshot = exportRuntimeState(state)
    const restored = importRuntimeState(JSON.parse(JSON.stringify(serializeRuntimeState(state))))
    expect(restored.maxTotalLanes).toBe(9)
    expect(restored.maxRunning.none).toBe(Number.POSITIVE_INFINITY)
    expect(restored.agents.get(agent.id)?.globalVersions.get(0)).toEqual({})
    expect(restored.lanes.get(root.id)?.children).toEqual(new Set(['lane-child']))
    expect(restored.lanes.get(root.id)?.ownedEffectIds).toEqual(new Set(['effect-1']))
    expect(restored.events).toEqual(snapshot.state.events)
    expect(restored.nextIds).toEqual(state.nextIds)
  })

  it('rejects incompatible or malformed snapshot versions before creating state', () => {
    expect(() => importRuntimeState({ schemaVersion: 2 } as any)).toThrow('INVALID_SESSION_SNAPSHOT')
    expect(() => importRuntimeState({ schemaVersion: 1, state: { agents: [] } } as any)).toThrow('INVALID_SESSION_SNAPSHOT')
  })
})
