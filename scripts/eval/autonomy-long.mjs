import { spawn, execFileSync } from 'node:child_process'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { withBatchBudget } from './autonomy-budget.mjs'

const batch=resolve(process.argv[2]??'.pulse-dev/autonomy-20261022/live'), round=process.argv[3]??'round-autonomy-20261022', filter=process.argv[4], taskRound=process.argv[5]??round
const root=resolve('tests/real-task')
for(const slug of (await readdir(root)).filter(x=>/^\d{2}-/.test(x)&&(!filter||x.startsWith(filter))).sort()){
  const id=`${round}-${slug}`
  await withBatchBudget(batch,id,async maxCalls=>{
    const scenario=join(root,slug),output=join(scenario,'runs',round)
    await mkdir(output,{recursive:false})
    const files={}
    for(const p of ['scenario.json','verify.mjs'])files[p]=createHash('sha256').update(await readFile(join(scenario,p))).digest('hex')
    async function snapshot(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await snapshot(p);else files[p]=createHash('sha256').update(await readFile(p)).digest('hex')}}
    await snapshot(join(scenario,'seed'))
    for(const pkg of ['server','runtime','adapters','tool-sdk'])for(const sub of ['src','dist'])await snapshot(`packages/${pkg}/${sub}`)
    for(const p of ['tests/real-task/runner.mjs', 'scripts/eval/autonomy-long.mjs'])files[p]=createHash('sha256').update(await readFile(p)).digest('hex')
    await writeFile(join(output,'freeze.json'),JSON.stringify({files,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),maxCalls},null,2))
    const code=await new Promise((res,rej)=>{const child=spawn(process.execPath,['tests/real-task/runner.mjs','run','--scenario',slug,'--round',round,'--max-calls',String(maxCalls),'--approval-inbox',join(batch,'approvals'),'--keep-workspace'],{stdio:'inherit'});child.once('error',rej);child.once('exit',res)})
    const result=JSON.parse(await readFile(join(output,'result.json'),'utf8'))
    if(result.usage?.modelCalls===undefined||result.interruptedRuns.some(r=>r.usage?.modelCalls===undefined))throw Error('UNKNOWN_USAGE_KEEP_RESERVATION')
    return {modelCalls:result.totalModelCalls,passed:result.passed,code,result:join(output,'result.json')}
  }, `${taskRound}-${slug}`)
}
