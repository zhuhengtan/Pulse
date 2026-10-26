import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DesktopBackend } from '../../packages/server/src/automation/desktop.js'
import { AutomationSessionManager } from '../../packages/server/src/automation/manager.js'

it.runIf(process.platform === 'darwin' && process.env.PULSE_DESKTOP_DOCTOR_LIVE === '1')('launches the macOS helper with its own application identity and shuts it down',async()=>{
  const backend=new DesktopBackend()
  let pid:number|undefined
  try {
    const report=await backend.call('doctor');pid=report.pid
    expect(report).toMatchObject({bundleIdentifier:'com.hunterzhu.pulse.desktop',permissionApplication:'Pulse',parentPid:1,protocolVersion:1})
  } finally { await backend.close() }
  await expect.poll(()=>{try {process.kill(pid!,0);return true} catch {return false}}).toBe(false)
},30000)

it.runIf(process.platform === 'darwin' && process.env.PULSE_DESKTOP_LIVE === '1')('clicks, types Chinese, drags and saves in a dedicated real desktop window',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-desktop-acceptance-'))
  const bundle=join(root,'Pulse Desktop Acceptance.app'),contents=join(bundle,'Contents')
  const manager=new AutomationSessionManager(root)
  let fixturePid:number|undefined
  let launcher:ReturnType<typeof spawn>|undefined
  try {
    const doctor=new DesktopBackend()
    try { expect(await doctor.call('doctor')).toMatchObject({accessibility:true,screenCapture:true,permissionApplication:'Pulse'}) } finally { await doctor.close() }
    await mkdir(join(contents,'MacOS'),{recursive:true})
    await writeFile(join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.hunterzhu.pulse.desktop.acceptance</string><key>CFBundleName</key><string>Pulse Desktop Acceptance</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    execFileSync('swiftc',['-module-cache-path',join(tmpdir(),'pulse-swift-cache'),resolve('tests/fixtures/desktop-acceptance.swift'),'-o',join(contents,'MacOS/fixture')],{timeout:30000})
    launcher=spawn('/usr/bin/open',['-n','-W','-a',bundle,'--args',root],{stdio:'ignore'})
    let metadata:any
    await expect.poll(async()=>{metadata=await readFile(join(root,'ready.json'),'utf8').then(JSON.parse).catch(()=>undefined);return Boolean(metadata)},{timeout:15000}).toBe(true)
    fixturePid=metadata.pid
    const session=await manager.open('computer','desktop-acceptance',root)
    const windows=await manager.command(session.id,'windows',{},'desktop-acceptance') as Array<{id:string;title:string}>
    const target=windows.find(window=>window.title==='Pulse Desktop Acceptance')
    expect(target).toBeDefined()
    await manager.command(session.id,'selectWindow',{windowId:target!.id},'desktop-acceptance')
    const displays=await manager.command(session.id,'displays',{},'desktop-acceptance') as Array<{id:string;x:number;y:number;width:number;height:number}>
    const firstFrame=await manager.observe(session.id,'desktop-acceptance')
    const display=displays.find(display=>display.id===String(firstFrame.geometry).split(':')[0])!
    expect(display).toBeDefined()
    const area=(firstFrame.captureBounds ?? display) as {x:number;y:number;width:number;height:number}
    const point=(p:{x:number;y:number})=>({x:(p.x-area.x)/(area.width-1),y:(p.y-area.y)/(area.height-1)})
    let sequence=0
    async function act(action:unknown) {
      await manager.command(session.id,'selectWindow',{windowId:target!.id},'desktop-acceptance')
      const frame=await manager.observe(session.id,'desktop-acceptance')
      expect(String(frame.title)).toBe('Pulse Desktop Acceptance')
      expect(frame.pulseImage).toMatchObject({mediaType:'image/jpeg'})
      await manager.act(session.id,String(frame.frameId),action,String(++sequence),'desktop-acceptance')
      await new Promise(resolve=>setTimeout(resolve,150))
    }
    await act({type:'click',point:point(metadata.field),button:'left',count:1})
    await act({type:'key',keys:['Meta','a']})
    await act({type:'type',text:'你好，Pulse 桌面验收'})
    await act({type:'drag',from:point(metadata.dragFrom),to:point(metadata.dragTo)})
    await act({type:'click',point:point(metadata.save),button:'left',count:1})
    await expect.poll(()=>readFile(join(root,'result.txt'),'utf8').catch(()=>''),{timeout:5000}).toBe('你好，Pulse 桌面验收')
    expect(Number(await readFile(join(root,'slider.txt'),'utf8'))).toBeGreaterThan(.8)
  } finally {
    await manager.close()
    if (fixturePid) { try { process.kill(fixturePid,'SIGTERM') } catch {} }
    launcher?.kill()
    await rm(root,{recursive:true,force:true})
  }
},90000)
