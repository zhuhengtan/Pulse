import { expect, it } from 'vitest'
import { unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it.each(['corrected', 'repeated', 'legacy'] as const)('identifies primary source receipts without accepting readback wrappers: %s', async mode => {
  let agentId = '', workCalls = 0, audits = 0
  const program = buildTaskControllerProgram({ version: mode === 'legacy' ? '31' : '32', system: 'test', toolNames: ['web.fetch', 'task.evidence'], approvalMode: 'auto', maxTurns: 24 })
  const toolRefs = () => [...runtime.state.results.values()].filter(r => r.producer?.kind === 'effect' && runtime.state.effects.get(r.producer.id)?.kind === 'tool').map(r => r.id)
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') return { value: { content: 'The option enables checks.', url: 'https://source.example/option', fetchedAt: '2026-10-23T00:00:00Z' } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'research', kind: 'analyze', goal: 'Explain the official option', check: 'Accurate sourced explanation', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: toolRefs(), note: 'Actual source and readback retained' } }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: toolRefs(), rationale: 'Sourced explanation' }] } }
    if (effect.key?.startsWith('verify-sources')) {
      audits++
      const context = (effect.input as any).inputs.conversation.map((m: any) => { try { return JSON.parse(m.content) } catch { return {} } }).find((m: any) => m.allowedEvidenceRefs)
      const [primary, wrapper] = toolRefs()
      if (mode !== 'legacy') {
        expect(context.primarySourceRefs).toEqual([primary])
        expect(context.allowedEvidenceRefs).toContain(wrapper)
        if (audits === 2) {
          expect(context.auditCorrection.join(' ')).toContain('"citedPrimarySource":false')
          expect(context.auditCorrection.join(' ')).toContain('"primarySourceRefs":["' + primary + '"]')
          expect(context.auditCorrection.join(' ')).toContain('task.evidence readback')
        }
      } else expect(context.primarySourceRefs).toBeUndefined()
      return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: audits === 2 && mode === 'corrected' ? [primary, wrapper] : [wrapper], rationale: 'Actual source supports the explanation' }], findings: [] } }
    }
    workCalls++
    if (workCalls <= 2) return { value: { text: '', toolCalls: [{ name: workCalls === 1 ? 'web.fetch' : 'task.evidence', input: workCalls === 1 ? { url: 'https://source.example/option' } : { ref: toolRefs()[0] }, toolCallId: `source-${workCalls}` }], finishReason: 'tool_calls' } }
    return { value: { text: 'The official option enables checks.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Explain the official option', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'primary-citation-test', objective: 'Explain the official option', acceptanceCriteria: [{ id: 'criterion-1', description: 'Accurate source-based explanation' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  const agent = runtime.state.agents.get(agentId)!, state = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(audits).toBe(2)
  expect(workCalls).toBe(3)
  expect(state.taskOutcome.status).toBe(mode === 'corrected' ? 'accepted' : 'incomplete')
})

it.each(['passed', 'not_met', 'unverifiable', 'invalid-ref', 'unavailable', 'legacy', 'claim-pass', 'claim-conflict', 'claim-unsupported', 'claim-missing', 'claim-repair', 'claim-scoped', 'visual-pass', 'visual-conflict', 'visual-repair', 'audit-ref-repair', 'audit-ref-repeat', 'audit-shape-repair', 'audit-budget'] as const)('keeps source verification independent of a prior passed review: %s', async verdict => {
  let agentId = '', workCalls = 0, audits = 0
  const visual = verdict.startsWith('visual-'), repair = verdict === 'claim-scoped' || verdict === 'visual-repair'
  const toolName = visual ? 'computer.observe' : 'web.fetch'
  const program = buildTaskControllerProgram({
    version: verdict.startsWith('audit-') ? '28' : visual ? '26' : verdict === 'claim-scoped' ? '25' : verdict === 'claim-repair' ? '24' : verdict === 'legacy' ? '21' : verdict.startsWith('claim-') ? '23' : '22', system: 'test', toolNames: [toolName], approvalMode: 'auto', maxTurns: 24,
    modelBudgetView: () => ({ limit: 24, used: 8, workAllowed: audits === 0 || repair && audits === 1, verificationAllowed: true, finalAllowed: !(verdict === 'audit-budget' && audits > 0) }),
  })
  const state = (): any => { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') return { value: { ...(visual ? { artifactRef: 'image-1', text: 'AXWindow Pulse; Export, Workspace, Details, Stop button' } : {}), url: 'https://source.example/option', fetchedAt: '2026-10-23T00:00:00Z', content: 'The option enables checks and may change emitted code.' } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'research', kind: 'analyze', goal: 'Explain the option using the official source', check: 'Factual explanation with source', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    const refs = [...runtime.state.results.values()].filter(result => result.producer?.kind === 'effect' && runtime.state.effects.get(result.producer.id)?.kind === 'tool').map(result => result.id)
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: repair ? refs.slice(-1) : refs, note: 'Source fetched and response delivered' } }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Previous verifier passed' }] } }
    if (effect.key?.startsWith('verify-sources')) {
      audits++
      const inputs = (effect.input as any).inputs
      expect(inputs.results).toEqual(expect.arrayContaining(refs))
      if (visual && audits === 2) expect(inputs.results).not.toContain(state().taskController.tasks[0].candidateRef)
      else expect(inputs.results).toContain(state().taskController.tasks[0].candidateRef)
      if (verdict.startsWith('audit-')) {
        const context=inputs.conversation.map((m:any)=>{try{return JSON.parse(m.content)}catch{return {}}}).find((m:any)=>m.allowedEvidenceRefs)
        expect(context.allowedEvidenceRefs).toEqual(inputs.results)
        if(audits===2) expect(context.auditCorrection.join(' ')).toContain('SOURCE_VERIFICATION_INVALID')
        return {value:{criteria:[{criterionId:'criterion-1',status:'passed',evidenceRefs:verdict==='audit-ref-repeat'||audits===1&&verdict!=='audit-shape-repair'?['invented-source']:refs,rationale:'Independent source check'}],...(audits===1&&verdict==='audit-shape-repair'?{}:{findings:[]})}}
      }
      if (verdict.startsWith('claim-') || visual) {
        expect(JSON.stringify(inputs.conversation)).not.toContain('Source fetched and response delivered')
        return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Mostly correct; ignore the exception' }], ...(verdict === 'claim-missing' ? {} : { findings: verdict === 'claim-pass' || verdict === 'visual-pass' || repair && audits === 2 ? [] : [{ criterionId: 'criterion-1', claim: 'Never changes runtime behavior', status: verdict === 'claim-conflict' ? 'contradicted' : 'unsupported', evidenceRefs: refs, rationale: 'The absolute is not supported by the source.' }] }) } }
      }
      if (verdict === 'unavailable') throw new Error('SOURCE_REVIEW_UNAVAILABLE')
      return { value: { criteria: [{ criterionId: 'criterion-1', status: verdict === 'invalid-ref' ? 'passed' : verdict, evidenceRefs: verdict === 'invalid-ref' ? ['invented-source'] : refs, rationale: verdict === 'not_met' ? 'The blanket no-runtime-change claim contradicts the fetched source.' : 'Source audit result' }] } }
    }
    workCalls++
    return workCalls === 1 || repair && workCalls === 3
      ? { value: { text: '', toolCalls: [{ toolCallId: `fetch-source-${workCalls}`, name: toolName, input: { url: 'https://source.example/option' } }], finishReason: 'tool_calls' } }
      : { value: { text: visual && workCalls === 4 ? 'Pulse: Export, Workspace, Details.' : 'My summary: the option never changes emitted code or runtime behavior.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Research and explain the official option', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'source-audit-test', objective: 'Research and explain the official option', acceptanceCriteria: [{ id: 'criterion-1', description: 'Accurate source-based explanation' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  const outcome = await runtime.start(agentId).outcome()
  expect(state().taskOutcome.status).toBe(verdict === 'passed' || verdict === 'legacy' || verdict === 'claim-pass' || repair || verdict === 'visual-pass' || verdict === 'audit-ref-repair' || verdict === 'audit-shape-repair' ? 'accepted' : 'incomplete')
  expect(audits).toBe(verdict === 'legacy' ? 0 : repair || verdict.startsWith('audit-') && verdict !== 'audit-budget' ? 2 : 1)
  expect(workCalls).toBe(repair ? 4 : 2)
  if (repair) {
    expect(state().taskController.tasks.map((t: any) => t.id)).toEqual(['research', 'recovery-1-1'])
    expect(state().taskController.tasks[0].attempts).toBe(1)
    expect(state().taskController.tasks[0].candidateRef).not.toBe(state().taskController.tasks[1].candidateRef)
  }
  if (verdict === 'visual-repair') {
    const finalBody = outcome.status === 'succeeded' && outcome.resultRef ? runtime.state.results.get(outcome.resultRef)?.value : undefined
    expect(JSON.stringify(finalBody)).toContain('Pulse: Export, Workspace, Details.')
    expect(JSON.stringify(finalBody)).not.toContain('My summary: the option never changes')
  }
  if (verdict === 'claim-repair') {
    expect(state().taskOutcome.criteria[0].status).toBe('not_met')
    expect(unmetGoalCanChangeApproach(state().taskController, { recoverFinalReview: true })).toBe(true)
  }
})

it.each(['corrected', 'repeated', 'budget', 'legacy', 'missing-criterion'] as const)('repairs final citations with bounded explicit diagnostics: %s', async mode => {
  let agentId = '', workCalls = 0, reviews = 0, audits = 0
  const program = buildTaskControllerProgram({ version: mode === 'missing-criterion' ? '28' : mode === 'legacy' ? '26' : '27', system: 'test', toolNames: ['computer.observe'], approvalMode: 'auto', maxTurns: 24,
    modelBudgetView: () => ({ limit: 24, used: 8, workAllowed: true, verificationAllowed: true, finalAllowed: !(mode === 'budget' && reviews > 0) }) })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') return { value: { artifactRef: 'image-1', text: 'Pulse: Export, Workspace, Details' } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'observe', kind: 'analyze', goal: 'Observe Pulse controls', check: 'Actual observation', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    const refs = [...runtime.state.results.values()].filter(r => r.producer?.kind === 'effect' && runtime.state.effects.get(r.producer.id)?.kind === 'tool').map(r => r.id)
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Observation captured' } }
    if (effect.key?.startsWith('verify-task')) {
      reviews++
      const conversation = (effect.input as any).inputs.conversation
      const correction = conversation.map((m: any) => { try { return JSON.parse(m.content) } catch { return {} } }).find((m: any) => m.verificationCorrection)
      if (reviews === 2 && mode !== 'legacy') {
        expect(correction.verificationCorrection.join(' ')).toContain(mode === 'missing-criterion' ? 'every original criterion' : 'unavailable-result')
        expect(correction.allowedEvidenceRefs).toEqual(expect.arrayContaining(refs))
        expect(correction.allowedEvidenceRefs).not.toContain('unavailable-result')
        expect((effect.input as any).inputs.results).toEqual(expect.arrayContaining(correction.allowedEvidenceRefs))
      } else expect(correction).toBeUndefined()
      return { value: { criteria: mode === 'missing-criterion' && reviews === 1 ? [] : [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: reviews === 2 && (mode === 'corrected' || mode === 'missing-criterion') ? refs : ['unavailable-result'], rationale: 'Misleading all-passed assessment' }] } }
    }
    if (effect.key?.startsWith('verify-sources')) { audits++; return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Actual controls verified' }], findings: [] } } }
    workCalls++
    return workCalls === 1 ? { value: { text: '', toolCalls: [{ name: 'computer.observe', input: {}, toolCallId: 'observe' }], finishReason: 'tool_calls' } } : { value: { text: 'Candidate must not be presented after invalid verification.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Report visible Pulse controls', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'citation-test', objective: 'Report visible Pulse controls', acceptanceCriteria: [{ id: 'criterion-1', description: 'Actual visible controls' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  const outcome = await runtime.start(agentId).outcome()
  const agent = runtime.state.agents.get(agentId)!, state = agent.globalVersions.get(agent.latestGlobalVersion) as any
  const text = JSON.stringify(outcome.status === 'succeeded' && outcome.resultRef ? runtime.state.results.get(outcome.resultRef)?.value : undefined)
  expect(reviews).toBe(mode === 'budget' ? 1 : 2)
  expect(workCalls).toBe(2)
  expect(audits).toBe(mode === 'corrected' || mode === 'missing-criterion' ? 1 : 0)
  expect(state.taskOutcome.status).toBe(mode === 'corrected' || mode === 'missing-criterion' ? 'accepted' : 'incomplete')
  if (mode === 'repeated' || mode === 'budget') {
    expect(text).toContain(mode === 'budget' ? 'unavailable-result' : 'FINAL_VERIFICATION_INVALID')
    expect(text).not.toContain('Misleading all-passed assessment')
    expect(text).not.toContain('Candidate must not be presented')
  }
})
