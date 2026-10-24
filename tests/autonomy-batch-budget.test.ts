import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withBatchBudget } from '../scripts/eval/autonomy-budget.mjs'

it('blocks unbounded historical usage without calling executor or changing the original ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-budget-audit-'))
  const original = JSON.stringify({ schemaVersion: 1, limit: 1000, perTask: 64, attempts: [{ id: 'unknown', charged: 64, state: 'unreconciled', result: { modelCalls: null } }] })
  const execute = vi.fn()
  try {
    await writeFile(join(dir, 'budget.json'), original)
    await expect(withBatchBudget(dir, 'next', execute)).rejects.toThrow('BATCH_USAGE_UNBOUNDED')
    expect(execute).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'budget.json'), 'utf8')).toBe(original)
    await expect(access(join(dir, 'budget.lock'))).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('counts proven upper bounds and inherited calls against the same logical task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-budget-audit-'))
  try {
    await writeFile(join(dir, 'budget.json'), JSON.stringify({ schemaVersion: 1, limit: 1000, perTask: 64, inheritedTaskCalls: { task: 50 }, attempts: [{ id: 'previous', taskKey: 'task', charged: 4, state: 'unreconciled', result: { upperBound: true, evidence: 'one-request-per-child audit' } }] }))
    await withBatchBudget(dir, 'next', async maxCalls => { expect(maxCalls).toBe(10); return { modelCalls: 9 } }, 'task')
    const execute = vi.fn()
    await expect(withBatchBudget(dir, 'third', execute, 'task')).rejects.toThrow('BATCH_BUDGET_EXHAUSTED')
    expect(execute).not.toHaveBeenCalled()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it.each([-1,65,1.5,'10'])('rejects invalid inherited task usage (%s) before the executor',async inherited=>{
 const dir=await mkdtemp(join(tmpdir(),'pulse-budget-invalid-')),execute=vi.fn()
 try{
  await writeFile(join(dir,'budget.json'),JSON.stringify({schemaVersion:1,limit:1000,perTask:64,attempts:[],inheritedTaskCalls:{task:inherited}}))
  await expect(withBatchBudget(dir,'next',execute,'task')).rejects.toThrow('INVALID_BATCH_LEDGER')
  expect(execute).not.toHaveBeenCalled()
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('honors explicit unlimited regression authorization while retaining usage and refusing new cases', async () => {
 const dir=await mkdtemp(join(tmpdir(),'pulse-budget-unlimited-'))
 try{
  await writeFile(join(dir,'budget.json'),JSON.stringify({schemaVersion:2,limit:null,perTask:null,authorization:{kind:'explicit-user-unlimited'},allowedTaskKeys:['existing'],historicalTaskCalls:{existing:64},attempts:[]}))
  await withBatchBudget(dir,'existing-rerun',async ceiling=>{expect(ceiling).toBe(256);return{modelCalls:81}},'existing')
  const ledger=JSON.parse(await readFile(join(dir,'budget.json'),'utf8'))
  expect(ledger.historicalTaskCalls.existing).toBe(64)
  expect(ledger.attempts[0]).toMatchObject({charged:81,usageKnown:true,state:'recorded'})
  const execute=vi.fn()
  await expect(withBatchBudget(dir,'new-case',execute,'new')).rejects.toThrow('CASE_NOT_IN_AUTHORIZED_REGRESSION_MANIFEST')
  expect(execute).not.toHaveBeenCalled()
 }finally{await rm(dir,{recursive:true,force:true})}
})
