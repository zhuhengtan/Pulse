import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it} from 'vitest'
import {createLocalHost,H5Server} from '../packages/server/src/index.js'
it('delivers a delayed approval clear to clients that have already consumed newer tool events',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pulse-interaction-cursor-')),host=createLocalHost({cwd:dir,dataDir:dir}),server=new H5Server(host,{dataDir:dir,port:0,host:'127.0.0.1'})
 await host.init()
 const projection=server as any,runId='run-delayed-approval'
 projection.runEventBuffers.set(runId,[])
 try{
  projection.pushEvent(runId,{runId,type:'interactions',seq:4.25,data:{interactions:[{groupId:'approval',kind:'approval',items:[{effectId:'effect-a',input:{kind:'approval'}}]}]}})
  projection.pushEvent(runId,{runId,type:'status',seq:7,data:{label:'Tool completed'}})
  // The review callback retained its original waiting-event cursor.
  projection.pushEvent(runId,{runId,type:'interactions',seq:4.5,data:{interactions:[]}})
  const replay=projection.runEventBuffers.get(runId).filter((event:any)=>event.seq>7)
  expect(replay).toHaveLength(1)
  expect(replay[0]).toMatchObject({type:'interactions',data:{interactions:[]}})
  expect((await projection.snapshotRun(runId,[],true)).interactions).toEqual([])
 }finally{await server.stop();await host.close();await rm(dir,{recursive:true,force:true})}
})
