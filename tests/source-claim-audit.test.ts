import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { sourceClaims, claimAssessmentError } from '../packages/server/src/task-controller/source-claim-audit.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it('covers assertions in summaries/tables and Chinese prose with stable IDs, excluding code', () => {
  const { targets, error } = sourceClaims([{ ref: 'delivery', path: 'report.md', text: '# Notes\nMy own summary: the flag never writes anything.\n| scope | all requests |\n它不会产生任何副作用。\n```js\nconst any = 1\n```\nA bounded ordinary description.' }])
  expect(error).toBeUndefined()
  expect(targets.map(t => t.id)).toEqual(['claim-1', 'claim-2', 'claim-3'])
  expect(targets[0]?.text).toContain('My own summary')
})

it.each([false, true])('checks actual Host source quotes and final-file freshness (external=%s)', async external => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-claim-host-'))
  const objective = 'Use https://example.com/docs to write report.md accurately explaining the documented flag.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0, claims = 0, modelRequests = 0
  const reply = (value: any) => Response.json({ choices: [{ message: typeof value === 'string' ? { content: value } : value, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }] })
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).startsWith('https://example.com/')) return new Response('<html><title>Flag</title><p>The flag suppresses rendered output. An index may still be written.</p></html>', { headers: { 'content-type': 'text/html' } })
    modelRequests++
    const request = JSON.parse(String(init?.body)), text = currentRequestText(request.messages), rows = suppliedRequestResults(request.messages), refs = rows.map(r => r.id)
    if (request.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))) return reply('APPROVE')
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [{ id: 'report', kind: 'edit', goal: 'Write report.md from the actual source', check: 'Source-supported bounded explanation', criterionIds: ids, dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active')) return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Actual report saved' }))
    if (text.includes('Independently verify every ORIGINAL')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Actual report and source' })) }))
    if (text.includes('Independently check EVERY supplied claim ID')) {
      claims++
      const context = request.messages.map((m: any) => { try { return JSON.parse(String(m.content)) } catch { return {} } }).find((m: any) => m.claimTargets)
      if (external) await writeFile(join(cwd, 'report.md'), 'Externally replaced after the audit started\n')
      return reply(JSON.stringify({ assessments: context.claimTargets.map((target: any) => ({ claimId: target.id, criterionId: ids[0], status: 'supported', sourceRefs: [context.primarySourceRefs[0]], quote: 'The flag suppresses rendered output.', rationale: 'The claim is bounded to the named rendered-output category, not every side effect.' })) }))
    }
    if (text.includes('Independently audit the delivered content') || text.includes('Perform an independent factual audit')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Actual source support' })), findings: [] }))
    const call = ++work === 1 ? { name: 'web_fetch', args: { url: 'https://example.com/docs' } } : work === 2 ? { name: 'fs_write', args: { path: 'report.md', content: 'The flag suppresses only rendered output; an index may still be written.\nSource: https://example.com/docs\n' } } : undefined
    return call ? reply({ content: '', tool_calls: [{ id: 'fixture-' + work, function: { name: call.name, arguments: JSON.stringify(call.args) } }] }) : reply('Report saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, '.host'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, jarvis: { enabled: false }, allowNetwork: true, networkHosts: ['example.com'], maxModelCalls: 40 })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: objective })
    for await (const event of run.events) if (event.type === 'waiting') await run.reply(String(event.data!.effectId), { approved: true })
    await run.outcome()
    const outcome = await run.taskOutcome()
    expect(claims).toBe(1)
    expect((await run.usage()).modelCalls).toBe(modelRequests)
    expect(outcome?.status === 'accepted', JSON.stringify(outcome)).toBe(!external)
    if (external) expect(JSON.stringify(outcome)).toContain('EVIDENCE_CHANGED')
    else {
      const state = JSON.parse(await readFile(join(cwd, '.host/conversations', c.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
      expect(state.sourceClaimAudit.assessments[0]).toMatchObject({ status: 'supported', quote: 'The flag suppresses rendered output.' })
    }
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 30_000)
it('does not silently accept partial assertion coverage', () => {
  expect(sourceClaims([{ ref: 'a', text: 'All ' + 'x'.repeat(1800) }]).error).toContain('COVERAGE_INSUFFICIENT')
  expect(sourceClaims([{ ref: 'a', text: Array.from({ length: 97 }, () => 'Always true.').join('\n') }]).error).toContain('COVERAGE_INSUFFICIENT')
})
it('requires complete IDs and exact actual primary-source quotations', () => {
  const targets = sourceClaims([{ ref: 'a', text: 'It suppresses only rendered output.' }]).targets
  const sources = new Map([['source', 'The flag suppresses rendered output. An index may still be written.']])
  const row = { claimId: 'claim-1', criterionId: 'c', status: 'supported' as const, sourceRefs: ['source'], quote: 'The flag suppresses rendered output.', rationale: 'The same bounded output category is documented.' }
  expect(claimAssessmentError(targets, [row], ['c'], sources)).toBeUndefined()
  expect(claimAssessmentError(targets, [], ['c'], sources)).toContain('exactly once')
  expect(claimAssessmentError(targets, [{ ...row, quote: 'It never writes anything.' }], ['c'], sources)).toContain('exact quote')
  expect(claimAssessmentError(targets, [{ ...row, sourceRefs: ['model-said-so'] }], ['c'], sources)).toContain('actual supplied')
  expect(claimAssessmentError(targets, [{ ...row, status: 'structural' }], ['c'], sources)).toContain('cannot exempt')
})

it.each(['supported', 'unsupported', 'missing', 'forged', 'bad-ref', 'structural-abuse', 'shape-repair', 'budget', 'repair', 'batch', 'legacy'] as const)('retains independent claim acceptance despite optimistic prior review: %s', async mode => {
  const qualified = 'The flag suppresses only rendered output; its index may still be written.'
  const universal = 'My own summary: the flag never writes any files.'
  let text = mode === 'batch' ? Array(9).fill(qualified).join('\n') : ['unsupported', 'repair', 'legacy'].includes(mode) ? universal : qualified
  let runtime: PulseRuntime, agentId = '', plans = 0, work = 0, claimCalls = 0, sourceAudits = 0
  const current = () => { const a = runtime.state.agents.get(agentId)!; return a.globalVersions.get(a.latestGlobalVersion) as any }
  const digest = () => createHash('sha256').update(text).digest('hex')
  const refs = () => [...runtime.state.results.values()].filter(r => r.producer?.kind === 'effect' && runtime.state.effects.get(r.producer.id)?.kind === 'tool').map(r => r.id)
  const program = buildTaskControllerProgram({ version: mode === 'legacy' ? '53' : '54', system: 'test', toolNames: ['web.fetch', 'fs.write', 'fs.read', 'fs.apply_patch'], readOnlyToolNames: ['web.fetch', 'fs.read'], approvalMode: 'auto', maxTurns: 48, modelBudgetView: () => ({ limit: 48, used: 12, workAllowed: mode === 'repair' || claimCalls === 0, verificationAllowed: true, finalAllowed: mode !== 'budget' || sourceAudits === 0 }) })
  runtime = new PulseRuntime({ effectExecutor: async effect => {
    const input = effect.input as any
    if (effect.kind === 'tool') {
      if (input.name === 'web.fetch') return { value: { url: 'https://source.example/flag', text: 'The flag suppresses rendered output. An index may still be written.', fetchedAt: '2026-10-24T00:00:00Z' } }
      if (input.name === 'fs.apply_patch') text = qualified
      if (input.name === 'fs.read') return { value: { path: 'report.md', content: text, hash: digest(), offset: 0, nextOffset: null, truncated: false } }
      return { value: { path: 'report.md', hash: digest(), changed: true } }
    }
    const visible = Array.isArray(input.inputs?.results) ? input.inputs.results : refs()
    if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: `report-${++plans}`, kind: 'edit', goal: 'Write an accurate source-based report.md', check: 'Accurate factual explanation', criterionIds: ['c'], dependsOn: [] }] } }
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: visible, note: 'Optimistic stage verifier' } }
    if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: visible, rationale: 'Optimistic final verifier' }] } }
    if (effect.key.startsWith('verify-sources')) { sourceAudits++; return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: visible, rationale: 'Optimistic whole-document audit' }], findings: [] } } }
    if (effect.key.startsWith('verify-claims')) {
      claimCalls++
      const context = input.inputs.conversation.map((m: any) => { try { return JSON.parse(m.content) } catch { return {} } }).find((m: any) => m.claimTargets)
      expect(context.claimTargets).toHaveLength(mode === 'batch' && claimCalls === 1 ? 8 : 1)
      const source = context.primarySourceRefs[0]
      const bad = mode === 'unsupported' || mode === 'repair' && claimCalls === 1
      return { value: { assessments: mode === 'missing' || mode === 'shape-repair' && claimCalls === 1 ? [] : context.claimTargets.map((target: any) => ({ claimId: target.id, criterionId: 'c', status: bad ? 'unsupported' : mode === 'structural-abuse' ? 'structural' : 'supported', sourceRefs: [mode === 'bad-ref' ? 'invented' : source], quote: mode === 'forged' ? 'The flag never writes any files.' : 'The flag suppresses rendered output.', rationale: bad ? 'The source names one output category, not all filesystem side effects.' : 'Scope is explicitly limited to rendered output and preserves the metadata exception.' })) } }
    }
    work++
    const tool = plans > 1 ? work === 4 ? { name: 'fs.apply_patch', input: { path: 'report.md', find: universal, replace: qualified } } : undefined
      : work === 1 ? { name: 'web.fetch', input: { url: 'https://source.example/flag' } } : work === 2 ? { name: 'fs.write', input: { path: 'report.md', content: text } } : undefined
    return { value: tool ? { finishReason: 'tool_calls', toolCalls: [tool] } : { finishReason: 'stop', text: 'Report saved.' } }
  } })
  agentId = runtime.createAgent({ goal: 'Research the flag and write an accurate report.md', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'source-claim-fixture', objective: 'Research the flag and write an accurate report.md', acceptanceCriteria: [{ id: 'c', description: 'Accurate source-supported explanation' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  const accepted = ['supported', 'shape-repair', 'repair', 'batch', 'legacy'].includes(mode)
  expect(current().taskOutcome.status === 'accepted', JSON.stringify(current().taskOutcome)).toBe(accepted)
  expect(claimCalls).toBe(mode === 'legacy' || mode === 'budget' ? 0 : mode === 'supported' || mode === 'unsupported' ? 1 : 2)
  if (mode === 'repair') { expect(text).toBe(qualified); expect(current().taskController.sourceClaimAudit.assessments[0].status).toBe('supported') }
  if (mode === 'batch') expect(current().taskController.sourceClaimAudit.assessments).toHaveLength(9)
})
