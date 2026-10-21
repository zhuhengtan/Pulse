import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require=createRequire(new URL('../../packages/server/package.json',import.meta.url)),{_electron}=createRequire(require.resolve('@playwright/mcp'))('playwright')
const root=await mkdtemp(join(tmpdir(),'pulse-desktop-startup-')),data=join(root,'data'),env={...process.env,PULSE_DESKTOP_USER_DATA:join(root,'user'),PULSE_DESKTOP_DATA_DIR:data,PULSE_HOME:join(root,'home'),PULSE_JARVIS_ENABLED:'false'}
delete env.ELECTRON_RUN_AS_NODE
let desktop,ownedPid
try{
 const executable=process.env.PULSE_DESKTOP_EXECUTABLE??createRequire(new URL('../../packages/desktop/package.json',import.meta.url))('electron')
 desktop=await _electron.launch({executablePath:executable,args:process.env.PULSE_DESKTOP_EXECUTABLE?[]:[fileURLToPath(new URL('../../packages/desktop',import.meta.url))],env,timeout:25000})
 const page=await desktop.firstWindow()
 await page.getByRole('heading',{name:'我们要做什么？'}).waitFor({timeout:15000})
 const descriptor=JSON.parse(await readFile(join(data,'service.json'),'utf8'));ownedPid=descriptor.pid
 if(descriptor.protocol!==1||!Number.isInteger(ownedPid)||ownedPid===process.pid)throw new Error('INVALID_BACKGROUND_SERVICE')
 await desktop.close();desktop=undefined
 process.kill(ownedPid,0)
 const response=await fetch(`http://127.0.0.1:${descriptor.port}/api/session/local`,{method:'POST',headers:{Origin:`http://127.0.0.1:${descriptor.port}`}})
 if(!response.ok)throw new Error('BACKGROUND_NOT_ALIVE')
 console.log(JSON.stringify({ok:true,startsOwnBackground:true,serviceSurvivesDesktopExit:true,bundledNode:Boolean(process.env.PULSE_DESKTOP_EXECUTABLE)}))
}finally{
 await desktop?.close()
 ownedPid??=await readFile(join(data,'service.json'),'utf8').then(text=>JSON.parse(text).pid).catch(()=>undefined)
 if(ownedPid){try{process.kill(ownedPid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error};for(let i=0;i<100;i++){try{process.kill(ownedPid,0)}catch{break}await new Promise(r=>setTimeout(r,50))}}
 await new Promise(r=>setTimeout(r,1700));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})
}
