import { it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
it('preserves a launch-time ask override when an unrelated capability setting is saved', async () => {
 const root=await mkdtemp(join(tmpdir(),'pulse-live-approval-')),path=join(root,'config.json')
 await writeFile(path,JSON.stringify({approvalMode:'auto',capabilities:{enabled:['skills']}}))
 const host=createLocalHost({cwd:root,dataDir:root,approvalMode:'ask'})
 const server=new H5Server(host,{dataDir:root,host:'127.0.0.1',port:0,configuration:{path,prepare:async file=>{const c=JSON.parse(await readFile(file,'utf8'));return {cwd:root,dataDir:root,approvalMode:c.approvalMode,enabledCapabilityPacks:c.capabilities.enabled}}}})
 try {
  const info=await server.start(),base=`http://127.0.0.1:${info.port}`,session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}}),headers={Origin:base,Cookie:session.headers.get('set-cookie')!,'Content-Type':'application/json'}
  const before=await(await fetch(base+'/api/config',{headers})).json()
  before.config.capabilities.enabled=['skills','browser','computer']
  const response=await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify(before)})
  expect(response.status).toBe(200)
  expect(host.getAutomationOptions()).toEqual({enabled:['browser','computer'],approvalMode:'ask'})
  expect(JSON.parse(await readFile(path,'utf8')).approvalMode).toBe('auto')
 } finally {await server.stop();await host.close();await rm(root,{recursive:true,force:true})}
})
