import { afterEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { developmentControl } from '../packages/desktop/src/development-control.mjs'
import { legacyDesktopIdentity, stopDevelopmentDesktop, waitForFreshDevelopmentDesktop } from '../scripts/desktop/restart-desktop.mjs'

const roots:string[]=[],children:ChildProcess[]=[],servers:Array<()=>void>=[]
afterEach(async()=>{servers.splice(0).forEach(close=>close());await Promise.all(children.splice(0).map(async child=>{if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await once(child,'exit')}}));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function profile(){const root=await realpath(await mkdtemp(join(tmpdir(),'pulse-desktop-restart-')));roots.push(root);const userData=join(root,'profile'),appPath=join(root,'app');await mkdir(appPath);return{root,userData,appPath,executable:process.execPath}}
async function childProfile(stall=false){const p=await profile();const module=new URL('../packages/desktop/src/development-control.mjs',import.meta.url).href
 const child=spawn(process.execPath,['--input-type=module','-e',`import{developmentControl}from${JSON.stringify(module)};await developmentControl({userData:process.argv[1],appPath:process.argv[2],quit:()=>{${stall?'':'process.exit(0)'}}});setInterval(()=>{},1000);process.send('ready');`,p.userData,p.appPath],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);await once(child,'message');return{...p,child}}
it('exposes authenticated identity and graceful shell-only quit with a private descriptor',async()=>{
 const p=await profile(),quit=vi.fn();servers.push(await developmentControl({...p,quit}));const record=JSON.parse(await readFile(join(p.userData,'development-desktop.json'),'utf8')),base=`http://127.0.0.1:${record.port}`
 expect((await fetch(base+'/quit',{method:'POST'})).status).toBe(403);expect(quit).not.toHaveBeenCalled()
 const headers={Authorization:`Bearer ${record.token}`}
 expect(await fetch(base+'/identity',{headers}).then(r=>r.json())).toMatchObject({pid:process.pid,appPath:p.appPath,userData:p.userData})
 if(process.platform!=='win32')expect((await stat(join(p.userData,'development-desktop.json'))).mode&0o777).toBe(0o600)
 expect((await fetch(base+'/quit',{method:'POST',headers})).status).toBe(200);await vi.waitFor(()=>expect(quit).toHaveBeenCalledOnce())
})
it('quits only the verified profile and waits for its real process to exit',async()=>{
 const p=await childProfile(),other=await childProfile(),log=vi.fn()
 await stopDevelopmentDesktop({...p,log})
 expect(p.child.exitCode).toBe(0);expect(other.child.exitCode).toBeNull();expect(log.mock.calls.join('\n')).toContain('将启动当前源码')
})
it('rejects changed PID, workspace and profile identities without quitting a process',async()=>{
 const p=await childProfile(),file=join(p.userData,'development-desktop.json'),record=JSON.parse(await readFile(file,'utf8'))
 await writeFile(file,JSON.stringify({...record,pid:process.pid}));await expect(stopDevelopmentDesktop({...p,log:()=>{}})).rejects.toThrow('身份核验失败');expect(p.child.exitCode).toBeNull()
 for(const change of [{appPath:p.root},{userData:p.root}]){await writeFile(file,JSON.stringify({...record,...change}));await expect(stopDevelopmentDesktop({...p,log:()=>{}})).rejects.toThrow('身份或配置目录不匹配');expect(p.child.exitCode).toBeNull()}
})
it('does not force-kill a desktop that fails to finish quitting',async()=>{
 const p=await childProfile(true);await expect(stopDevelopmentDesktop({...p,timeoutMs:50,log:()=>{}})).rejects.toThrow('未强杀');expect(p.child.exitCode).toBeNull()
})
it('requires exact launcher arguments and open profile files to identify an older desktop',async()=>{
 if(process.platform==='win32')return
 const p=await profile();await mkdir(p.userData);await symlink(`test-host-${process.pid}`,join(p.userData,'SingletonLock'))
 const inspect=vi.fn(async()=>({command:`${p.executable} ${p.appPath}`,files:[join(p.userData,'Cache/data')]}))
 expect(await legacyDesktopIdentity({...p,platform:'darwin',inspect})).toBe(process.pid)
 inspect.mockResolvedValueOnce({command:`${p.executable} /other/desktop`,files:[join(p.userData,'Cache/data')]});await expect(legacyDesktopIdentity({...p,platform:'darwin',inspect})).rejects.toThrow('归属无法核验')
 inspect.mockResolvedValueOnce({command:`${p.executable} ${p.appPath}`,files:[join(p.root,'another-profile/Cache')]});await expect(legacyDesktopIdentity({...p,platform:'darwin',inspect})).rejects.toThrow('归属无法核验')
})
it('starts directly when there is no existing desktop',async()=>{const p=await profile(),log=vi.fn();await stopDevelopmentDesktop({...p,log});expect(log.mock.calls.join('\n')).toContain('开发桌面未运行')})
it('requires the newly launched desktop identity and rejects a successful old-instance handoff',async()=>{
 const p=await childProfile();await expect(waitForFreshDevelopmentDesktop({child:p.child,userData:p.userData})).resolves.toBeUndefined()
 await expect(waitForFreshDevelopmentDesktop({child:{pid:123,exitCode:0,signalCode:null},userData:p.userData})).rejects.toThrow('旧托盘实例接管')
 await expect(waitForFreshDevelopmentDesktop({child:{pid:123,exitCode:null,signalCode:null},userData:p.userData,timeoutMs:1})).rejects.toThrow('身份尚未就绪')
})
