import { fileURLToPath } from 'node:url'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {createLocalHost,H5Server} from '../../packages/server/dist/index.js'
const root=fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''),out=root+'/artifacts/rich-ui-2026-10-23'
const base=process.env.PULSE_RICH_UI_URL ?? 'http://127.0.0.1:5173'
await mkdir(out,{recursive:true})
const require=createRequire(root+'/packages/server/package.json'),{_electron}=createRequire(require.resolve('@playwright/mcp'))('playwright')
const temp=await mkdtemp(join(tmpdir(),'pulse-rich-electron-')),data=join(temp,'data')
await mkdir(data)
const host=createLocalHost({cwd:temp,dataDir:data,jarvis:{enabled:false},taskController:false,mockResponse:'isolated UI validation'})
const server=new H5Server(host,{dataDir:data,port:0,host:'127.0.0.1'})
let app
try{
const {port}=await server.start();await writeFile(join(data,'service.json'),JSON.stringify({protocol:1,pid:process.pid,port}))
const env={...process.env,PULSE_DESKTOP_USER_DATA:join(temp,'profile'),PULSE_DESKTOP_DATA_DIR:data,PULSE_DESKTOP_INSTALL_ROOT:join(temp,'install'),PULSE_DESKTOP_SHELL_HOME:join(temp,'shell'),PULSE_DESKTOP_DEV_URL:base+'/tests/rich-ui.html',PULSE_CONFIG:join(temp,'config.json'),PULSE_JARVIS_ENABLED:'false'}
delete env.ELECTRON_RUN_AS_NODE
app=await _electron.launch({args:[root+'/packages/desktop'],executablePath:createRequire(root+'/packages/desktop/package.json')('electron'),env,timeout:30000})
const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('#composer .tiptap').waitFor()
assert.equal(await page.evaluate(()=>!!window.pulseDesktop),true)
await page.locator('#composer .tiptap').click();await page.keyboard.type('**Electron bold**');assert.equal(await page.locator('#composer strong').innerText(),'Electron bold')
await page.keyboard.press('Shift+Enter');await page.keyboard.type('plain');assert.equal(await page.locator('#composer .tiptap p').count(),2)
await page.keyboard.press('Meta+A');await page.getByRole('toolbar',{name:'文本格式'}).waitFor({state:'visible'});await page.screenshot({path:out+'/electron-toolbar.png'})
await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.rich-document').waitFor();assert.equal(await page.locator('.rich-document strong').innerText(),'Electron bold')
await page.reload();await page.locator('.rich-document').waitFor();assert.equal(await page.locator('.rich-document strong').innerText(),'Electron bold')
await page.goto(base+'/tests/rich-ui.html?theme=dark');await page.locator('.katex').first().waitFor();await page.screenshot({path:out+'/electron-dark.png'})
const conversation=await host.createConversation({title:'富文本端到端验收',cwd:temp})
await page.goto(`${base}/work/${conversation.id}`)
const editor=page.locator('#composer .tiptap');await editor.waitFor()
await editor.click();await page.keyboard.type('**End-to-end rich message**')
await page.getByRole('button',{name:'发送',exact:true}).click({timeout:15000})
await page.locator('.message.user .rich-document strong').waitFor({timeout:20000})
for(let i=0;i<60;i++){if((await host.getConversationMessages(conversation.id)).some(message=>message.role==='assistant'))break;await new Promise(r=>setTimeout(r,250))}
const persisted=(await host.getConversationMessages(conversation.id)).find(message=>message.role==='user')
assert.equal(persisted.richContent.document.content[0].content[0].marks[0].type,'bold')
await page.reload();await page.locator('.message.user .rich-document strong').waitFor();assert.equal(await page.locator('.message.user .rich-document strong').innerText(),'End-to-end rich message')
await page.screenshot({path:out+'/electron-real-backend.png'})
const result={actualPulseElectronMain:true,preloadBridgePresent:true,isolatedUserData:true,isolatedBackend:true,syntheticLayoutFixtures:true,realElectronIpcAndBackendRoundtrip:true,mockModel:true,checks:['markdown input','newline','Cmd+A selection toolbar','send rich content','reload rich content','math and dark theme','actual Electron IPC to H5 to SQLite and reload'],errors}
assert.deepEqual(errors,[]);await writeFile(out+'/electron-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await app?.close();await server.stop();await host.close();await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
