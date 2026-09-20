import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, exportRuntimePersistence, importRuntimeState, publishArtifact, publishFinding, validateRuntimePersistenceSnapshot, PulseRuntime } from '@pulse/runtime'

describe('Finding evidence records', () => {
  it('publishes a privacy-inheriting finding with typed evidence refs', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'finding', { programId: 'finding', programVersion: '1', step: 'start', locals: {} })
    const artifact = publishArtifact(state, { mediaType: 'text/plain', content: 'secret', laneId: root.id, privacy: 'local_only' })
    const finding = publishFinding(state, { laneId: root.id, statement: 'The artifact is local-only.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }] })
    expect(finding).toMatchObject({ kind: 'finding', privacy: 'local_only', statement: 'The artifact is local-only.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }] })
    expect(state.results.get(finding.id)?.derivedFrom).toEqual([{ kind: 'artifact', ref: artifact.ref }])
    expect(state.lanes.get(root.id)?.visibleResultRefs?.has(finding.id)).toBe(true)
  })

  it('rejects invisible evidence and invalid persistence references', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'finding', { programId: 'finding', programVersion: '1', step: 'start', locals: {} })
    state.results.set('hidden', { id: 'hidden', value: true, privacy: 'public', derivedFrom: [] })
    root.visibleResultRefs!.clear()
    expect(() => publishFinding(state, { laneId: root.id, statement: 'hidden', evidenceRefs: [{ kind: 'result', ref: 'hidden' }] })).toThrow('UNKNOWN_FINDING_EVIDENCE')
    const snapshot = exportRuntimePersistence(state, { snapshot: () => ({ schemaVersion: 1, entries: [] }), entries: [] } as never, { snapshot: () => ({ schemaVersion: 1, pending: [] }) } as never)
    validateRuntimePersistenceSnapshot(snapshot)
    const restored = importRuntimeState(snapshot.state)
    expect(restored.results.get('hidden')?.value).toBe(true)
  })

  it('publishes findings through the Runtime transaction log', () => {
    const runtime = new PulseRuntime()
    const { root } = createAgent(runtime.state, 'runtime finding', { programId: 'finding', programVersion: '1', step: 'start', locals: {} })
    const artifact = runtime.publishArtifact({ mediaType: 'text/plain', content: 'evidence', laneId: root.id })
    const finding = runtime.publishFinding({ laneId: root.id, statement: 'Evidence is available.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }] })
    expect(runtime.state.results.get(finding.id)).toMatchObject({ kind: 'finding', statement: finding.statement })
    expect(runtime.mutationLog.entries.at(-1)?.mutations).toEqual([{ op: 'publishFinding', record: finding }])
  })

  it('rejects an over-limit Finding before state or mutation-log commit', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxResultBytes: 1 } })
    const program = { id: 'finding-limit', version: '1', step: () => ({ actions: [], next: { programId: 'finding-limit', programVersion: '1', step: 'start', locals: {} } }) }
    const { laneId } = runtime.createAgent('finding limit', program)
    const artifact = runtime.publishArtifact({ mediaType: 'text/plain', content: 'x', laneId })
    expect(() => runtime.publishFinding({ laneId, statement: 'This Finding cannot fit.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }] })).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect([...runtime.state.results.values()].some((result) => result.kind === 'finding')).toBe(false)
    expect(runtime.mutationLog.entries.some((entry) => entry.transactionId.startsWith('finding:'))).toBe(false)
  })
})
