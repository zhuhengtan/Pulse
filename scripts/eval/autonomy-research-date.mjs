import {readFile,readdir,realpath,stat} from 'node:fs/promises'
import {resolve,relative,isAbsolute,join} from 'node:path'
import {createHash} from 'node:crypto'
import {contentHash} from '../../packages/runtime/dist/index.js'

export const acceptanceVersion=2
const dateNeedle=value=>typeof value==='string'&&value.trim().toLowerCase()==='accessed'
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const monthNumber=value=>/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i.test(value)?months.indexOf(value.slice(0,3).toLowerCase())+1:0
const canonical=(year,month,day)=>{
 const date=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)))
 return date.getUTCFullYear()===Number(year)&&date.getUTCMonth()===Number(month)-1&&date.getUTCDate()===Number(day)?date.toISOString().slice(0,10):undefined
}
export function accessDates(text){
 const rows=[]
 for(const line of text.split(/\r?\n/)){
  const label=/(?:\b(?:accessed(?:\s+on)?|access\s+date|date\s+accessed|retrieved(?:\s+on)?|fetched(?:\s+at)?)\b|访问日期|访问时间|获取日期|抓取时间)/i.exec(line)
  if(!label)continue
  const tail=line.slice(label.index+label[0].length),dates=[]
  for(const m of tail.matchAll(/\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\b/g))dates.push({at:m.index,date:canonical(m[1],m[2],m[3])})
  for(const m of tail.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/g)){const month=monthNumber(m[1]);if(month)dates.push({at:m.index,date:canonical(m[3],month,m[2])})}
  for(const m of tail.matchAll(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/g)){const month=monthNumber(m[2]);if(month)dates.push({at:m.index,date:canonical(m[3],month,m[1])})}
  dates.sort((a,b)=>a.at-b.at)
  const first=dates[0]
  // A line may state a local access date and a separate UTC fetch timestamp.
  // A timezone attached to that later date cannot relabel the access date.
  const dateClause=tail.slice(0,dates[1]?.at??tail.length)
  if(first?.date)rows.push({date:first.date,utc:/\bUTC\b|协调世界时/i.test(dateClause)})
 }
 return rows
}
export function assessResearchDate({spec,legacy,report,fetches,hostAccepted,timeZone='Asia/Shanghai'}){
 const applicable=spec.category==='research'&&/access\s+date|访问日期|访问时间/i.test(spec.prompt)
 if(!applicable)return{acceptanceVersion,applicable:false,passed:legacy.passed===true}
 const dates=accessDates(report),proofs=[]
 for(const receipt of fetches){
  const timestamp=new Date(receipt.fetchedAt)
  if(!Number.isFinite(timestamp.getTime()))continue
  const utc=timestamp.toISOString().slice(0,10),local=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(timestamp)
  if(dates.some(date=>date.date===utc||!date.utc&&date.date===local))proofs.push({ref:receipt.ref,url:receipt.url,fetchedAt:receipt.fetchedAt,contentHash:receipt.contentHash})
 }
 const checks=spec.scoring.checks.map((check,index)=>{
  const needles=check.type==='contains'?[check.needle]:check.type==='containsAll'?check.needles:[]
  if(!needles.some(dateNeedle))return{index,passed:legacy.checks?.[index]?.passed===true,method:'unchanged-v1',points:check.points??1}
  const remaining=needles.filter(needle=>!dateNeedle(needle)),body=check.caseSensitive===false?report.toLowerCase():report
  const otherNeedles=remaining.every(needle=>body.includes(check.caseSensitive===false?needle.toLowerCase():needle))
  return{index,passed:proofs.length>0&&otherNeedles,method:'verified-source-access-date',points:check.points??1}
 })
 return{acceptanceVersion,applicable:true,passed:hostAccepted===true&&proofs.length>0&&checks.every(check=>check.passed),hostAccepted:hostAccepted===true,legacyScore:legacy.score,legacyMaxPoints:legacy.maxPoints,legacyPassed:legacy.passed===true,score:checks.reduce((sum,check)=>sum+(check.passed?check.points:0),0),maxPoints:spec.scoring.maxPoints,checks,metadataDates:dates,sourceDateProofs:proofs,coverage:'Date metadata is checked against integrity-verified successful public web.fetch receipts. All other v1 checks and Host acceptance remain required. This does not replace the factual content audit.'}
}
const requestedURLs=spec=>[...spec.prompt.matchAll(/https?:\/\/[^\s<>]+/g)].map(match=>match[0].replace(/[),.;`]+$/g,''))
function relevantURL(url,spec){
 try{const actual=new URL(url);if(actual.username||actual.password)return false;return requestedURLs(spec).some(value=>{const expected=new URL(value);return actual.origin===expected.origin&&(actual.pathname===expected.pathname||expected.pathname.endsWith('/')&&actual.pathname.startsWith(expected.pathname))})}catch{return false}
}
export async function verifyResearchDate({spec,legacy,workspace,runDir,hostAccepted,timeZone}){
 if(spec.category!=='research'||!/access\s+date|访问日期|访问时间/i.test(spec.prompt))return assessResearchDate({spec,legacy,report:'',fetches:[],hostAccepted,timeZone})
 const paths=[...new Set(spec.scoring.checks.map(check=>check.path).filter(Boolean))]
 if(paths.length!==1)return{acceptanceVersion,applicable:true,passed:false,reason:'DATE_REPORT_SCOPE_UNSUPPORTED'}
 const root=await realpath(workspace),target=await realpath(resolve(root,paths[0])),scope=relative(root,target)
 if(isAbsolute(scope)||scope.startsWith('..')||(await stat(target)).size>1_000_000)throw Error('INVALID_REPORT_SCOPE')
 const report=await readFile(target,'utf8'),snapshot=JSON.parse(await readFile(join(runDir,'runtime.json'),'utf8')),state=snapshot.state.state
 const results=new Map(state.results),wanted=new Map()
 for(const[,effect]of state.effects){const input=effect.input;if(effect.kind==='tool'&&input?.name==='web.fetch'&&effect.outcome?.status==='succeeded'&&relevantURL(input.arguments?.url,spec)){const ref=effect.outcome.resultRef,meta=results.get(ref);if(meta?.privacy==='public'&&!meta.privacyTaints?.length&&meta.contentHash)wanted.set(ref,{meta,url:input.arguments.url})}}
 const bodies=new Map()
 for(const[ref,{meta}]of wanted)if(meta.value!==undefined)bodies.set(ref,meta.value)
 if(wanted.size)for(const name of await readdir(join(runDir,'runtime-results'))){if(!name.endsWith('.json'))continue;const value=JSON.parse(await readFile(join(runDir,'runtime-results',name),'utf8'));if(wanted.has(value.ref))bodies.set(value.ref,value.value)}
 const fetches=[]
 for(const[ref,{meta,url}]of wanted){const value=bodies.get(ref);if(!value||contentHash(value)!==meta.contentHash||typeof value.fetchedAt!=='string'||typeof value.text!=='string'||!value.text.trim())continue;const safe=new URL(url);fetches.push({ref,url:safe.origin+safe.pathname,fetchedAt:value.fetchedAt,contentHash:meta.contentHash})}
 const verdict=assessResearchDate({spec,legacy,report,fetches,hostAccepted,timeZone})
 return{...verdict,reportPath:paths[0],reportSha256:createHash('sha256').update(report).digest('hex'),graderSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')}
}
