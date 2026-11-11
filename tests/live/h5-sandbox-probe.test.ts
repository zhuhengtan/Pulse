import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, H5Server } from '@hunterzhu/pulse-server'
it.skipIf(process.env.PULSE_SANDBOX_H5_PROBE!=='1')('serves a real isolated authenticated H5 request with private IPC',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-h5-sandbox-fixture-'))
  const host=createLocalHost({cwd:root,dataDir:join(root,'data'),provider:{provider:'mock',defaultModel:'mock'},taskController:false,jarvis:{enabled:false},allowNetwork:false,builtinPluginConfigPath:join(root,'config.json')})
  const server=new H5Server(host,{dataDir:join(root,'data'),host:'127.0.0.1',port:0})
  try{
    const {port}=await server.start(),base=`http://127.0.0.1:${port}`
    const auth=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
    const Cookie=auth.headers.get('set-cookie')!.split(';')[0]!
    const response=await fetch(base+'/api/assistant',{headers:{Cookie}})
    expect(response.status).toBe(200)
    expect((await response.json() as any).workInteractions).toEqual([])
  }finally{await server.stop();await host.close();await new Promise(r=>setTimeout(r,1700));await rm(root,{recursive:true,force:true})}
},20000)
