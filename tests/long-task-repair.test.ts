import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { StagedEditor } from '../packages/server/src/editing.js'
import { fitPlanToBudget, validatePlan } from '../packages/server/src/task-controller/state.js'

describe('real long-task failure regressions', () => {
  it('rejects the begin-inspect-commit incomplete JS trajectory, retains draft, then accepts append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-incomplete-js-'))
    try {
      const files = new FilesystemTool(root), editor = new StagedEditor(files)
      const begin = await editor.execute({ operation: 'begin', path: 'audit.mjs', content: 'export function audit(rows) {\n' })
      const inspected = await editor.execute({ operation: 'inspect', draftId: begin.draftId })
      await expect(editor.execute({ operation: 'commit', draftId: begin.draftId, revision: inspected.revision, expectedBytes: inspected.bytes })).rejects.toMatchObject({ code: 'DRAFT_SYNTAX_INVALID' })
      await expect(files.read('audit.mjs')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await editor.execute({ operation: 'inspect', draftId: begin.draftId })).toEqual(inspected)
      const appended = await editor.execute({ operation: 'append', draftId: begin.draftId, revision: begin.revision, content: 'return rows.length;\n}\n' })
      expect((await editor.execute({ operation: 'commit', draftId: begin.draftId, revision: appended.revision, expectedBytes: appended.bytes })).committed).toBe(true)
      expect(await files.read('audit.mjs')).toContain('return rows.length')
      await expect(editor.execute({ path: 'partial.cjs', content: 'module.exports = {' })).rejects.toMatchObject({ code: 'DRAFT_SYNTAX_INVALID' })
      // Parsing must not execute the file.
      expect((await editor.execute({ path: 'safe.mjs', content: 'throw new Error("must never execute")' })).committed).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fits a five-stage DAG into sixteen calls without discarding criteria, checks or dependencies', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, goal: `deliver ${i}`, check: `check ${i}`, criterionIds: [`c${i}`], dependsOn: i ? [`s${i - 1}`] : [] }))
    const fitted = fitPlanToBudget(tasks, 16)
    expect(fitted.length).toBeLessThanOrEqual(2)
    expect(fitted.flatMap(task => task.criterionIds)).toEqual(tasks.flatMap(task => task.criterionIds))
    for (const task of tasks) expect(fitted.some(item => item.check.includes(task.check))).toBe(true)
    expect(() => validatePlan(fitted, tasks.flatMap(task => task.criterionIds))).not.toThrow()
    expect(tasks).toHaveLength(5)
  })

  it.each(['failed', 'cancelled', 'succeeded'] as const)('retains settled child effects and evidence when child is %s', async status => {
    let receipt: any
    const program = defineLaneProgram({ id: `receipts-${status}`, version: '1' }, builder => {
      builder.addDynamicForkStep('fork', { lanes: () => ({ child: { goal: 'write then fail', program: { programId: `receipts-${status}`, programVersion: '1', step: 'child' } } }), onJoin: (_outcomes, ctx) => {
        if (ctx.resumeInput?.type === 'wait') receipt = ctx.settledLaneEvidence(ctx.resumeInput.resolution.dependencies.child!.target.id)
        expect(ctx.settledLaneEvidence(ctx.lane.id)).toBeUndefined()
        return { complete: {} }
      } })
      builder.addStep('child', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'model', kind: 'llm', concurrencyClass: 'llm', input: {} }, { key: 'write', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.write', arguments: { path: 'out.mjs' } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'settle' }))
      builder.addStep('settle', ctx => ({ actions: status === 'succeeded' ? [{ type: 'complete', result: { status: 'blocked' } }] : status === 'failed' ? [{ type: 'fail', error: { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED', message: 'budget' } }] : [{ type: 'cancel_lane', laneId: ctx.lane.id, reason: 'USER_REQUESTED' }], next: 'settle' }))
    })
    const runtime = new PulseRuntime({ programs: [program], effectExecutor: async effect => {
      return effect.kind === 'tool' ? { value: { hash: 'written' } } : { value: { text: 'read', finishReason: 'stop' }, metadata: { providerAttempts: 2 } }
    } })
    const { agentId } = runtime.createAgent('parent', program)
    await runtime.start(agentId).outcome()
    expect(receipt.modelCalls).toBe(2)
    expect(receipt.modelEffectIds).toHaveLength(1)
    if (status !== 'cancelled') expect(receipt.evidenceRefs).toHaveLength(1)
  })
})
