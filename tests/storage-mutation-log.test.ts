import { describe, expect, it } from 'vitest'
import { apply, commitMutationTransaction, createAgent, createRuntimeState, MutationLog, prepareArtifactPublication, prepareFindingPublication } from '@hunterzhu/pulse-runtime'

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

  it('advances the shared result sequence when replaying a published Result', () => {
    const state = createRuntimeState()
    const log = new MutationLog()
    commitMutationTransaction(state, log, 'result-transaction', [{ op: 'publishResult', record: { id: 'result-7', value: { ok: true }, privacy: 'public', derivedFrom: [] } }])
    expect(state.nextIds.result).toBe(8)
    const restored = createRuntimeState()
    log.replay(restored)
    expect(restored.results.get('result-7')?.value).toEqual({ ok: true })
    expect(restored.nextIds.result).toBe(8)
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

  it.each(['apply', 'prepare'] as const)('isolates live records and visibility when %s fails after in-place mutations', (failure) => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'atomic', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    root.visibleResultRefs = new Set(['existing'])
    const before = structuredClone(state)
    const originalVersions = agent.globalVersions
    const originalContext = root.context
    const originalRefs = root.visibleResultRefs
    const log = new MutationLog()
    const mutations = [
      { op: 'setGlobal' as const, agentId: agent.id, version: 1, value: { next: true }, metadata: { privacy: 'local_only' as const } },
      { op: 'setLaneContext' as const, laneId: root.id, version: 1, value: { updated: true } },
      { op: 'publishFinding' as const, record: { id: 'finding-7', kind: 'finding' as const, producer: { kind: 'lane' as const, id: root.id }, value: { note: true }, statement: 'note', evidenceRefs: [], agentId: agent.id, laneId: root.id, privacy: 'public' as const, derivedFrom: [] } },
      { op: 'appendEvent' as const, event: { type: 'atomic.event' } },
    ]
    const invalid = failure === 'apply'
      ? { op: 'setGlobal', agentId: 'missing', version: 1, value: {} } as const
      : { op: 'setNow', now: (() => 1) } as never
    expect(() => commitMutationTransaction(state, log, 'atomic', [...mutations, invalid])).toThrow()
    expect(state).toEqual(before)
    expect(agent.globalVersions).toBe(originalVersions)
    expect(root.context).toBe(originalContext)
    expect(root.visibleResultRefs).toBe(originalRefs)
    expect(log.snapshot()).toEqual(new MutationLog().snapshot())

    // The rejected identity/sequence remains usable, and cold replay is exact.
    expect(commitMutationTransaction(state, log, 'atomic', mutations).seq).toBe(1)
    const committed = structuredClone(state)
    const restoredLog = MutationLog.fromSnapshot(JSON.parse(JSON.stringify(log.snapshot())))
    restoredLog.replay(before)
    expect(before).toEqual(committed)
    expect(commitMutationTransaction(state, log, 'atomic', mutations).seq).toBe(1)
    expect(state).toEqual(committed)
    expect(log.size).toBe(1)
  })

  it('does not consume a log sequence when mutation cloning fails', () => {
    const log = new MutationLog()
    const invalid = { op: 'setNow', now: (() => 1) } as never
    expect(() => log.append('invalid', [invalid])).toThrow()
    expect(log.size).toBe(0)
    expect(log.append('valid', [{ op: 'setNow', now: 1 }]).seq).toBe(1)
  })

  it('does not change state or log when transaction preparation fails after state preflight', () => {
    const state = createRuntimeState()
    const log = new MutationLog()
    const before = structuredClone(state)
    const invalid = { op: 'setNow', now: (() => 1) } as never
    expect(() => commitMutationTransaction(state, log, 'invalid', [invalid])).toThrow()
    expect(state).toEqual(before)
    expect(log.size).toBe(0)
  })
})


it('preserves the append cursor when checkpoint truncation leaves newer transactions', () => {
  const log = new MutationLog()
  log.append('saved', [])
  log.append('during-save-1', [])
  log.append('during-save-2', [])
  log.truncateThrough(1)
  expect(log.append('after-save', []).seq).toBe(4)
  const restored = MutationLog.fromSnapshot(JSON.parse(JSON.stringify(log.snapshot())))
  expect(restored.entries.map((entry) => entry.seq)).toEqual([2, 3, 4])
  expect(restored.append('after-restore', []).seq).toBe(5)
})
