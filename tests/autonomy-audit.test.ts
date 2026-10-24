import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error evaluator is a standalone JS entrypoint
import { auditHistory, redact } from '../scripts/eval/audit-history.mjs'
// @ts-expect-error evaluator is a standalone JS entrypoint
import { withBatchBudget } from '../scripts/eval/autonomy-budget.mjs'
import { outcomeDiagnostics } from '../packages/server/src/task-controller/diagnostics.js'

it('deduplicates copied history and never equates reported acceptance with external verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autonomy-audit-'))
  try {
    for (const dir of ['a','b']) {
      const path = join(root, dir, 'conversations/c1/runs/r1'); await mkdir(path, { recursive: true })
      await writeFile(join(path,'input.json'), JSON.stringify({ goal: 'Read https://private.example?token=secret', createdAt:'2026-01-01' }))
      await writeFile(join(path,'outcome.json'), JSON.stringify({status:'succeeded'}))
      await writeFile(join(path,'task-outcome.json'), JSON.stringify({status:'accepted'}))
    }
    const result = await auditHistory([join(root,'a'),join(root,'b')])
    expect(result.records).toHaveLength(1); expect(result.records[0].sources).toHaveLength(2)
    expect(result.records[0].classification).toBe('reported-accepted-unverified')
    expect(JSON.stringify(result)).not.toContain('private.example')
    expect(redact('token=abc apiKey=xyz')).not.toContain('abc')
  } finally { await rm(root,{recursive:true,force:true}) }
})

it('reserves crash usage, refuses overlapping evaluators, and enforces the shared 800-call ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autonomy-budget-'))
  try {
    await expect(withBatchBudget(root,'unknown',async()=>{throw Error('crash')})).rejects.toThrow('crash')
    for(let i=0;i<11;i++) await withBatchBudget(root,`case-${i}`,async (max:number)=>({modelCalls:max}), `independent-${i}`)
    await withBatchBudget(root,'last',async(max:number)=>{
      expect(max).toBe(32)
      await expect(withBatchBudget(root,'overlap',async()=>({modelCalls:0}))).rejects.toThrow()
      return {modelCalls:max}
    })
    await expect(withBatchBudget(root,'excess',async()=>({modelCalls:0}))).rejects.toThrow('BATCH_BUDGET_EXHAUSTED')
    const ledger = JSON.parse(await readFile(join(root,'budget.json'),'utf8'))
    expect(ledger.attempts.reduce((n:number,a:any)=>n+a.charged,0)).toBe(800)
    expect(ledger.attempts[0]).toMatchObject({state:'reserved',charged:64})
  } finally { await rm(root,{recursive:true,force:true}) }
})

it('separates authorization intervention from clarification and identifies budget recovery', () => {
  const state = {effects:new Map([['a',{kind:'human',input:{tools:[{}]}}],['b',{kind:'human',input:{question:'which format'}}]])} as any
  expect(outcomeDiagnostics(state,[], 'TASK_MODEL_CALL_BUDGET_EXHAUSTED')).toMatchObject({interventions:{approvalRequests:1,clarificationRequests:1},blockers:[{code:'TASK_MODEL_CALL_BUDGET_EXHAUSTED',recovery:'request-budget'}]})
})
