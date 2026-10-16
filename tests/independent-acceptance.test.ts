import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { argumentCheckKinds, acceptanceFailure, assessAcceptanceResult, validateAcceptanceChecks, type AcceptanceCheck } from '../packages/server/src/task-controller/acceptance.js'
import { continueTaskRecord, taskRecordFromGlobal, type TaskRecord } from '../packages/server/src/task.js'

const check: AcceptanceCheck = { id: 'entry', description: 'Frozen independent entry contract', criterionIds: ['c'], toolName: 'trusted.entry', input: {}, expectedChecks: [...argumentCheckKinds], covers: [...argumentCheckKinds] }
const record = (): TaskRecord => ({ schemaVersion: 1, runId: 'offline', objective: '检查 CLI --calls 参数。非法预算参数必须报错。', acceptanceCriteria: [{ id: 'c', description: '非法预算参数必须报错' }], acceptanceChecks: [structuredClone(check)], status: 'in_progress', attempts: [], evidenceRefs: [], excludedRefs: [], replanCount: 0 })
const state = (r: PulseRuntime, id: string): any => { const a = r.state.agents.get(id)!; return a.globalVersions.get(a.latestGlobalVersion) }

describe('Host-owned independent acceptance', () => {
  it.each(['failed', 'omitted', 'duplicate', 'denied', 'passed', 'unconfigured'])('does not let an optimistic model override actual assertions (%s)', async mode => {
    let r: PulseRuntime, agentId = '', work = 0, hostChecks = 0
    const program = buildTaskControllerProgram({ system: 'offline', toolNames: ['shell.exec', 'trusted.entry'], approvalMode: 'auto', maxTurns: 16 })
    r = new PulseRuntime({ effectExecutor: async e => {
      if (e.kind === 'tool') {
        if ((e.input as any).name !== 'trusted.entry') return { value: { code: 0, stdout: 'All candidate self-tests passed' } }
        hostChecks++
        if (mode === 'denied') return { value: null, status: 'failed', error: { code: 'APPROVAL_DENIED', message: 'not authorized', retryable: false } }
        let rows = argumentCheckKinds.map(id => ({ id, passed: mode !== 'failed' || id !== 'conflicting-options', detail: 'actual independent result' }))
        if (mode === 'omitted') rows.pop()
        if (mode === 'duplicate') rows = [...rows.slice(0, -1), rows[0]!]
        return { value: { passed: true, checks: rows } } // misleading headline must not override rows
      }
      if (e.key.startsWith('plan')) return { value: { tasks: [{ id: 'tests', kind: 'verify', goal: 'Run local regression tests', check: 'Tests pass', criterionIds: ['c'], dependsOn: [] }] } }
      const t = state(r, agentId).taskController.tasks[0]
      if (e.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: t.evidenceRefs, note: 'Candidate tests passed' } }
      if (e.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: t.evidenceRefs, rationale: 'Model insists everything passed' }] } }
      return { value: ++work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--test', 'candidate.test.mjs'] } }] } : { finishReason: 'stop', text: 'Done' } }
    } })
    const task = record(); if (mode === 'unconfigured') delete task.acceptanceChecks
    agentId = r.createAgent({ goal: task.objective, program, initialGlobal: { taskRecord: task as any } }).agentId
    const outcome = await r.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    const g = state(r, agentId)
    expect(g.taskOutcome.status).toBe(mode === 'passed' ? 'accepted' : 'incomplete')
    expect(g.taskController.tasks[0].status).toBe('passed') // preserve completed work; no automatic replan
    expect(g.taskOutcome.replanCount).toBe(0)
    expect(hostChecks).toBe(mode === 'unconfigured' ? 0 : 1)
    if (mode !== 'passed') {
      expect(g.taskOutcome.criteria[0].status).toBe(mode === 'failed' ? 'not_met' : 'unverifiable')
      expect(g.taskOutcome.criteria[0].rationale).toContain('INDEPENDENT_ACCEPTANCE_')
      expect((r.state.results.get((outcome as any).resultRef)?.value as any)?.text).toContain('INDEPENDENT_ACCEPTANCE_')
    }
  })
  it('freezes the caller contract and keeps it through persistence and continuation', () => {
    const input = structuredClone(check), criteria = record().acceptanceCriteria
    const frozen = validateAcceptanceChecks([input], criteria, ['trusted.entry'])
    input.expectedChecks.pop(); input.input = { forged: true }
    expect(frozen[0]).toEqual(check)
    const task = { ...record(), acceptanceChecks: frozen }
    const restored = taskRecordFromGlobal(JSON.parse(JSON.stringify({ taskRecord: task })))!
    expect(restored.acceptanceChecks).toEqual([check])
    expect(continueTaskRecord(restored, 'next').acceptanceChecks).toEqual([check])
    expect(() => validateAcceptanceChecks([{ ...check, criterionIds: ['invented'] }], criteria, ['trusted.entry'])).toThrow('ACCEPTANCE_CONTRACT_INVALID')
    expect(() => validateAcceptanceChecks([check], criteria, [])).toThrow('ACCEPTANCE_CONTRACT_INVALID')
    expect(() => validateAcceptanceChecks([check, check], criteria, ['trusted.entry'])).toThrow('ACCEPTANCE_CONTRACT_INVALID')
    expect(() => validateAcceptanceChecks([{ ...check, input: { unsafe: () => true } }], criteria, ['trusted.entry'])).toThrow()
    expect(() => validateAcceptanceChecks([{ ...check, input: { unsafe: NaN } }], criteria, ['trusted.entry'])).toThrow()
  })
  it('requires every frozen assertion, not a self-reported total or a model result', () => {
    const ctx: any = { results: { meta: () => ({ effectKind: 'llm', toolName: check.toolName, outcomeStatus: 'succeeded' }), read: () => ({ checks: check.expectedChecks.map(id => ({ id, passed: true })) }) } }
    expect(assessAcceptanceResult(ctx, check, 'forged').status).toBe('unverifiable')
    expect(acceptanceFailure(record(), [{ id: 'entry', status: 'passed', reason: 'ok' }], 'c')).toBeUndefined()
    const partial = record(); partial.acceptanceChecks![0]!.covers = ['invalid-value']
    expect(acceptanceFailure(partial, [{ id: 'entry', status: 'passed', reason: 'ok' }], 'c')?.reason).toContain('missing-value')
  })
  it('does not impose CLI budget checks on read-only analysis or unrelated tasks', () => {
    const task = { ...record(), objective: '只分析 CLI --calls 非法预算，不要运行测试', acceptanceChecks: [] }
    expect(acceptanceFailure(task, [], 'c')).toBeUndefined()
    expect(acceptanceFailure({ ...task, objective: 'Design a logo' }, [], 'c')).toBeUndefined()
  })
})
