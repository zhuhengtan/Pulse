import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'
const exec = promisify(execFile)
it.runIf(process.env.PULSE_DIFF_LIVE === '1')('opens chat changes in a numbered split diff in H5 and Electron', async () => {
  const require = createRequire(new URL('../../packages/server/package.json', import.meta.url)), playwright = createRequire(require.resolve('@playwright/mcp'))('playwright')
  const root = await mkdtemp(join(tmpdir(), 'pulse-diff-live-')), project = join(root,'project'), execution = join(root,'execution'), dataDir = join(root,'data')
  for (const cwd of [project, execution]) {
    await mkdir(cwd); await exec('git',['init','--quiet'],{cwd});await exec('git',['config','user.name','Test'],{cwd});await exec('git',['config','user.email','test@localhost'],{cwd})
    await writeFile(join(cwd,'main.ts'), 'const value = 1;\nconsole.log(value);\n');await exec('git',['add','.'],{cwd});await exec('git',['commit','--quiet','-m','baseline'],{cwd})
  }
  const host = createLocalHost({ cwd: project, dataDir, approvalMode: 'auto', mockToolCalls: [{name:'fs.apply_patch',input:{path:'main.ts',find:'const value = 1;',replace:'const value = 2;\nconst label = "updated";'}}], mockAfterToolResponse:'已修改 [main.ts](main.ts)，可以查看差异。' })
  const server = new H5Server(host,{dataDir,host:'127.0.0.1',port:0})
  let browser:any, desktop:any
  const errors:string[]=[]
  try {
    const conversation = await host.createConversation({title:'Code diff acceptance',projectId:null})
    await host.setConversationExecutionWorkspace(conversation.id, execution, project)
    const info=await server.start(),base=`http://127.0.0.1:${info.port}`
    const session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
    const headers={Origin:base,Cookie:session.headers.get('set-cookie')!.split(';')[0]!,'Content-Type':'application/json'}
    const posted=await fetch(`${base}/api/conversations/${conversation.id}/messages`,{method:'POST',headers,body:JSON.stringify({text:'Update main.ts'})})
    expect(posted.status).toBe(200)
    await expect.poll(async()=>readFile(join(execution,'main.ts'),'utf8'),{timeout:10000}).toContain('const value = 2;')
    expect(await readFile(join(project,'main.ts'),'utf8')).toContain('const value = 1;')
    browser=await playwright.chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    page.on('pageerror',(error:Error)=>errors.push(error.message))
    await page.goto(`${base}/work/${conversation.id}`)
    const action=page.getByRole('button',{name:/修改 main.ts/}).first()
    await action.waitFor();expect(await page.locator('.trace-diff-links').count()).toBe(0)
    await action.click()
    await page.getByRole('tab',{name:'main.ts · Diff',exact:true}).waitFor()
    await page.locator('.monaco-diff-editor .view-lines').filter({hasText:'const value = 2;'}).first().waitFor()
    expect(await page.locator('.monaco-diff-editor .line-numbers').allTextContents()).toContain('1')
    await page.getByRole('button',{name:'左右对照',exact:true}).click()
    await page.locator('.diff-side-labels').getByText('修改前',{exact:true}).waitFor()
    expect((await page.locator('.monaco-diff-editor .editor.original .view-lines').innerText()).replace(/\u00a0/g,' ')).toContain('const value = 1;')
    expect((await page.locator('.monaco-diff-editor .editor.modified .view-lines').innerText()).replace(/\u00a0/g,' ')).toContain('const value = 2;')
    await page.screenshot({path:join(tmpdir(),'pulse-diff-desktop-browser.png')})
    await page.reload();await page.locator('.diff-side-labels').getByText('修改前',{exact:true}).waitFor()
    expect(await page.getByRole('tab',{name:'main.ts · Diff',exact:true}).getAttribute('aria-selected')).toBe('true')
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(tmpdir(),'pulse-diff-mobile.png')})
    expect(await page.locator('.workspace-window').evaluate((node:HTMLElement)=>Math.round(node.getBoundingClientRect().width))).toBe(390)
    const env={...process.env,PULSE_DESKTOP_USER_DATA:join(root,'electron'),PULSE_DESKTOP_DATA_DIR:dataDir,PULSE_HOME:join(root,'home')};delete env.ELECTRON_RUN_AS_NODE
    desktop=await playwright._electron.launch({executablePath:createRequire(new URL('../../packages/desktop/package.json',import.meta.url))('electron'),args:[fileURLToPath(new URL('../../packages/desktop',import.meta.url))],env,timeout:20000})
    const native=await desktop.firstWindow();native.on('pageerror',(error:Error)=>errors.push(error.message))
    await native.getByRole('button',{name:'设置',exact:true}).waitFor()
    await native.evaluate((url:string)=>{history.pushState(null,'',url);dispatchEvent(new PopStateEvent('popstate'))},`/work/${conversation.id}`)
    await native.getByRole('button',{name:/修改 main.ts/}).first().click()
    await native.locator('.monaco-diff-editor .view-lines').filter({hasText:'const value = 2;'}).first().waitFor()
    await native.getByRole('button',{name:'左右对照',exact:true}).click()
    await native.locator('.diff-side-labels').getByText('修改后',{exact:true}).waitFor()
    await native.screenshot({path:join(tmpdir(),'pulse-diff-electron.png')})
    expect(errors).toEqual([])
    console.log(JSON.stringify({chatToolLink:true,chatFileLink:true,executionWorkspace:true,splitView:true,lineNumbers:true,restore:true,mobileViewport:true,electron:true,screenshots:['desktop-browser','mobile','electron'].map(name=>join(tmpdir(),`pulse-diff-${name}.png`))}))
  } finally {await desktop?.close();await browser?.close();await server.stop();await host.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
},120_000)
