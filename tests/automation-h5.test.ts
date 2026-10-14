import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it('requires an explicit device grant for screenshot/control APIs and applies revocation immediately', async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-auto-h5-'))
 const host=createLocalHost({cwd:root,dataDir:root})
 const server=new H5Server(host,{dataDir:root,host:'127.0.0.1',port:0})
 const info=await server.start(),base=`http://127.0.0.1:${info.port}`
 try{
  const local=await fetch(`${base}/api/session/local`,{method:'POST',headers:{Origin:base}})
  const cookie=local.headers.get('set-cookie')!.split(';')[0]!
  const pairing=await fetch(`${base}/api/pair/qr`,{headers:{Cookie:cookie,Origin:base}})
  if(pairing.status!==200)throw new Error(`pairing fixture failed: ${pairing.status}`)
  const codeInfo=await pairing.json() as {code:string}
  const response=await fetch(`${base}/api/pair`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({code:codeInfo.code,name:'controlled-phone'})})
  const deviceCookie=response.headers.get('set-cookie')!.split(';')[0]!
  const devices=await (await fetch(`${base}/api/devices`,{headers:{Cookie:cookie}})).json() as Array<{id:string;name:string}>
  const device=devices.find(device=>device.name==='controlled-phone')!
  expect((await fetch(`${base}/api/automation/sessions`,{headers:{Cookie:deviceCookie}})).status).toBe(403)
  expect((await fetch(`${base}/api/automation/sessions/fake/frame`,{headers:{Cookie:deviceCookie}})).status).toBe(403)
  expect((await fetch(`${base}/api/devices/${device.id}/automation`,{method:'POST',headers:{Cookie:deviceCookie,Origin:base,'Content-Type':'application/json'},body:'{"enabled":true}'})).status).toBe(403)
  const set=(enabled:boolean)=>fetch(`${base}/api/devices/${device.id}/automation`,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({enabled})})
  expect((await set(true)).status).toBe(200)
  expect((await fetch(`${base}/api/automation/permissions`,{method:'POST',headers:{Cookie:deviceCookie,Origin:base,'Content-Type':'application/json'},body:'{}'})).status).toBe(403)
  expect((await fetch(`${base}/api/automation/sessions`,{headers:{Cookie:deviceCookie}})).status).toBe(200)
  expect((await fetch(`${base}/api/session`,{headers:{Cookie:deviceCookie}})).status).toBe(200)
  expect((await set(false)).status).toBe(200)
  expect((await fetch(`${base}/api/automation/sessions`,{headers:{Cookie:deviceCookie}})).status).toBe(403)
 }finally{await server.stop();await host.close();await rm(root,{recursive:true,force:true})}
})
