import { describe, expect, it } from 'vitest'
import { apply, commitMutationTransaction, createAgent, createRuntimeState, MutationLog, prepareArtifactPublication, prepareFindingPublication } from '@pulse/runtime'

describe('mutation log and replay', () => {
  it('records idempotent transactions and replays Map/Set-bearing mutations', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'replay', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const log = new MutationLog()
    const mutations = [
      { op: 'setGlobal' as const, agentId: agent.id, version: 1, value: { answer: 42 } },
      { op: 'setLane', laneId: root.id, record: { ...root, children: new Set(['child']), ownedEffectIds: new Set(['effect']) } },
      { op: 'appendEvent' as const, event: { type: 'replayed', laneId: root.id, data: { ok: true } } },
    ]
    const first = commitMutationTransaction(state, log, 'tx-1', mutations)
    const duplicate = commitMutationTransaction(state, log, 'tx-1', mutations)
    expect(duplicate.seq).toBe(first.seq)
    expect(log.size).toBe(1)

    const restored = createRuntimeState()
    createAgent(restored, 'replay', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    log.replay(restored)
    expect(restored.agents.get(agent.id)?.globalVersions.get(1)).toEqual({ answer: 42 })
    expect(restored.lanes.get(root.id)?.children).toEqual(new Set(['child']))
    expect(restored.events[0]?.id).toBe('event-1')
  })

  it('serializes, validates checksums, and rejects tampered or non-contiguous logs', () => {
    const log = new MutationLog()
    log.append('tx-1', [{ op: 'setNow', now: 7 }], 7)
    const restored = MutationLog.fromSnapshot(JSON.parse(JSON.stringify(log.snapshot())))
    const state = createRuntimeState()
    restored.replay(state)
    expect(state.now).toBe(7)
    const tampered = JSON.parse(JSON.stringify(log.snapshot()))
    tampered.entries[0].mutations[0].now = 8
    expect(() => MutationLog.fromSnapshot(tampered)).toThrow('INVALID_MUTATION_LOG')
    const gap = JSON.parse(JSON.stringify(log.snapshot()))
    gap.entries[0].seq = 2
    expect(() => MutationLog.fromSnapshot(gap)).toThrow('INVALID_MUTATION_LOG')
  })

  it('replays Artifact publication together with the Result reference it supports', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'artifact replay', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const record = prepareArtifactPublication(state, { mediaType: 'text/plain', content: 'durable', laneId: root.id })
    const log = new MutationLog()
    commitMutationTransaction(state, log, 'artifact-transaction', [{ op: 'publishArtifact', record }])
    const restored = createRuntimeState()
    createAgent(restored, 'artifact replay', { programId: 'p', programVersion: '1', step: 'start', locals: {} }, agent.id)
    log.replay(restored)
    expect(restored.artifacts.get(record.ref)).toMatchObject({ ref: record.ref, contentBase64: record.contentBase64, agentId: agent.id })
    expect(restored.nextIds.artifact).toBe(2)
  })

  it('replays Finding publication and advances the shared result sequence', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'finding replay', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const artifact = prepareArtifactPublication(state, { mediaType: 'text/plain', content: 'evidence', laneId: root.id })
    commitMutationTransaction(state, new MutationLog(), 'artifact-for-finding', [{ op: 'publishArtifact', record: artifact }])
    const record = prepareFindingPublication(state, { statement: 'Evidence is available.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }], laneId: root.id })
    const log = new MutationLog()
    commitMutationTransaction(state, log, 'finding-transaction', [{ op: 'publishFinding', record }])
    const restored = createRuntimeState()
    createAgent(restored, 'finding replay', { programId: 'p', programVersion: '1', step: 'start', locals: {} }, agent.id)
    restored.artifacts.set(artifact.ref, artifact)
    log.replay(restored)
    expect(restored.results.get(record.id)).toMatchObject({ kind: 'finding', statement: record.statement, evidenceRefs: record.evidenceRefs })
    expect(restored.lanes.get(root.id)?.visibleResultRefs?.has(record.id)).toBe(true)
    expect(restored.nextIds.result).toBe(2)
  })

  it('truncates through a checkpoint watermark while preserving sequence continuity', () => {
    const log = new MutationLog()
    log.append('tx-1', [{ op: 'setNow', now: 1 }], 1)
    log.append('tx-2', [{ op: 'setNow', now: 2 }], 2)
    log.truncateThrough(2)
    expect(log.watermark).toBe(2)
    expect(log.size).toBe(0)
    log.append('tx-3', [{ op: 'setNow', now: 3 }], 3)
    const restored = MutationLog.fromSnapshot(JSON.parse(JSON.stringify(log.snapshot())))
    expect(restored.entries[0]?.seq).toBe(3)
  })

  it('preflights apply so an invalid transaction cannot leave state or log partially committed', () => {
    const state = createRuntimeState()
    const log = new MutationLog()
    const before = structuredClone(state)
    expect(() => commitMutationTransaction(state, log, 'invalid', [{ op: 'setGlobal', agentId: 'missing', version: 1, value: {} }])).toThrow()
    expect(state).toEqual(before)
    expect(log.size).toBe(0)
  })
})
