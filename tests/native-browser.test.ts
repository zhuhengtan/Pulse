import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { AutomationSessionManager } from '../packages/server/src/automation/manager.js'
import { NativeBrowserBackend, NativeBrowserHost } from '../packages/server/src/automation/native-browser.js'
import { AutomationBroker, RemoteAutomationClient } from '../packages/server/src/automation/broker.js'
import { createAutomationTools } from '../packages/server/src/automation/tools.js'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
const { WebSocket, WebSocketServer } = createRequire(new URL('../packages/server/package.json', import.meta.url))('ws')
const roots: string[] = [], managers: AutomationSessionManager[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) await rm(root, {recursive:true, force:true}) })
async function setup() { const root = await mkdtemp(join(tmpdir(),'pulse-native-test-')); roots.push(root); const manager = new AutomationSessionManager(root,{},true); managers.push(manager); return {root,manager} }
function nativeHost() {
 const call = vi.fn(async (method:string, _params:any) => method === 'command' ? {revision:'revision',items:[{index:0,active:true,title:'Native',url:'about:blank'}]} : undefined)
 return {host:{call} as unknown as NativeBrowserHost,call}
}
it('requires the internal browser by default even with external configuration or a retained external session', async () => {
 const {root,manager}=await setup()
 manager.configure({browser:{mode:'existing'}},true)
 await expect(manager.open('browser','agent',root)).rejects.toThrow('NATIVE_BROWSER_REQUIRED')
 expect(manager.list()).toHaveLength(0)
 const scope={conversationId:'external-only'}
 const external=await manager.open('browser','agent',root,'dedicated',scope)
 await expect(manager.open('browser','agent',root,undefined,scope)).rejects.toThrow('NATIVE_BROWSER_REQUIRED')
 expect(manager.list()).toMatchObject([{id:external.id,mode:'dedicated'}])
})
it('keeps internal and explicitly requested external sessions separate and reuses only the selected mode', async () => {
 const {root,manager}=await setup(),driver=nativeHost(),scope={conversationId:'both'}
 manager.setNativeHost(driver.host)
 manager.configure({browser:{mode:'existing'}},true)
 const internal=await manager.open('browser','agent',root,undefined,scope)
 expect(internal.mode).toBe('native')
 const external=await manager.open('browser','agent',root,'dedicated',scope)
 expect(external.mode).toBe('dedicated');expect(external.id).not.toBe(internal.id)
 expect((await manager.open('browser','agent',root,undefined,scope)).id).toBe(internal.id)
 expect((await manager.open('browser','agent',root,'dedicated',scope)).id).toBe(external.id)
 const existing=await manager.open('browser','agent',root,'existing',scope)
 expect(existing.mode).toBe('existing')
 expect(driver.call.mock.calls.filter(([method])=>method==='open')).toHaveLength(1)
 await manager.control(external.id,'resume','agent')
 expect(manager.list().find(item=>item.id===external.id)?.mode).toBe('dedicated')
})
it('routes the model tool through the worker broker to the same native conversation session', async () => {
 const {root,manager}=await setup(),driver=nativeHost(),scope={conversationId:'tool-conversation'}
 manager.setNativeHost(driver.host)
 const manual=await manager.open('browser','device:local',root,undefined,scope)
 const broker=new AutomationBroker(manager,root)
 try {
  const client=new RemoteAutomationClient(await broker.start())
  const tool=createAutomationTools(client,root,['browser'],'run',scope.conversationId).find(tool=>tool.manifest.name==='automation.open')!
  const ctx={agentId:'agent',signal:new AbortController().signal} as ToolContext
  expect(await tool.execute({kind:'browser'},ctx)).toMatchObject({id:manual.id,mode:'native',owner:'run:agent'})
  expect(await tool.execute({kind:'browser',mode:'dedicated'},ctx)).toMatchObject({mode:'dedicated'})
  expect(await tool.execute({kind:'browser',mode:'native'},ctx)).toMatchObject({id:manual.id,mode:'native'})
 } finally { await broker.close() }
})
it('restores both modes without converting an external session or reusing it as the default', async () => {
 const {root,manager}=await setup(),scope={conversationId:'restored'}
 manager.setNativeHost(nativeHost().host)
 const internal=await manager.open('browser','agent',root,undefined,scope)
 const external=await manager.open('browser','agent',root,'dedicated',scope)
 await manager.suspend()
 const restored=new AutomationSessionManager(root,{},true);managers.push(restored)
 restored.setNativeHost(nativeHost().host)
 expect(await restored.open('browser','next',root,undefined,scope)).toMatchObject({id:internal.id,mode:'native'})
 expect(await restored.open('browser','next',root,'dedicated',scope)).toMatchObject({id:external.id,mode:'dedicated'})
})
it('keeps native browser identity after a host disconnect and reconnects without a headless fallback',async()=>{
 const {root,manager}=await setup(),first=nativeHost(),detach=manager.setNativeHost(first.host)
 const browser=await manager.open('browser','run:agent',root,undefined,{conversationId:'conversation'})
 expect(browser.mode).toBe('native'); expect(first.call).toHaveBeenCalledWith('open',expect.objectContaining({id:browser.id,allowNetwork:true}),undefined)
 detach(); await vi.waitFor(()=>expect(manager.list()[0]).toMatchObject({state:'paused',reconnectRequired:true}))
 await expect(manager.observe(browser.id,'run:agent')).rejects.toThrow('RECONNECT_REQUIRED')
 await expect(manager.control(browser.id,'resume','local')).rejects.toThrow('NATIVE_BROWSER_DISCONNECTED')
 const second=nativeHost();manager.setNativeHost(second.host)
 await manager.control(browser.id,'resume','local')
 expect(second.call).toHaveBeenCalledWith('open',expect.objectContaining({id:browser.id}),undefined)
 expect(manager.list()[0]).toMatchObject({id:browser.id,mode:'native',state:'ai'})
 expect(manager.list()[0]?.reconnectRequired).toBeUndefined()
})
it('preserves an explicitly selected external browser when Electron takes control',async()=>{
 const {root,manager}=await setup(),old=await manager.open('browser','device:local',root,'dedicated')
 expect(old.mode).toBe('dedicated')
 const driver=nativeHost();manager.setNativeHost(driver.host)
 const control=await manager.control(old.id,'takeover','local')
 expect(control).toMatchObject({id:old.id,mode:'dedicated',state:'human'})
 expect(driver.call).not.toHaveBeenCalled()
})
it('restores persisted native sessions without creating another browser when Electron is absent',async()=>{
 const {root,manager}=await setup(),driver=nativeHost();manager.setNativeHost(driver.host)
 const browser=await manager.open('browser','device:local',root)
 await manager.suspend()
 const restored=new AutomationSessionManager(root,{},true);managers.push(restored);await restored.init()
 expect(restored.list()[0]).toMatchObject({id:browser.id,mode:'native',state:'paused',reconnectRequired:true})
 await expect(restored.control(browser.id,'takeover','local')).rejects.toThrow('NATIVE_BROWSER_DISCONNECTED')
 await restored.control(browser.id,'close','local')
 expect(restored.list()[0]?.state).toBe('closed')
})
it('enforces network and upload boundaries before sending a native host operation',async()=>{
 const {root}=await setup(),driver=nativeHost(),backend=new NativeBrowserBackend(()=>driver.host,'id',root,join(root,'profile'),{allowNetwork:true,networkHosts:['example.com']})
 for(const url of ['file:///etc/passwd','https://other.test','https://user:secret@example.com']) await expect(backend.call('navigate',{url})).rejects.toThrow('NETWORK_NOT_ALLOWED')
 await expect(backend.call('upload',{files:['../outside']})).rejects.toThrow()
 expect(driver.call).not.toHaveBeenCalled()
 await backend.close()
 await expect(backend.call('tabs',{})).rejects.toThrow('SESSION_NOT_FOUND')
})
it('cancels pending native RPC and rejects outstanding requests when the host disconnects',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0})
 await new Promise<void>(resolve=>server.once('listening',resolve))
 const accepted=new Promise<any>(resolve=>server.once('connection',resolve))
 const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}`)
 await new Promise<void>(resolve=>socket.once('open',resolve))
 const peer=await accepted,host=new NativeBrowserHost(peer),frames:any[]=[]
 socket.on('message',(raw:any)=>frames.push(JSON.parse(raw.toString())))
 try {
  const abort=new AbortController(),pending=host.call('observe',{id:'one'},abort.signal)
  const rejection=expect(pending).rejects.toThrow('AUTOMATION_CANCELLED')
  await vi.waitFor(()=>expect(frames).toHaveLength(1));abort.abort();await rejection
  await vi.waitFor(()=>expect(frames[1]).toMatchObject({method:'cancel',params:{requestId:frames[0].id}}))
  const disconnected=host.call('command',{id:'one'}),lost=expect(disconnected).rejects.toThrow('NATIVE_BROWSER_DISCONNECTED')
  socket.close();await lost
 } finally { socket.terminate();peer.terminate();await new Promise<void>(resolve=>server.close(resolve)) }
})
