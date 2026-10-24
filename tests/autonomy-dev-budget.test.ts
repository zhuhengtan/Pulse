import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {withDevCallBudget} from '../scripts/eval/autonomy-dev-budget.mjs'
afterEach(()=>vi.unstubAllGlobals())
it.each([false,true])('restores only the temporary budget, including callback failure (%s)',async fail=>{
 const dir=await mkdtemp(join(tmpdir(),'pulse-eval-budget-'))
 let config:any={approvalMode:'ask',capabilities:{enabled:['skills','browser','computer']}}
 let revision=0
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{
  if(url.endsWith('/api/session/local'))return new Response('{}',{headers:{'set-cookie':'test=local'}})
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);expect(body.version).toBe(String(revision));config=body.config;revision++
   return Response.json({applied:true,restartRequired:[]})
  }
  return Response.json({path:resolve('.pulse-dev/autonomy-20261023/prepared-dev-config.json'),version:String(revision),config})
 }))
 try{
  const run=withDevCallBudget(dir,17,async()=>{expect(config.maxModelCalls).toBe(17);expect(config.approvalMode).toBe('ask');config.unrelated='concurrent-edit';revision++;if(fail)throw Error('test-failure');return 'done'})
  if(fail)await expect(run).rejects.toThrow('test-failure');else expect(await run).toBe('done')
  expect(config.maxModelCalls).toBeUndefined();expect(config.unrelated).toBe('concurrent-edit');expect(config.capabilities.enabled).toEqual(['skills','browser','computer'])
  expect(JSON.parse(await readFile(join(dir,'budget-configuration-restored.json'),'utf8')).restored).toBeNull()
 }finally{await rm(dir,{recursive:true,force:true})}
})
