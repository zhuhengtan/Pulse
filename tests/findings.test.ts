import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, exportRuntimePersistence, importRuntimeState, publishArtifact, publishFinding, validateRuntimePersistenceSnapshot } from '@pulse/runtime'

describe('Finding evidence records', () => {
  it('publishes a privacy-inheriting finding with typed evidence refs', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'finding', { programId: 'finding', programVersion: '1', step: 'start', locals: {} })
    const artifact = publishArtifact(state, { mediaType: 'text/plain', content: 'secret', laneId: root.id, privacy: 'local_only' })
    const finding = publishFinding(state, { laneId: root.id, statement: 'The artifact is local-only.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }] })
    expect(finding).toMatchObject({ kind: 'finding', privacy: 'local_only', statement: 'The artifact is local-only.', evidenceRefs: [{ kind: 'artifact', ref: artifact.ref }] })
    expect(state.results.get(finding.id)?.derivedFrom).toEqual([{ kind: 'artifact', ref: artifact.ref }])
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
})
