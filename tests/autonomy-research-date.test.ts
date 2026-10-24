import {expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {contentHash} from '@hunterzhu/pulse-runtime'
import {accessDates,assessResearchDate,verifyResearchDate} from '../scripts/eval/autonomy-research-date.mjs'

const spec={id:'date-fixture',category:'research',prompt:'Use https://docs.example.org/ and include source URL and access date. Mark interpretation as a summary.',scoring:{maxPoints:2,checks:[{type:'containsAll',path:'report.md',needles:['Accessed','Summary'],caseSensitive:false,points:1},{type:'sourceLinks',path:'report.md',points:1}]}}
const legacy={taskId:'date-fixture',score:1,maxPoints:2,passed:false,checks:[{passed:false},{passed:true}]}
const receipt={ref:'result-1',url:'https://docs.example.org/',fetchedAt:'2026-10-23T18:00:00.000Z',contentHash:'verified'}
const assess=(report,extra={})=>assessResearchDate({spec,legacy,report,fetches:[receipt],hostAccepted:true,...extra})

it.each(['Access date: 2026-10-24','Accessed: 2026-10-23 UTC','Retrieved on October 24, 2026','访问日期：2026年10月24日','Date accessed: 24 Oct 2026'])('accepts an actual traceable access date without requiring one English label (%s)',label=>{
 const result=assess(`${label}\nSummary\nhttps://docs.example.org/`)
 expect(result.passed).toBe(true)
 expect(result.legacyPassed).toBe(false)
 expect(legacy.score).toBe(1)
})

it.each(['Accessed: tomorrow','Accessed: 2026-02-31','Accessed: 2027-10-24','Accessed: 2026-10-24 UTC','Accessed: Octopus 24, 2026'])('rejects missing, invalid, future or timezone-inconsistent dates even if v1 keywords pass (%s)',label=>{
 expect(assess(`${label}\nSummary\nhttps://docs.example.org/`,{legacy:{...legacy,passed:true,score:2,checks:[{passed:true},{passed:true}]}}).passed).toBe(false)
})

it('keeps other legacy requirements and Host acceptance mandatory',()=>{
 expect(assess('Access date: 2026-10-24\nhttps://docs.example.org/').passed).toBe(false)
 expect(assess('Access date: 2026-10-24\nSummary',{hostAccepted:false}).passed).toBe(false)
 expect(assess('Access date: 2026-10-24\nSummary',{fetches:[]}).passed).toBe(false)
 expect(assess('Access date: 2026-10-24\nSummary',{legacy:{...legacy,checks:[{passed:false},{passed:false}]}}).passed).toBe(false)
 expect(accessDates('Publication date: 2026-10-24')).toEqual([])
})

it('binds the timezone to the access date rather than a later fetch timestamp',()=>{
 const label='Accessed: 2026-10-24 (local date; page fetched 2026-10-23 18:00 UTC)'
 expect(accessDates(label)).toEqual([{date:'2026-10-24',utc:false}])
 expect(assess(`${label}\nSummary\nhttps://docs.example.org/`).passed).toBe(true)
 expect(assess('Accessed: 2026-10-24 UTC (page fetched 2026-10-23 18:00 UTC)\nSummary').passed).toBe(false)
 expect(assess('Accessed: 2027-10-24 (local date; page fetched 2026-10-23 18:00 UTC)\nSummary').passed).toBe(false)
})

it('requires an unchanged public successful source receipt and never writes the artifact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-date-receipt-')),workspace=join(root,'workspace'),runDir=join(root,'run')
 try{
  await mkdir(workspace);await mkdir(join(runDir,'runtime-results'),{recursive:true})
  const report='Access date: 2026-10-24\nSummary\nhttps://docs.example.org/\n',value={url:'https://docs.example.org/',text:'Official source content.',fetchedAt:receipt.fetchedAt}
  await writeFile(join(workspace,'report.md'),report)
  const effect={kind:'tool',input:{name:'web.fetch',arguments:{url:'https://docs.example.org/'}},outcome:{status:'succeeded',resultRef:'result-1'}}
  const state={effects:[['effect-1',effect]],results:[['result-1',{privacy:'public',contentHash:contentHash(value)}]]}
  await writeFile(join(runDir,'runtime.json'),JSON.stringify({state:{state}}));await writeFile(join(runDir,'runtime-results/receipt.json'),JSON.stringify({ref:'result-1',value}))
  expect((await verifyResearchDate({spec,legacy,workspace,runDir,hostAccepted:true})).passed).toBe(true)
  expect(await readFile(join(workspace,'report.md'),'utf8')).toBe(report)
  await writeFile(join(runDir,'runtime-results/receipt.json'),JSON.stringify({ref:'result-1',value:{...value,fetchedAt:'2026-10-24T00:00:00Z'}}))
  expect((await verifyResearchDate({spec,legacy,workspace,runDir,hostAccepted:true})).passed).toBe(false)
  state.effects[0][1].outcome.status='failed';await writeFile(join(runDir,'runtime.json'),JSON.stringify({state:{state}}))
  expect((await verifyResearchDate({spec,legacy,workspace,runDir,hostAccepted:true})).passed).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
