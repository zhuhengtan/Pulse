import {createRequire} from 'node:module';import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,''),req=createRequire(root+'/packages/server/package.json'),{chromium,_electron}=createRequire(req.resolve('@playwright/mcp'))('playwright');
const base=process.env.PULSE_RICH_UI_URL ?? 'http://127.0.0.1:5173',electron=process.argv.includes('--electron');
let browser,app,host,server,temp,page;const errors=[];
const out=root+'/artifacts/hierarchy-sidebar-2026-10-23'+(electron?'/electron':'');
await mkdir(out,{recursive:true});
try{
if(electron){
  const {createLocalHost,H5Server}=await import(root+'/packages/server/dist/index.js');
  temp=await mkdtemp(join(tmpdir(),'pulse-hierarchy-'));const data=join(temp,'data');await mkdir(data);
  host=createLocalHost({cwd:temp,dataDir:data,jarvis:{enabled:false},taskController:false,mockResponse:'isolated fixture'});
  server=new H5Server(host,{dataDir:data,port:0,host:'127.0.0.1'});const {port}=await server.start();await writeFile(join(data,'service.json'),JSON.stringify({protocol:1,pid:process.pid,port}));
  const env={...process.env,PULSE_DESKTOP_USER_DATA:join(temp,'profile'),PULSE_DESKTOP_DATA_DIR:data,PULSE_DESKTOP_INSTALL_ROOT:join(temp,'install'),PULSE_DESKTOP_SHELL_HOME:join(temp,'shell'),PULSE_DESKTOP_DEV_URL:base+'/tests/rich-ui.html',PULSE_CONFIG:join(temp,'config.json'),PULSE_JARVIS_ENABLED:'false'};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[root+'/packages/desktop'],executablePath:createRequire(root+'/packages/desktop/package.json')('electron'),env,timeout:30000});page=await app.firstWindow();await page.setViewportSize({width:1440,height:1000});
}else{browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}})}
page.on('pageerror',e=>errors.push(e.message));
const ed=()=>page.locator('#composer .tiptap');const option=name=>page.getByRole('option').filter({has:page.locator('.suggestion-item-name',{hasText:name})});
await page.goto(base+'/tests/rich-ui.html?theme=dark');await ed().waitFor();await ed().click();await page.keyboard.type('@');await page.getByRole('listbox',{name:'项目文件与文件夹'}).waitFor();await option('中文目录').waitFor();
await page.waitForTimeout(250);await page.screenshot({path:out+'/file-root-dark.png'});
await page.bringToFront();await ed().click();
const initial=await page.locator('[role=option][aria-selected=true]').innerText();
await page.keyboard.press('ArrowDown');await page.waitForFunction(text=>document.querySelector('[role=option][aria-selected=true]')?.textContent?.trim()!==text,initial.trim());
await page.keyboard.press('ArrowUp');await page.waitForFunction(text=>document.querySelector('[role=option][aria-selected=true]')?.textContent?.trim()===text,initial.trim());
const targetIndex=(await page.getByRole('option').allTextContents()).findIndex(text=>text.includes('中文目录'));
for(let i=0;i<targetIndex;i++)await page.keyboard.press('ArrowDown');
await page.waitForFunction(()=>document.querySelector('[role=option][aria-selected=true]')?.textContent?.includes('中文目录'));
await page.keyboard.press('ArrowRight');await option('设计 文档.md').waitFor();await page.keyboard.press('ArrowRight');await page.getByText('未找到匹配项',{exact:true}).waitFor();await page.keyboard.press('ArrowLeft');await option('设计 文档.md').waitFor();
await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.querySelector('[role=option][aria-selected=true]')?.textContent?.includes('设计 文档.md'));await page.keyboard.press('Enter');await ed().locator('.file-chip').waitFor();assert.equal(await ed().locator('.file-chip').getAttribute('data-id'),'中文目录/设计 文档.md');
await page.keyboard.type('@中文目录/');await option('空 文件夹').waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/file-children-dark.png'});await page.keyboard.press('Enter');assert.equal(await ed().locator('.file-chip').last().getAttribute('data-id'),'中文目录/空 文件夹/');
await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.message.user .file-chip').first().waitFor();await page.reload();await page.locator('.message.user .file-chip').first().waitFor();assert.equal(await page.locator('.message.user .file-chip').last().getAttribute('title'),'中文目录/空 文件夹/');
await page.getByRole('button',{name:'折叠项目：Pulse'}).click({button:'right'});await page.getByRole('menuitem',{name:/置顶项目|取消置顶/}).waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/project-menu-dark.png'});await page.keyboard.press('Escape');await page.waitForTimeout(250);
const row=page.locator('.history-item').filter({hasText:'富文本与数学排版'});await row.click({button:'right'});await page.getByRole('menuitem',{name:'重命名',exact:true}).waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/conversation-menu-dark.png'});await page.keyboard.press('Escape');await page.waitForTimeout(250);await row.hover();await page.locator('.sidebar-conversation-info').waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/conversation-info-dark.png'});
await page.getByRole('button',{name:'整理侧边栏',exact:true}).click();await page.getByRole('menuitem',{name:/^整理侧边栏/}).click();await page.getByRole('menuitem',{name:'合并显示',exact:true}).click();assert.equal(await page.locator('.project-history').count(),0);assert.equal(await row.count(),1);await page.reload();await ed().waitFor();assert.equal(await page.locator('.project-history').count(),0);
await page.getByRole('button',{name:'整理侧边栏',exact:true}).click();await page.getByRole('menuitem',{name:/^整理侧边栏/}).click();await page.getByRole('menuitem',{name:'分项目显示',exact:true}).click();await page.getByRole('button',{name:'折叠项目：Pulse'}).waitFor();
await page.goto(base+'/tests/rich-ui.html');await ed().waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/sidebar-light.png'});await page.setViewportSize({width:390,height:844});await ed().click();await page.keyboard.type('@');await option('中文目录').waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/files-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
assert.deepEqual(errors,[]);await rm(out+'/failure.png',{force:true});await writeFile(out+'/results.json',JSON.stringify({electron,syntheticTransport:true,checks:['directory arrows','file and folder references','send and reload','context menus','hover details','grouping persistence','desktop/mobile/light/dark'],errors},null,2));console.log('PASS hierarchy keyboard/file+folder send+reload/context menus/hover info/grouping+reload/mobile/light+dark');
}catch(e){if(page && !page.isClosed())await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw e}finally{await app?.close();await browser?.close();await server?.stop();await host?.close();if(temp)await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
