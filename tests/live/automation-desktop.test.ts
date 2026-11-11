import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DesktopBackend } from '../../packages/server/src/automation/desktop.js'
import { AutomationSessionManager } from '../../packages/server/src/automation/manager.js'

it.runIf(process.platform === 'darwin' && process.env.PULSE_DESKTOP_DOCTOR_LIVE === '1')('checks the bundled agent-desktop permissions',async()=>{
 const backend=new DesktopBackend();try { expect(await backend.call('doctor')).toMatchObject({backend:'agent-desktop',platform:'macos'}) } finally { await backend.close() }
},30000)

it.runIf(process.platform === 'darwin' && process.env.PULSE_DESKTOP_LIVE === '1')('clicks, types Chinese, drags and saves in a dedicated real desktop window',async()=>{
  await mkdir(resolve('artifacts'), { recursive: true })
  const root=await mkdtemp(join(resolve('artifacts'),'pulse-desktop-acceptance-'))
  const bundle=join(root,'Fixture.app'),contents=join(bundle,'Contents')
  const manager=new AutomationSessionManager(root)
  let fixturePid:number|undefined
  let launcher:ReturnType<typeof spawn>|undefined
  try {
    const doctor=new DesktopBackend()
    try { expect(await doctor.call('doctor')).toMatchObject({accessibility:true,screenCapture:true,backend:'agent-desktop'}) } finally { await doctor.close() }
    await mkdir(join(contents,'MacOS'),{recursive:true})
    await writeFile(join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.pulse.test.fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    execFileSync('swiftc',['-module-cache-path',join(tmpdir(),'pulse-swift-cache'),resolve('tests/fixtures/desktop-acceptance.swift'),'-o',join(contents,'MacOS/fixture')],{timeout:30000})
    execFileSync('codesign',['--force','--sign','-',bundle],{timeout:30000})
    launcher=spawn('/usr/bin/open',['-n','-W','-a',bundle,'--args',root],{stdio:'ignore'})
    let metadata:any
    await expect.poll(async()=>{metadata=await readFile(join(root,'ready.json'),'utf8').then(JSON.parse).catch(()=>undefined);return Boolean(metadata)},{timeout:15000}).toBe(true)
    fixturePid=metadata.pid
    const session=await manager.open('computer','desktop-acceptance',root)
    let target: {id:string;title:string;accessible?:boolean}|undefined
    await expect.poll(async()=>{const windows=await manager.command(session.id,'windows',{},'desktop-acceptance') as Array<{id:string;title:string;accessible?:boolean}>;target=windows.find(window=>window.title==='Pulse Desktop Acceptance' && (window as any).pid === fixturePid);return Boolean(target)},{timeout:15000}).toBe(true)
    expect(target).toBeDefined()
    await manager.command(session.id,'selectWindow',{windowId:target!.id},'desktop-acceptance')
    const firstFrame=await manager.observe(session.id,'desktop-acceptance',undefined,false,target!.id)
    expect(firstFrame.pulseImage).toBeUndefined()
    const tree=JSON.parse(String(firstFrame.text)).tree
    const nodes:any[]=[];const collect=(node:any)=>{nodes.push(node);for(const child of node.children??[])collect(child)};collect(tree)
    const field=nodes.find(node=>node.ref_id && node.role==='textfield')
    expect(field).toBeDefined()
    await manager.act(session.id,String(firstFrame.frameId),{type:'element',ref:field.ref_id,operation:'fill',value:'语义输入验证'},'semantic-fill','desktop-acceptance')
    const area=firstFrame.captureBounds as {x:number;y:number;width:number;height:number}
    const point=(p:{x:number;y:number})=>({x:(p.x-area.x)/(area.width-1),y:(p.y-area.y)/(area.height-1)})
    let sequence=0
    async function act(action:unknown) {
      let frame:any
      await expect.poll(async()=>{try{frame=await manager.observe(session.id,'desktop-acceptance');return true}catch(error){if((error as Error).message==='AUTOMATION_GEOMETRY_CHANGED')return false;throw error}},{timeout:5000}).toBe(true)
      expect(String(frame.title)).toBe('Pulse Desktop Acceptance')
      expect(frame.pulseImage).toMatchObject({mediaType:'image/png'})
      await manager.act(session.id,String(frame.frameId),action,String(++sequence),'desktop-acceptance')
      await new Promise(resolve=>setTimeout(resolve,150))
      const after=await manager.observe(session.id,'desktop-acceptance',undefined,false)
      await writeFile(join(root,`action-${sequence}.json`),String(after.text))
      console.log('Fixture action',sequence,'observed')
    }
    await act({type:'click',point:point(metadata.field),button:'left',count:1})
    await act({type:'key',keys:['Meta','a']})
    await act({type:'type',text:'你好，Pulse 桌面验收'})
    await act({type:'drag',from:point(metadata.dragFrom),to:point(metadata.dragTo)})
    await act({type:'click',point:point(metadata.save),button:'left',count:1})
    await expect.poll(()=>readFile(join(root,'result.txt'),'utf8').catch(()=>''),{timeout:5000}).toBe('你好，Pulse 桌面验收')
    expect(Number(await readFile(join(root,'slider.txt'),'utf8'))).toBeGreaterThan(.8)
  } catch (error) { console.error('Desktop fixture error', JSON.stringify(error)); throw error } finally {
    await manager.close()
    if (fixturePid) { try { process.kill(fixturePid,'SIGTERM') } catch {} }
    launcher?.kill()
    if(process.env.PULSE_DESKTOP_KEEP_FIXTURE !== '1')await rm(root,{recursive:true,force:true})
  }
},90000)
