import { describe, expect, it } from 'vitest'
import { apply, ContextBuilder, createAgent, createRuntimeState, exportRuntimeState, importRuntimeState, publishArtifact, readArtifact, validateStep, PulseRuntime } from '@hunterzhu/pulse-runtime'

describe('Artifact store', () => {
  it('publishes immutable content with hash, pinning and session round-trip', () => {
    const state = createRuntimeState()
    const { agent, root } = createAgent(state, 'artifact', { programId: 'artifact', programVersion: '1', step: 'start', locals: {} })
    const record = publishArtifact(state, { mediaType: 'text/plain', content: 'hello', laneId: root.id })
    expect(record).toMatchObject({ ref: 'artifact-1', sizeBytes: 5, storageState: 'memory', pinCount: 0 })
    expect(new TextDecoder().decode(readArtifact(state, record.ref))).toBe('hello')
    state.artifacts.get(record.ref)!.pinCount++
    state.artifacts.get(record.ref)!.storageState = 'persisted'
    const restored = importRuntimeState(JSON.parse(JSON.stringify(exportRuntimeState(state))))
    expect(restored.artifacts.get(record.ref)).toMatchObject({ contentHash: record.contentHash, storageState: 'persisted', pinCount: 1, agentId: agent.id })
  })

  it('inherits privacy from Result sources and validates artifact-derived outputs', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'artifact privacy', { programId: 'artifact', programVersion: '1', step: 'start', locals: {} })
    state.results.set('secret', { id: 'secret', value: { token: true }, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('secret')
    expect(() => publishArtifact(state, { mediaType: 'application/json', content: '{}', laneId: root.id, privacy: 'public', derivedFrom: ['secret'] })).toThrow('PRIVACY_DOWNGRADE_WITHOUT_PROOF')
    const artifact = publishArtifact(state, { mediaType: 'application/json', content: '{}', laneId: root.id, derivedFrom: ['secret'] })
    expect(artifact.privacy).toBe('local_only')
    const projection = new ContextBuilder(state).build({ agent: state.agents.get(root.agentId)!, lane: root, artifactRefs: [artifact.ref], instruction: 'inspect artifact', toolSetId: 'default' })
    expect(projection.contextSpec.artifactRefs).toEqual([artifact.ref])
    expect(projection.blocks.find((block) => block.kind === 'artifacts')?.content).toMatchObject([{ ref: artifact.ref, mediaType: 'application/json' }])
    expect(projection.privacy).toBe('local_only')
    expect(projection.privacyRefs).toContainEqual({ kind: 'artifact', ref: artifact.ref })
    const output = validateStep(state, root.id, { actions: [{ type: 'complete', result: { artifact: artifact.ref }, derivedFrom: [artifact.ref] }], next: { programId: 'artifact', programVersion: '1', step: 'done', locals: {} } })
    expect('rejection' in output).toBe(false)
    if ('rejection' in output) return
    apply(state, output.mutations)
    expect([...state.results.values()].at(-1)).toMatchObject({ privacy: 'local_only', derivedFrom: [artifact.ref] })
  })

  it('accepts structured DataRef provenance for results and artifacts', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'structured refs', { programId: 'artifact', programVersion: '1', step: 'start', locals: {} })
    state.results.set('source-result', { id: 'source-result', value: { ok: true }, privacy: 'public', derivedFrom: [] })
    root.visibleResultRefs!.add('source-result')
    const source = publishArtifact(state, { mediaType: 'text/plain', content: 'source', laneId: root.id, derivedFrom: [{ kind: 'result', ref: 'source-result' }] })
    const output = validateStep(state, root.id, { actions: [{ type: 'complete', result: { artifact: source.ref }, derivedFrom: [{ kind: 'artifact', ref: source.ref }] }], next: { programId: 'artifact', programVersion: '1', step: 'done', locals: {} } })
    expect('rejection' in output).toBe(false)
    if ('rejection' in output) return
    apply(state, output.mutations)
    expect([...state.results.values()].at(-1)).toMatchObject({ derivedFrom: [{ kind: 'artifact', ref: source.ref }] })
  })

  it('accounts for Artifact residency and explicit pinning in storage policy', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxArtifactBytes: 1024 } })
    const program = { id: 'artifact-policy', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'artifact-policy', programVersion: '1', step: 'done', locals: {} } }) }
    const { laneId } = runtime.createAgent('artifact policy', program)
    const record = runtime.publishArtifact({ mediaType: 'text/plain', content: 'hello', laneId })
    expect(runtime.storagePolicy.inspect().find((item) => item.key === `artifact:${record.ref}`)).toMatchObject({ kind: 'artifact', storageState: 'memory' })
    runtime.pinArtifact(record.ref)
    expect(runtime.storagePolicy.inspect().find((item) => item.key === `artifact:${record.ref}`)?.pinCount).toBeGreaterThan(0)
  })

  it('rejects an over-limit public publication before state or mutation-log commit', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxArtifactBytes: 1 } })
    const program = { id: 'artifact-limit', version: '1', step: () => ({ actions: [], next: { programId: 'artifact-limit', programVersion: '1', step: 'start', locals: {} } }) }
    const { laneId } = runtime.createAgent('artifact limit', program)
    expect(() => runtime.publishArtifact({ mediaType: 'text/plain', content: 'too large', laneId })).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.artifacts.size).toBe(0)
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'publishArtifact'))).toBe(false)
  })
})
