import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

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

  it('requires an explicit existing source and version', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'warm-error', version: '1', step: () => ({ actions: [], next: { programId: 'warm-error', programVersion: '1', step: 'done', locals: {} } }) }
    expect(() => runtime.createAgent({ goal: 'missing', program, warmStart: { agentId: 'agent-missing' } })).toThrow('WARM_START_SOURCE_NOT_FOUND')
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
})
