import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const batch=resolve(process.argv[2]??'.pulse-dev/autonomy-20261022/live')
const dataset=JSON.parse(await readFile('evals/tasks.v1.json','utf8'))
outer: for(let trial=1;trial<=3;trial++)for(const task of dataset.tasks){
  const code=await new Promise((res,rej)=>{const p=spawn(process.execPath,['scripts/eval/autonomy-live.mjs','--batch',batch,'--case',task.id,'--attempt',`${task.id}-trial-${trial}`],{stdio:'inherit'});p.on('error',rej);p.on('exit',res)})
  if(code!==0){console.error('Batch stopped; preserve failed attempt/reservation before continuing.');process.exitCode=code;break outer}
}
