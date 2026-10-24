import {readFile,appendFile,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
const [id,effectId,reason]=process.argv.slice(2),out=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-20261022/live',id),ready=JSON.parse(await readFile(join(out,'ready.json'),'utf8'))
const runs=join(ready.dataDir,'conversations',ready.conversationId,'runs'),ids=await readdir(runs);if(ids.length!==1)throw Error('AMBIGUOUS_RUN')
const runtime=JSON.parse(await readFile(join(runs,ids[0],'runtime.json'),'utf8'))
const effects=runtime.state.state.effects.filter(([,e])=>Array.isArray(e.input?.tools))
if(!effectId){console.log(JSON.stringify({runId:ids[0],effect:effects.at(-1)},null,2));process.exit()}
if(!reason)throw Error('REVIEW_REASON_REQUIRED')
const effect=effects.find(([id])=>id===effectId)?.[1];if(!effect)throw Error('EFFECT_NOT_FOUND')
await appendFile(join(out,'ui-approvals.jsonl'),JSON.stringify({runId:ids[0],effectId,rawInput:effect.input,requestSha256:createHash('sha256').update(JSON.stringify(effect.input)).digest('hex'),approved:true,review:reason,source:'evaluator-simulated-human-electron',reviewedAt:new Date().toISOString()})+'\n')
console.log('Review recorded. UI approval remains a separate action.')
