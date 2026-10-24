import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error standalone evaluator module
import { withLiveCliBudget } from '../scripts/eval/live-cli-budget.mjs'
it('uses one 64-call workspace budget across separate CLI invocations and preserves all receipts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-live-budget-')),data=join(root,'data'),config=join(root,'config.json'),batch=join(root,'batch')
 try{
  await mkdir(data);await writeFile(config,JSON.stringify({dataDir:data,approvalMode:'ask'}))
  await withLiveCliBudget(config,batch,'turn-1',async()=>{expect(JSON.parse(await readFile(config,'utf8')).maxModelCalls).toBe(64);await mkdir(join(data,'run1'));await writeFile(join(data,'run1/model-budget.json'),JSON.stringify({schemaVersion:1,used:50}));return {code:0}})
  await withLiveCliBudget(config,batch,'turn-2',async()=>{expect(JSON.parse(await readFile(config,'utf8')).maxModelCalls).toBe(14);await mkdir(join(data,'run2'));await writeFile(join(data,'run2/model-budget.json'),JSON.stringify({schemaVersion:1,used:14}));return {code:0}})
  const execute=vi.fn();await expect(withLiveCliBudget(config,batch,'turn-3',execute)).rejects.toThrow('BATCH_BUDGET_EXHAUSTED');expect(execute).not.toHaveBeenCalled()
  const ledger=JSON.parse(await readFile(join(batch,'budget.json'),'utf8'));expect(ledger.attempts.map((a:any)=>a.charged)).toEqual([50,14]);expect(JSON.parse(await readFile(config,'utf8')).maxModelCalls).toBeUndefined()
 }finally{await rm(root,{recursive:true,force:true})}
})
it('requires an explicit batch ledger and keeps the reservation if execution fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-live-budget-')),config=join(root,'config.json'),batch=join(root,'batch'),execute=vi.fn()
 try{
  await writeFile(config,JSON.stringify({dataDir:join(root,'data'),maxModelCalls:17}))
  await expect(withLiveCliBudget(config,undefined,'unconfigured',execute)).rejects.toThrow('PULSE_LIVE_BATCH_DIR_REQUIRED');expect(execute).not.toHaveBeenCalled()
  await expect(withLiveCliBudget(config,batch,'failure',async()=>{throw Error('failed-child')})).rejects.toThrow('failed-child')
  expect(JSON.parse(await readFile(config,'utf8')).maxModelCalls).toBe(17)
  expect(JSON.parse(await readFile(join(batch,'budget.json'),'utf8')).attempts[0].state).toBe('reserved')
 }finally{await rm(root,{recursive:true,force:true})}
})
