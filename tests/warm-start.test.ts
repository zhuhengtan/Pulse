import { describe, expect, it } from 'vitest'
import { FileRuntimeSessionStore, InMemoryRuntimeSessionStore, PulseRuntime, SqliteRuntimeSessionStore, exportWarmStartSession } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('explicit warm start', () => {
  it('copies the selected Global version once and keeps the new Agent isolated', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'warm', version: '1', step: () => ({ actions: [{ type: 'complete', result: {} }], next: { programId: 'warm', programVersion: '1', step: 'done', locals: {} } }) }
    const source = runtime.createAgent('source', program)
    const sourceRecord = runtime.state.agents.get(source.agentId)!
    sourceRecord.globalVersions.set(3, { facts: ['known'], privacy: 'local_only' })
    sourceRecord.globalPrivacy!.set(3, { privacy: 'local_only', privacyTaints: [{ path: ['facts'], privacy: 'local_only' }] })
    sourceRecord.latestGlobalVersion = 3
    const child = runtime.createAgent({ goal: 'warm child', program, warmStart: { agentId: source.agentId, globalVersion: 3 } })
    const childRecord = runtime.state.agents.get(child.agentId)!
    expect(childRecord.globalVersions.get(0)).toEqual({ facts: ['known'], privacy: 'local_only' })
    expect(childRecord.globalPrivacy?.get(0)).toEqual({ privacy: 'local_only', privacyTaints: [{ path: ['facts'], privacy: 'local_only' }] })
    ;(childRecord.globalVersions.get(0) as any).facts.push('child-only')
    expect(sourceRecord.globalVersions.get(3)).toEqual({ facts: ['known'], privacy: 'local_only' })
  })

  it('accepts the architecture-level sessionId from a PulseSession handle', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'warm-session', version: '1', step: () => ({ actions: [{ type: 'complete', result: {} }], next: { programId: 'warm-session', programVersion: '1', step: 'done', locals: {} } }) }
    const source = runtime.createAgent('source', program)
    const session = runtime.start(source.agentId)
    runtime.state.agents.get(source.agentId)!.globalVersions.set(1, { fact: 'from-session' })
    runtime.state.agents.get(source.agentId)!.latestGlobalVersion = 1
    const adopted = runtime.createAgent({ goal: 'adopted', program, warmStart: { sessionId: session.sessionId, globalVersion: 'final' } })
    expect(runtime.state.agents.get(adopted.agentId)?.globalVersions.get(0)).toEqual({ fact: 'from-session' })
  })

  it('requires an explicit existing source and version', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'warm-error', version: '1', step: () => ({ actions: [], next: { programId: 'warm-error', programVersion: '1', step: 'done', locals: {} } }) }
    expect(() => runtime.createAgent({ goal: 'missing', program, warmStart: { agentId: 'agent-missing' } })).toThrow('WARM_START_SOURCE_NOT_FOUND')
  })

  it('rejects malformed warm-start references before storing them', () => {
    const snapshot = { schemaVersion: 1 as const, sessionId: 'session', agent: { rootLaneId: 'lane-1', latestGlobalVersion: 0, globalVersions: [[0, {}] as [number, any]] }, visibleResultRefs: ['missing'], results: [] }
    expect(() => new InMemoryRuntimeSessionStore().put(snapshot)).toThrow('INVALID_RUNTIME_SESSION_SNAPSHOT')
  })

  it('filters findings by include mode and explicitly carries selected ResultRefs', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'warm-filter', version: '1', step: () => ({ actions: [{ type: 'complete', result: {} }], next: { programId: 'warm-filter', programVersion: '1', step: 'done', locals: {} } }) }
    const source = runtime.createAgent('source', program)
    const sourceRecord = runtime.state.agents.get(source.agentId)!
    sourceRecord.globalVersions.set(1, { facts: ['known'], findings: [{ ref: 'finding-a' }, { ref: 'finding-b' }] })
    sourceRecord.latestGlobalVersion = 1
    runtime.state.results.set('finding-a', { id: 'finding-a', value: { evidence: true }, privacy: 'public', derivedFrom: [] })
    runtime.state.lanes.get(source.laneId)!.visibleResultRefs!.add('finding-a')
    runtime.state.results.set('finding-b', { id: 'finding-b', value: { evidence: false }, privacy: 'public', derivedFrom: [] })
    runtime.state.lanes.get(source.laneId)!.visibleResultRefs!.add('finding-b')
    const child = runtime.createAgent({ goal: 'facts only', program, warmStart: { agentId: source.agentId, globalVersion: 1, include: 'facts', relevanceRefs: ['finding-a'] } })
    expect(runtime.state.agents.get(child.agentId)?.globalVersions.get(0)).toEqual({ facts: ['known'] })
    expect(runtime.state.lanes.get(child.laneId)?.visibleResultRefs).toEqual(new Set(['finding-a']))
    const findings = runtime.createAgent({ goal: 'selected findings', program, warmStart: { agentId: source.agentId, globalVersion: 1, include: 'facts_and_findings', relevanceRefs: ['finding-b'] } })
    expect(runtime.state.agents.get(findings.agentId)?.globalVersions.get(0)).toEqual({ facts: ['known'], findings: [{ ref: 'finding-b' }] })
  })

  it('warm-starts across Runtime instances through a SessionStore and copies selected ResultRefs', () => {
    const store = new InMemoryRuntimeSessionStore()
    const source = new PulseRuntime({ sessionStore: store })
    const program: LaneProgram = { id: 'cross-runtime-warm-start', version: '1', step: () => ({ actions: [{ type: 'complete', result: {} }], next: { programId: 'cross-runtime-warm-start', programVersion: '1', step: 'done', locals: {} } }) }
    const created = source.createAgent('source', program)
    source.state.agents.get(created.agentId)!.globalVersions.set(1, { facts: { answer: 42 }, findings: [{ ref: 'result-1', statement: 'keep me' }] })
    source.state.agents.get(created.agentId)!.globalPrivacy!.set(1, { privacy: 'local_only' })
    source.state.agents.get(created.agentId)!.latestGlobalVersion = 1
    source.state.results.set('result-1', { id: 'result-1', value: { statement: 'keep me' }, privacy: 'local_only', derivedFrom: [] })
    source.state.lanes.get(created.laneId)!.visibleResultRefs!.add('result-1')
    store.put(exportWarmStartSession(source.state, created.agentId))

    const target = new PulseRuntime({ sessionStore: store })
    const copied = target.createAgent({ goal: 'target', program, warmStart: { sessionId: created.agentId, globalVersion: 1, include: 'facts_and_findings', relevanceRefs: ['result-1'] } })
    const agent = target.state.agents.get(copied.agentId)!
    expect(agent.globalVersions.get(0)).toEqual({ facts: { answer: 42 }, findings: [{ ref: 'result-1', statement: 'keep me' }] })
    expect(agent.globalPrivacy?.get(0)).toEqual({ privacy: 'local_only' })
    expect(target.state.results.get('result-1')).toMatchObject({ value: { statement: 'keep me' }, privacy: 'local_only' })
    expect(target.state.lanes.get(copied.laneId)?.visibleResultRefs).toEqual(new Set(['result-1']))
    expect(target.state.nextIds.result).toBeGreaterThanOrEqual(2)
  })

  it('persists cross-runtime warm-start snapshots and rejects stale file revisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-session-store-'))
    try {
      const filePath = join(directory, 'sessions.json')
      const sourceStore = new FileRuntimeSessionStore(filePath)
      const targetStore = new FileRuntimeSessionStore(filePath)
      const source = new PulseRuntime({ sessionStore: sourceStore })
      const program: LaneProgram = { id: 'file-session-store', version: '1', step: () => ({ actions: [{ type: 'complete', result: {} }], next: { programId: 'file-session-store', programVersion: '1', step: 'done', locals: {} } }) }
      const created = source.createAgent('source', program)
      source.state.agents.get(created.agentId)!.globalVersions.set(1, { facts: { durable: true } })
      source.state.agents.get(created.agentId)!.latestGlobalVersion = 1
      sourceStore.put(exportWarmStartSession(source.state, created.agentId))

      const target = new PulseRuntime({ sessionStore: targetStore })
      const copied = target.createAgent({ goal: 'target', program, warmStart: { sessionId: created.agentId, globalVersion: 1 } })
      expect(target.state.agents.get(copied.agentId)?.globalVersions.get(0)).toEqual({ facts: { durable: true } })

      const current = targetStore.getWithRevision(created.agentId)!
      const stale = structuredClone(current.snapshot)
      stale.agent.latestGlobalVersion = 1
      stale.agent.globalVersions = [[1, { facts: { stale: true } }]]
      delete stale.agent.globalPrivacy
      expect(sourceStore.putIfRevision(stale, current.revision)).toBe(current.revision + 1)
      await expect(Promise.resolve().then(() => targetStore.putIfRevision(current.snapshot, current.revision))).rejects.toThrow('RUNTIME_SESSION_STORE_CONFLICT')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('supports durable SQLite Session Store revisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-session-store-'))
    try {
      const filePath = join(directory, 'sessions.db')
      const first = new SqliteRuntimeSessionStore(filePath)
      const snapshot = { schemaVersion: 1 as const, sessionId: 'session-sqlite', agent: { rootLaneId: 'lane-1', latestGlobalVersion: 0, globalVersions: [[0, { facts: ['x'] }] as [number, any]] }, visibleResultRefs: [], results: [] }
      expect(first.putIfRevision(snapshot)).toBe(1)
      const second = new SqliteRuntimeSessionStore(filePath)
      expect(second.getWithRevision('session-sqlite')).toMatchObject({ revision: 1, snapshot })
      const next = structuredClone(snapshot)
      next.agent.latestGlobalVersion = 1
      next.agent.globalVersions = [[1, { facts: ['y'] }]]
      expect(second.putIfRevision(next, 1)).toBe(2)
      expect(() => first.putIfRevision(snapshot, 1)).toThrow('RUNTIME_SESSION_STORE_CONFLICT')
      first.close()
      second.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
