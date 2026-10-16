import { join } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../../packages/tool-sdk/dist/index.js'
import { acceptanceCriteriaFromObjective } from '../../packages/server/dist/task.js'
import { argumentCheckKinds } from '../../packages/server/dist/task-controller/acceptance.js'
import { captureCheck, finishCheck } from '../../packages/server/dist/check-receipt.js'
import { runShell } from '../../packages/adapters/dist/tools/shell.js'
import { probeResumeIntegration, resumeCheckIds } from './long-task-resume-probe.mjs'
import { probeRunnerIntegration } from './long-task-probe.mjs'

const entryChecks = ['nested explicit call budget', 'nested legacy call alias', 'legacy flat config', 'unknown model rejected before CLI', 'zero budget rejected before CLI', 'conflicting aliases rejected before CLI', 'duplicate budget flag rejected before CLI', 'missing budget value rejected before CLI']
/** Trusted harness adapter: no candidate test, grader or model-proposed assertion is loaded. */
export function evaluationRunnerAcceptance(workspace, caseDir, objective) {
  const criterionIds = acceptanceCriteriaFromObjective(objective).filter(c => /非法/.test(c.description) && /预算/.test(c.description)).map(c => c.id)
  if (!criterionIds.length) return undefined
  const expectedChecks = ['module-contract', ...entryChecks]
  const check = { id: 'evaluation-runner-contract', description: 'Independent helper and actual runner positive/negative entry checks; fake CLI records any dispatch.', criterionIds, toolName: 'evaluation-acceptance.check', input: {}, expectedChecks, covers: [...argumentCheckKinds] }
  const pack = {
    manifest: { id: 'evaluation-acceptance', version: '1', kind: 'integration', title: 'Independent evaluation acceptance', description: 'Host-owned offline probes; candidate self-tests cannot override these checks.' },
    activate: async () => ({ tools: [defineTool({
      name: 'evaluation-acceptance.check', description: check.description,
      input: z.object({}).strict(), output: z.object({ checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string() })), checkReceipt: z.any() }), sideEffectPolicy: 'read', defaultTimeoutMs: 120000,
      execute: async (_, context) => {
        context.signal?.throwIfAborted()
        const before = await captureCheck(workspace, workspace, 'node', ['--test'])
        const module = await runShell('node', ['--input-type=module', '-e', `import assert from 'node:assert/strict'; const {resolveEvaluationModel:r,buildEvaluationArgs:b}=await import('./scripts/eval/config-budget.mjs');const p={provider:'deepseek',models:{flash:{modelCode:'deepseek-flash'}}};assert.equal(r({providers:{ds:p}},'ds/flash').providerCode,'ds');assert.equal(r({providers:{ds:p}},'ds/flash').modelCode,'deepseek-flash');assert.equal(r({providers:{ds:{provider:'deepseek'}},models:{legacy:{provider:'ds',modelCode:'deepseek-flash'}}},'legacy').modelCode,'deepseek-flash');assert.throws(()=>r({providers:{ds:p}},'ds/missing'));assert.deepEqual(b({maxModelCalls:16,maxTurns:32}),['--max-model-calls','16','--max-turns','32']);for(const n of [0,-1,NaN,1.5,257])assert.throws(()=>b({maxModelCalls:n,maxTurns:32}));`], { cwd: workspace, signal: context.signal, timeoutMs: 30000, maxOutputBytes: 12000, env: { PATH: process.env.PATH } })
        const entry = await probeRunnerIntegration(workspace, join(caseDir, `host-acceptance-${Date.now()}`), { signal: context.signal })
        return { checks: [{ id: 'module-contract', passed: module.code === 0 && !module.timedOut && !module.truncated, detail: `${module.code}: ${module.stderr}`.slice(-2000) }, ...entry.map(c => ({ id: c.name, passed: c.passed, detail: c.detail }))], checkReceipt: await finishCheck(workspace, before) }
      },
    })] }),
  }
  return { checks: [check], pack }
}

/** LT02: frozen resume semantics, journal preservation and historical budget bounds. */
export function evaluationResumeAcceptance(workspace, caseDir, objective) {
  const criteria = acceptanceCriteriaFromObjective(objective), criterionIds = criteria.map(c => c.id)
  const scopes = {
    'helper-order-and-dedup': /selectPendingTrials/,
    'all-six-terminal-statuses': /已终态 status|terminal status/i,
    'running-and-pending-retained': /running\/pending/,
    'actual-runner-failure-resume-no-replay': /恢复同一输出|terminal.*replay/i,
    'duplicate-terminal-history-summary': /汇总|summary/i,
    'corrupt-jsonl-fails-before-cli-and-preserves-bytes': /损坏 JSONL|corrupt/i,
    'actual-interruption-retains-terminal-and-user-artifact': /已有记录和产物|preserv/i,
    'resumed-token-cap-not-reset': /成本边界|budget|cost/i,
    'resumed-unknown-cost-cap-not-reset': /成本边界|budget|cost/i,
  }
  const assertionCriterionIds = Object.fromEntries(resumeCheckIds.map(id => { const matched = criteria.filter(c => c.id === criterionIds[0] || scopes[id]?.test(c.description)).map(c => c.id); return [id, matched.length ? matched : criterionIds] }))
  const check = { assertionCriterionIds, id: 'evaluation-resume-contract', description: 'Independent actual-runner resume checks with a recording fake CLI; no candidate assertions.', criterionIds, toolName: 'evaluation-acceptance.resume', input: {}, expectedChecks: resumeCheckIds }
  const pack = {
    manifest: { id: 'evaluation-acceptance', version: '1', kind: 'integration', title: 'Independent resume acceptance', description: check.description },
    activate: async () => ({ tools: [defineTool({
      name: check.toolName, description: check.description,
      input: z.object({}).strict(), output: z.object({ checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string().optional() })), checkReceipt: z.any() }),
      sideEffectPolicy: 'read', defaultTimeoutMs: 120000,
      execute: async (_, context) => {
        context.signal?.throwIfAborted()
        const before = await captureCheck(workspace, workspace, 'node', ['--test'])
        const checks = await probeResumeIntegration(workspace, join(caseDir, `host-resume-acceptance-${Date.now()}`), { signal: context.signal })
        return { checks, checkReceipt: await finishCheck(workspace, before) }
      },
    })] }),
  }
  return { checks: [check], pack }
}
