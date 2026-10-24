import {readFile,readdir,appendFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
const [id,effectId]=process.argv.slice(2),out=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-failed-rerun-20261023/live',id)
const ready=JSON.parse(await readFile(join(out,'ready.json'),'utf8'))
if(resolve(ready.dataDir)!==resolve('.pulse-dev/h5/data'))throw Error('NOT_ORIGINAL_DEVELOPMENT_DATA')
const roots=join(ready.dataDir,'conversations',ready.conversationId,'runs'),ids=await readdir(roots)
if(ids.length!==1)throw Error('AMBIGUOUS_RUN')
const rt=JSON.parse(await readFile(join(roots,ids[0],'runtime.json'),'utf8')),effect=rt.state.state.effects.find(([key])=>key===effectId)?.[1]
if(!effect||effect.kind!=='human'||effect.state!=='running'||!Array.isArray(effect.input?.tools))throw Error('NOT_PENDING_TOOL_APPROVAL')
const sha=createHash('sha256').update(JSON.stringify(effect.input)).digest('hex')
const review=(await readFile(join(out,'ui-approvals.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).findLast(x=>x.effectId===effectId&&x.runId===ids[0])
if(review?.requestSha256!==sha||typeof review.approved!=='boolean'||!review.review)throw Error('CONCRETE_REVIEW_REQUIRED')
const receipt={at:new Date().toISOString(),runId:ids[0],effectId,requestSha256:sha,approved:review.approved,rawInput:effect.input,source:'evaluator-simulated-human-original-development-api',review:review.review,note:'Supplemental API assistance; not evidence of successful Electron approval interaction.'}
await appendFile(join(out,'api-approvals.jsonl'),JSON.stringify({...receipt,phase:'intent'})+'\n')
const base='http://127.0.0.1:7333',session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
if(!session.ok)throw Error('DEVELOPMENT_SESSION_UNAVAILABLE')
const response=await fetch(base+'/api/runs/'+ids[0]+'/reply',{method:'POST',headers:{Origin:base,Cookie:session.headers.get('set-cookie'),'Content-Type':'application/json'},body:JSON.stringify({effectId,approved:review.approved,...(review.approved?{}:{reason:review.review.slice(0,500)})})})
const body=await response.json()
await appendFile(join(out,'api-approvals.jsonl'),JSON.stringify({...receipt,phase:'response',status:response.status,body})+'\n')
if(!response.ok)throw Error('REPLY_REJECTED')
console.log(JSON.stringify({runId:ids[0],effectId,status:response.status}))
