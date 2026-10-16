import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { PulseRuntime, defineLaneProgram, toolEvidenceHash, normalizeModelToolInput } from '@hunterzhu/pulse-runtime'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { StagedEditor } from '../packages/server/src/editing.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { planConfirmationOptions } from '../packages/server/src/plan-confirmation.js'
import { initialController, unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'

describe('fourth-round real trajectory regressions (offline)', () => {
  it('keeps huge verifier enum errors out of the 2KB instruction and corrects only once', async () => {
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'long-verifier-output', version: '1' }, builder => {
      builder.addStructuredLLMStep('verify', { task: 'verify', instruction: 'x'.repeat(1990), schema: z.object({ status: z.enum(['passed', 'failed']) }), onSuccess: () => ({ complete: {} }), onError: error => ({ fail: error }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async effect => { requests.push(effect.input); return { value: { status: '<result ref="invented-151">fake shell error</result>'.repeat(2000) } } } })
    const { agentId } = runtime.createAgent('verify actual evidence', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'OUTPUT_SCHEMA_VIOLATION' } })
    expect(requests).toHaveLength(2)
    expect(Buffer.byteLength(requests[1].instruction)).toBeLessThan(2048)
    expect(requests[1].instruction).not.toContain('invented-151')
    expect(requests[1].inputs.validationErrors).toEqual([{ code: 'invalid_enum_value', path: ['status'] }])
    expect(requests[1].inputs.rejectedOutputRefs).toHaveLength(1)
    expect(requests[1].inputs.originalInstruction).toBe('x'.repeat(1990))
  })

  it.each(['schema', 'invented-citation'])('retains an implemented file without replay or replanning when verifier fails (%s)', async mode => {
    let plans = 0, writes = 0, work = 0, reviews = 0, agentId = ''
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.write'], approvalMode: 'auto', maxTurns: 64 })
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'tool') { writes++; return { value: { path: 'greet.mjs', hash: 'a'.repeat(64), bytes: 24 } } }
      if (effect.key.startsWith('plan')) { plans++; return { value: { tasks: [{ id: 's', goal: 'Write greet.mjs', check: 'File contains greeting', criterionIds: ['c'], dependsOn: [] }] } } }
      if (effect.key.startsWith('verify-stage')) { reviews++; return { value: mode === 'schema' ? { status: 'fake transcript'.repeat(1000) } : { status: 'needs_work', evidenceRefs: ['result-151'], correctionKind: 'edit', note: 'Invented syntax failure' } } }
      work++
      return { value: work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'greet.mjs', content: 'export const greet = 1' } }] } : { text: 'Saved the greeting module.', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Write greet.mjs', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Write greet.mjs', acceptanceCriteria: [{ id: 'c', description: 'Greeting file saved' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(plans).toBe(1); expect(writes).toBe(1); expect(work).toBe(2)
    expect(reviews).toBe(mode === 'schema' ? 2 : 1)
    const agent = runtime.state.agents.get(agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
    expect(global.taskController.tasks[0].status).toBe('blocked')
    expect(global.taskController.tasks[0].evidenceRefs.length).toBeGreaterThan(0)
    expect(global.taskOutcome.status).toBe('incomplete')
  })

  it('compares executed file windows and draft content rather than ignored args/UUIDs', () => {
    const read = (n: number, offset = 0, hash = 'file') => toolEvidenceHash({ toolName: 'fs.read', toolArguments: { path: 'a', maxBytes: n } }, { path: 'a', offset, nextOffset: offset + 3000, content: 'same', hash })
    expect(read(3000)).toBe(read(200000))
    expect(read(3000)).not.toBe(read(3000, 3000))
    expect(read(3000)).not.toBe(read(3000, 0, 'changed'))
    const stage = (operation: string, id: string, contentHash = 'same', committed = false) => toolEvidenceHash({ toolName: 'fs.stage', toolArguments: { operation, draftId: id } }, { draftId: id, revision: id, target: 'a.mjs', bytes: 100, contentHash, committed })
    expect(stage('begin', 'one')).toBe(stage('inspect', 'two'))
    expect(stage('begin', 'one')).not.toBe(stage('append', 'one', 'new'))
    expect(stage('begin', 'one')).not.toBe(stage('commit', 'one', 'same', true))
    expect(normalizeModelToolInput('fs.read', { path: 'a', maxBytes: 200000 })).toEqual({ path: 'a', maxBytes: 3000 })
  })

  it('stops alternating draft begin/inspect after four unchanged rounds with one correction', async () => {
    let models = 0
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'draft-churn', version: '1' }, builder => builder.addReActLoopStep('work', { instruction: 'complete module', maxTurns: 32, onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'tool') return { value: { draftId: `new-${models}`, revision: `r-${models}`, target: 'audit.mjs', bytes: 850, contentHash: 'unchanged', committed: false } }
      requests.push(effect.input); models++
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.stage', input: models % 2 ? { operation: 'begin', path: 'audit.mjs', content: 'head' } : { operation: 'inspect', draftId: '00000000-0000-4000-8000-000000000001' } }] } }
    } })
    const { agentId } = runtime.createAgent('write audit module', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
    expect(models).toBe(5)
    expect(requests.filter(r => JSON.stringify(r.inputs.conversation ?? []).includes('same evidence'))).toHaveLength(1)
  })

  it('retains the full answer label and blocks repeated identical questions without asking the user again', async () => {
    let models = 0, questions = 0
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'answered-question-churn', version: '1' }, builder => {
      builder.addReActLoopStep('work', { instruction: 'interview once then plan', maxTurns: 16, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'human') { questions++; return { value: { value: 'A' } } }
      models++; requests.push(effect.input)
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.choice', input: { prompt: '报告如何组织？', options: [{ label: '每例独立报告，另有汇总、矩阵和问题清单', value: 'A' }, { label: '单文件', value: 'B' }] } }] } }
    } })
    const { agentId } = runtime.createAgent('ask one question', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
    expect(questions).toBe(1); expect(models).toBe(3)
    expect(JSON.stringify(requests[1].inputs.conversation)).toContain('每例独立报告，另有汇总、矩阵和问题清单')
    expect(JSON.stringify(requests[1].inputs.conversation)).toContain('selectedLabel')
  })

  it('treats identical answers to distinct new questions as progress', async () => {
    let models = 0, questions = 0
    const program = defineLaneProgram({ id: 'same-value-new-questions', version: '1' }, builder => {
      builder.addReActLoopStep('work', { instruction: 'resolve six distinct decisions', maxTurns: 16, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'human') { questions++; return { value: { value: 'A' } } }
      models++
      return { value: models <= 6 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.choice', input: { prompt: `Distinct decision ${models}`, options: ['A', 'B'] } }] } : { text: 'All six decisions resolved.' } }
    } })
    const { agentId } = runtime.createAgent('new questions with same answer', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(questions).toBe(6); expect(models).toBe(7)
  })

  it('resumes one durable draft with its actual tail, then appends and commits after editor restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-draft-resume-'))
    try {
      const files = new FilesystemTool(root), first = new StagedEditor(files)
      const begin = await first.execute({ operation: 'begin', path: 'notes/audit.mjs', content: 'export function audit(rows) {\n' })
      const next = await first.execute({ operation: 'append', draftId: begin.draftId, revision: begin.revision, content: 'return rows.length;\n' })
      const restored = new StagedEditor(files)
      const resumed = await restored.execute({ operation: 'begin', path: './notes/audit.mjs', content: 'replacement must not reset work' })
      expect(resumed).toEqual(next)
      expect(resumed.tail).toContain('return rows.length')
      const complete = await restored.execute({ operation: 'append', draftId: resumed.draftId, revision: resumed.revision, content: '}\n' })
      await restored.execute({ operation: 'commit', draftId: complete.draftId, revision: complete.revision, expectedBytes: complete.bytes })
      expect(await files.read('notes/audit.mjs')).toBe('export function audit(rows) {\nreturn rows.length;\n}\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('recognizes the actual final labels and opaque values without approving a reversed/default-unsafe gate', () => {
    const input = { options: [{ label: '暂不执行（默认，保留计划）', value: 'hold' }, { label: '执行（开始实施）', value: 'execute' }] }
    expect(planConfirmationOptions(input)).toEqual({ defer: 'hold', execute: 'execute' })
    expect(planConfirmationOptions({ options: [...input.options].reverse() })).toBeUndefined()
    expect(planConfirmationOptions({ options: ['A', 'B'] })).toBeUndefined()
    expect(planConfirmationOptions({ options: [{ label: '暂不执行', value: 'A' }, { label: '执行', value: 'A' }] })).toBeUndefined()
    expect(planConfirmationOptions({ options: ['暂不执行', '执行'] })).toEqual({ defer: '暂不执行', execute: '执行' })
  })

  it.each(['NO_PROGRESS', 'INVESTIGATION_LIMIT_REACHED', 'Verifier unusable (OUTPUT_SCHEMA_VIOLATION)', 'Verifier cited unavailable evidence'])('does not replan a stopped checkpoint: %s', note => {
    const state = initialController(64)
    state.tasks = [{ id: 's', goal: 'write file', check: 'file saved', criterionIds: ['c'], dependsOn: [], status: 'blocked', attempts: 1, evidenceRefs: ['real-ref'], note }]
    expect(unmetGoalCanChangeApproach(state)).toBe(false)
    expect(state.tasks[0]?.evidenceRefs).toEqual(['real-ref'])
  })
})
