import { expect, it } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { inspectFrontendPort } from '../../scripts/desktop/restart-frontend.mjs'
import { stopDevelopmentDesktop } from '../../scripts/desktop/restart-desktop.mjs'
import { stopDevelopmentBackend } from '../../scripts/desktop/restart-backend.mjs'

const execute=promisify(execFile),repo=fileURLToPath(new URL('../../',import.meta.url))
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
async function port(){const s=createServer();await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const p=(s.address()as any).port;await new Promise<void>(resolve=>s.close(()=>resolve()));return p}
async function speechChildren(pid:number){const result=await execute('ps',['-axo','pid=,ppid=,command=']);return result.stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&Number(m[2])===pid&&m[3]!.includes('/voice/local-worker.mjs')?[Number(m[1])]:[]})}
it.runIf(process.env.PULSE_LOCAL_DEV_NATIVE === '1' && process.platform==='darwin')('fully restarts isolated Electron, voice worker, Vite and backend while retaining profile and chat',async()=>{
 const root=await realpath(await mkdtemp(join('/tmp','pulse-full-restart-'))),dev=join(root,'dev'),data=join(dev,'h5/data'),userData=join(dev,'electron')
 const backendPort=await port(),webPort=await port(),base=`http://127.0.0.1:${backendPort}`,url=`http://127.0.0.1:${webPort}/tests/dictation.html`
 const env={...process.env,PULSE_DEV_DIR:dev,PULSE_HOME:join(root,'home'),PULSE_CONFIG:join(root,'config.json'),PULSE_WEB_DEV_PORT:String(backendPort),PULSE_DESKTOP_DEV_URL:url,PULSE_JARVIS_ENABLED:'false'}
 const executable=createRequire(join(repo,'packages/desktop/package.json'))('electron'),appPath=join(repo,'packages/desktop')
 const launchers:ChildProcess[]=[],backendPids=new Set<number>();let output=''
 const start=(restart=false)=>{const child=spawn(process.execPath,[join(repo,'scripts/desktop/start-local.mjs'),...(restart?['--restart']:[]),'--no-build'],{cwd:root,env,stdio:['ignore','pipe','pipe']});launchers.push(child);let log='';child.stdout?.on('data',v=>{log+=v;output+=v});child.stderr?.on('data',v=>{log+=v;output+=v});return{child,log:()=>log}}
 const record=(file:string)=>readFile(file,'utf8').then(JSON.parse)
 const desktop=()=>record(join(userData,'development-desktop.json')),backend=()=>record(join(data,'service.json'))
 try{
  const first=start()
  await expect.poll(async()=>{if(first.child.exitCode!==null)throw new Error(first.log());return desktop().then(d=>alive(d.pid),()=>false)},{timeout:60000}).toBe(true)
  const oldDesktop=await desktop(),oldBackend=await backend();backendPids.add(oldBackend.pid)
  const oldFrontend=await inspectFrontendPort(webPort)
  await mkdir(userData,{recursive:true});await writeFile(join(userData,'preserve-profile'),'keep profile');await writeFile(join(data,'preserve-data'),'keep data')
  const local=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}}),cookie=local.headers.get('set-cookie')!.split(';')[0]!
  const headers={Origin:base,Cookie:cookie,'Content-Type':'application/json'}
  const conversation=await fetch(base+'/api/conversations',{method:'POST',headers,body:JSON.stringify({title:'完整重启保留的会话',projectId:null})}).then(r=>r.json())
  expect(conversation.id).toBeTruthy()
  const voice=await fetch(base+'/api/voice/config',{headers}).then(r=>r.json())
  const save=await fetch(base+'/api/voice/config',{method:'POST',headers,body:JSON.stringify({...voice,enabled:true,wakeEnabled:false,asr:{...voice.asr,backend:'local',model:'pulse-sensevoice-small'}})})
  expect(save.ok).toBe(true)
  await expect.poll(()=>speechChildren(oldDesktop.pid),{timeout:15000}).not.toHaveLength(0)
  const oldSpeech=await speechChildren(oldDesktop.pid)
  const second=start(true)
  await expect.poll(()=>{if(second.child.exitCode!==null)throw new Error(second.log());return second.log().includes('开发桌面主进程已启动')},{timeout:60000}).toBe(true)
  const nextDesktop=await desktop(),nextBackend=await backend(),nextFrontend=await inspectFrontendPort(webPort);backendPids.add(nextBackend.pid)
  expect(nextDesktop.pid).not.toBe(oldDesktop.pid);expect(nextBackend.pid).not.toBe(oldBackend.pid);expect(nextFrontend.pid).not.toBe(oldFrontend.pid)
  expect(nextBackend.port).toBe(oldBackend.port)
  for(const pid of [oldDesktop.pid,oldBackend.pid,oldFrontend.pid,...oldSpeech])await expect.poll(()=>alive(pid),{timeout:5000}).toBe(false)
  await expect.poll(()=>speechChildren(nextDesktop.pid),{timeout:15000}).not.toHaveLength(0)
  expect(await readFile(join(userData,'preserve-profile'),'utf8')).toBe('keep profile');expect(await readFile(join(data,'preserve-data'),'utf8')).toBe('keep data')
  const conversations=await fetch(base+'/api/conversations',{headers}).then(r=>r.json())
  expect(conversations).toEqual(expect.arrayContaining([expect.objectContaining({id:conversation.id})]))
  const persistedVoice=await fetch(base+'/api/voice/config',{headers}).then(r=>r.json());expect(persistedVoice).toMatchObject({enabled:true,wakeEnabled:false})
  console.log(JSON.stringify({before:{desktop:oldDesktop.pid,backend:oldBackend.pid,frontend:oldFrontend.pid,speech:oldSpeech},after:{desktop:nextDesktop.pid,backend:nextBackend.pid,frontend:nextFrontend.pid,speech:await speechChildren(nextDesktop.pid)},profilePreserved:true,conversationPreserved:true,voiceSettingsPreserved:true,realMicrophone:false}))
 }catch(error){console.error(output);throw error}
 finally{
  const current=await backend().catch(()=>undefined);if(current?.pid)backendPids.add(current.pid)
  await stopDevelopmentDesktop({userData,appPath,executable,log:()=>{}}).catch(()=>{})
  for(const child of launchers)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')
  await stopDevelopmentBackend({data,repo,url,port:backendPort}).catch(()=>{})
  await new Promise(resolve=>setTimeout(resolve,1000))
  for(const pid of backendPids)if(alive(pid))process.kill(pid,'SIGTERM')
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})
 }
},150000)
