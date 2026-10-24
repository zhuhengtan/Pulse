import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AutomationSessionManager } from '../../packages/server/src/automation/manager.js'

it.runIf(process.env.PULSE_BROWSER_LIVE === '1')('operates a real isolated browser, writes Chinese text and verifies the download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-browser-live-'))
  let saved = ''
  const server = createServer(async (request, response) => {
    if (request.url === '/save') { for await (const chunk of request) saved += chunk.toString(); response.end('saved'); return }
    if (request.url === '/download') { response.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8', 'Content-Disposition':'attachment; filename="result.txt"' });response.end('下载验收');return }
    response.setHeader('Content-Type','text/html; charset=utf-8')
    response.end(`<title>Pulse Live Test</title><label>Name<input aria-label="Name"></label><button onclick="fetch('/save',{method:'POST',body:document.querySelector('input').value}).then(()=>document.querySelector('output').textContent='saved')">Save</button><a href="/download" download>Download</a><output></output>`)
  })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const manager = new AutomationSessionManager(root, { browser: { channel: process.env.PULSE_BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome' } }, true)
  try {
    const session = await manager.open('browser','live-test',root,'dedicated')
    await manager.command(session.id,'navigate',{url:`http://127.0.0.1:${(server.address() as {port:number}).port}`},'live-test')
    if(process.platform==='darwin'&&process.env.PULSE_BROWSER_CHANNEL==='chromium'){const processes=execFileSync('ps',['-axo','command'],{encoding:'utf8'});expect(processes.split('\n').some(line=>line.includes(root)&&line.includes('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))).toBe(true)}
    const ref = (text: unknown, expression: RegExp) => { const value=String(text).match(expression)?.[1];if(!value)throw new Error('Fixture element not found');return value }
    let frame = await manager.observe(session.id,'live-test')
    expect(frame.frameWidth).toBe(1280)
    await manager.act(session.id,String(frame.frameId),{type:'element',operation:'fill',ref:ref(frame.text,/textbox "Name" \[ref=(\w+)\]/),value:'你好，Pulse'},'fill','live-test')
    frame = await manager.observe(session.id,'live-test')
    await manager.act(session.id,String(frame.frameId),{type:'element',operation:'click',ref:ref(frame.text,/button "Save" \[ref=(\w+)\]/)},'save','live-test')
    await expect.poll(()=>saved).toBe('你好，Pulse')
    frame = await manager.observe(session.id,'live-test')
    await manager.act(session.id,String(frame.frameId),{type:'element',operation:'click',ref:ref(frame.text,/link "Download" \[ref=(\w+)\]/)},'download','live-test')
    await expect.poll(async()=>{const files=await manager.command(session.id,'downloads',{},'live-test') as Array<{name:string;path:string}>;const file=files.find(file=>file.name==='result.txt');return file?readFile(file.path,'utf8'):''}).toBe('下载验收')
  } finally { await manager.close(); await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true}) }
},90000)

it.runIf(process.env.PULSE_BROWSER_LIVE === '1')('uploads only workspace files, selects options, switches tabs and retains the dedicated login session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-browser-extended-')),workspace=join(root,'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace,'upload.txt'),'工作区上传验收')
  await writeFile(join(root,'outside.txt'),'must not upload')
  await symlink(join(root,'outside.txt'),join(workspace,'escape.txt'))
  let uploaded='',choice=''
  const server=createServer(async(req,res)=>{
    if(req.url==='/upload'||req.url==='/choice'){let body='';for await(const chunk of req)body+=chunk.toString();if(req.url==='/upload')uploaded=body;else choice=body;res.end('ok');return}
    if(req.url==='/login')res.setHeader('Set-Cookie','pulse_fixture=logged-in; HttpOnly; Path=/; Max-Age=3600')
    res.setHeader('content-type','text/html; charset=utf-8')
    if(req.url==='/second'){res.end('<title>Second Fixture</title>Second tab');return}
    res.end(`<title>Extended Browser Fixture</title><p>${req.url==='/login'||req.headers.cookie?.includes('pulse_fixture=logged-in')?'Session retained':'Anonymous'}</p><input type="file" aria-label="Upload" onchange="this.files[0].text().then(text=>fetch('/upload',{method:'POST',body:text}))"><select aria-label="Choice" onchange="fetch('/choice',{method:'POST',body:this.value})"><option value="a">A</option><option value="b">B</option></select><a href="/second" target="_blank">Second</a>`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const manager=new AutomationSessionManager(root,{browser:{channel:process.env.PULSE_BROWSER_CHANNEL==='chromium'?'chromium':'chrome'}},true,undefined,['127.0.0.1'])
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  try {
    const session=await manager.open('browser','extended',workspace,'dedicated')
    await manager.command(session.id,'navigate',{url:base+'/login'},'extended')
    await expect(manager.command(session.id,'upload',{files:['escape.txt']},'extended')).rejects.toThrow('UPLOAD_OUTSIDE_WORKSPACE')
    const ref=(frame:Record<string,unknown>,pattern:RegExp)=>{const found=String(frame.text).match(pattern)?.[1];if(!found)throw new Error('Fixture element missing');return found}
    let frame=await manager.observe(session.id,'extended')
    await manager.act(session.id,String(frame.frameId),{type:'element',operation:'click',ref:ref(frame,/(?:button|textbox) "Upload" \[ref=(\w+)\]/)},'chooser','extended')
    await manager.command(session.id,'upload',{files:['upload.txt']},'extended')
    await expect.poll(()=>uploaded).toBe('工作区上传验收')
    frame=await manager.observe(session.id,'extended')
    await manager.act(session.id,String(frame.frameId),{type:'element',operation:'select',ref:ref(frame,/combobox "Choice" \[ref=(\w+)\]/),value:'b'},'select','extended')
    await expect.poll(()=>choice).toBe('b')
    frame=await manager.observe(session.id,'extended')
    await manager.act(session.id,String(frame.frameId),{type:'element',operation:'click',ref:ref(frame,/link "Second" \[ref=(\w+)\]/)},'tab','extended')
    const tabs=await manager.command(session.id,'tabs',{},'extended')
    expect(JSON.stringify(tabs)).toContain('Second Fixture')
    await manager.command(session.id,'selectTab',{index:0},'extended')
    expect((await manager.observe(session.id,'extended')).title).toBe('Extended Browser Fixture')
    await manager.control(session.id,'close','local')
    const restored=await manager.open('browser','restored',workspace,'dedicated')
    await manager.command(restored.id,'navigate',{url:base+'/account'},'restored')
    expect(String((await manager.observe(restored.id,'restored')).text)).toContain('Session retained')
  } finally {await manager.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
},90000)
