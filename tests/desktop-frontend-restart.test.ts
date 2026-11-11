import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchesDevelopmentVite, verifyDevelopmentFrontend, stopDevelopmentFrontend } from '../scripts/desktop/restart-frontend.mjs'
import { assertDevelopmentDataDirectory } from '../scripts/desktop/restart-backend.mjs'
import { homedir } from 'node:os'
const repo=fileURLToPath(new URL('../',import.meta.url)),web=join(repo,'packages/web')
const entry=join(dirname(createRequire(join(web,'package.json')).resolve('vite/package.json')),'bin/vite.js')
const children:ChildProcess[]=[],servers:Server[]=[]
afterEach(async()=>{await Promise.all(children.splice(0).map(async child=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit')}}));await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))}))})
async function port(){const s=netServer();await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const p=(s.address()as any).port;await new Promise<void>(resolve=>s.close(()=>resolve()));return p}
it('rejects the production data directory during read-only restart preflight',async()=>{
 await expect(assertDevelopmentDataDirectory(join(homedir(),'.pulse/data'))).rejects.toThrow('拒绝重启正式数据目录')
})
it('matches exact Vite arguments, quotes and working directory, rejecting command lookalikes',async()=>{
 const url='http://127.0.0.1:5199/work/new',args=['--host','127.0.0.1','--port','5199','--strictPort']
 const info={pid:123,cwd:web,executable:process.execPath,command:`${process.execPath} ${entry} ${args.join(' ')}`}
 expect(await matchesDevelopmentVite({info,repo,url,entry})).toBe(true)
 expect(await matchesDevelopmentVite({info:{...info,command:`"${process.execPath}" "${entry}" ${args.join(' ')}`},repo,url,entry})).toBe(true)
 for(const change of [{command:info.command.replace('5199','5200')},{command:info.command+' --other'},{command:info.command.replace('vite.js','vitexjs')},{cwd:repo},{executable:'/bin/sh'}])expect(await matchesDevelopmentVite({info:{...info,...change},repo,url,entry})).toBe(false)
 expect(await matchesDevelopmentVite({info:{pid:123,cwd:web,argv:[process.execPath,entry,...args]},repo,url,entry})).toBe(true)
})
it('does nothing for an unused frontend and rejects unsafe ports before inspection',async()=>{
 const p=await port(),options={repo,url:`http://127.0.0.1:${p}`,backend:'http://127.0.0.1:7333'}
 expect(await verifyDevelopmentFrontend(options)).toBeUndefined()
 await expect(verifyDevelopmentFrontend({...options,url:'http://127.0.0.1:7332'})).rejects.toThrow('地址不安全')
 await expect(verifyDevelopmentFrontend({...options,url:'http://example.com:5199'})).rejects.toThrow('地址不安全')
})
it('does not trust a matching HTTP identity or its claimed PID without an actual Vite socket owner',async()=>{
 const backend='http://127.0.0.1:7333',s=createServer((req,res)=>{if(req.url==='/__pulse_dev')res.end(JSON.stringify({workspace:repo,backend,pid:process.pid}));else res.end('WebSocket')});servers.push(s)
 await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(s.address()as any).port}`
 await expect(stopDevelopmentFrontend({repo,url,backend})).rejects.toThrow('归属无法核验')
 expect(await fetch(url).then(r=>r.text())).toBe('WebSocket')
})
it('rechecks a real Vite PID, stops only that frontend and releases its original port',async()=>{
 const p=await port(),url=`http://127.0.0.1:${p}`,backend='http://127.0.0.1:7333'
 const child=spawn(process.execPath,[entry,'--host','127.0.0.1','--port',String(p),'--strictPort'],{cwd:web,env:{...process.env,PULSE_H5_TARGET:backend},stdio:'ignore'});children.push(child)
 const options={repo,url,backend}
 await expect.poll(()=>verifyDevelopmentFrontend(options).catch(()=>undefined),{timeout:10000}).toMatchObject({pid:child.pid,port:p})
 await expect(stopDevelopmentFrontend({...options,expected:{pid:process.pid,port:p}})).rejects.toThrow('发生变化')
 expect(child.exitCode).toBeNull()
 await stopDevelopmentFrontend({...options,log:()=>{}})
 expect(child.exitCode!==null||child.signalCode!==null).toBe(true)
 expect(await verifyDevelopmentFrontend(options)).toBeUndefined()
},15000)
