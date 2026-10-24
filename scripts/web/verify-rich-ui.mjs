import { fileURLToPath } from 'node:url'
import {createRequire} from 'node:module'
import {writeFile,mkdir} from 'node:fs/promises'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''),out=root+'/artifacts/rich-ui-2026-10-23'
const base=process.env.PULSE_RICH_UI_URL ?? 'http://127.0.0.1:5173'
await mkdir(out,{recursive:true})
const require=createRequire(root+'/packages/server/package.json')
const {chromium}=createRequire(require.resolve('@playwright/mcp'))('playwright')
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']})
const page=await context.newPage(),errors=[],checks=[]
page.on('pageerror',e=>errors.push(e.message))
const edit=()=>page.locator('#composer .tiptap')
const json=()=>edit().evaluate(el=>el.editor.getJSON())
const set=async doc=>{
  await edit().evaluate((el,doc)=>{el.editor.commands.setContent(doc);el.editor.commands.focus('end')},doc)
  // Tiptap applies focus in requestAnimationFrame; wait before real keyboard input.
  await page.waitForFunction(()=>document.activeElement?.matches('#composer .tiptap'))
  await edit().evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
}
const shot=name=>page.screenshot({path:out+'/'+name+'.png',fullPage:true})
try{
await page.goto(base+'/tests/rich-ui.html');await edit().waitFor()
await page.locator('.katex').first().waitFor()
const separator=page.getByRole('separator',{name:'调整会话列表宽度'}),history=page.locator('.desktop-history')
let box=await separator.boundingBox();await page.mouse.move(box.x+4,200);await page.mouse.down();await page.mouse.move(box.x+104,200,{steps:10});await page.mouse.up();assert.equal(Math.round((await history.boundingBox()).width),360)
box=await separator.boundingBox();await page.mouse.move(box.x+4,200);await page.mouse.down();await page.mouse.move(140,200,{steps:12});await page.mouse.up();assert.equal(Math.round((await history.boundingBox()).width),0)
await page.getByRole('button',{name:'展开历史对话',exact:true}).click();await page.waitForTimeout(250);assert.equal(Math.round((await history.boundingBox()).width),360)
await page.reload();await edit().waitFor();assert.equal(Math.round((await history.boundingBox()).width),360);checks.push('sidebar drag / collapse / restore / refresh')
await edit().click();await page.keyboard.type('**bold**');assert.equal(await edit().locator('strong').innerText(),'bold')
await page.keyboard.press('Shift+Enter');await page.keyboard.type('plain');assert.equal((await json()).content[1].content[0].marks,undefined);checks.push('Markdown input rule and explicit newline isolation')
await set('');await edit().click();await page.keyboard.type('1. first');await page.keyboard.press('Shift+Enter');await page.keyboard.type('second');assert.equal((await json()).content[0].content.length,2)
await page.keyboard.press('Shift+Enter');await page.keyboard.press('Shift+Enter');assert.equal((await json()).content.at(-1).type,'paragraph');checks.push('ordered list continuation and exit')
await set('');await page.evaluate(()=>navigator.clipboard.writeText('https://example.com/path'));await edit().click();await page.keyboard.press('Meta+V');await page.keyboard.type('after');assert.equal((await json()).content[0].content[1].marks,undefined);checks.push('real clipboard URL then direct typing')
await set('选择这段文字');await page.keyboard.press('Meta+A');await page.getByRole('toolbar',{name:'文本格式'}).waitFor({state:'visible'});await shot('selection-toolbar');await page.getByRole('button',{name:'粗体',exact:true}).click();assert.equal(await edit().locator('strong').innerText(),'选择这段文字');checks.push('selection toolbar and formatting')
await set('shortcut');await page.keyboard.press('Meta+A');await page.keyboard.press('Meta+i');assert.equal(await edit().locator('em').innerText(),'shortcut');await page.keyboard.press('Meta+k');await page.getByRole('textbox',{name:'链接地址'}).fill('https://example.com');await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal(await edit().locator('a').getAttribute('href'),'https://example.com');checks.push('Cmd+I / Cmd+K')
await set('');await page.keyboard.type('```js');await page.keyboard.press('Space');assert.equal((await json()).content[0].type,'codeBlock');await page.keyboard.type('const a = 1');await page.keyboard.press('Enter');await page.keyboard.type('const b = 2');assert.equal((await json()).content[0].content[0].text,'const a = 1\nconst b = 2');checks.push('code fence shortcut / Enter stays in code')
for (const [syntax, mark] of [['**bold**','bold'],['*italic*','italic'],['~~strike~~','strike'],['`code`','code'],['[site](https://example.com)','link']]) {
  await set('');await page.keyboard.type(syntax)
  assert.equal((await json()).content[0].content[0].marks[0].type,mark,syntax)
}
for (const [syntax,type,level] of [['# ','heading',1],['## ','heading',2],['### ','heading',3],['> ','blockquote'],['- ','bulletList'],['* ','bulletList'],['1. ','orderedList']]) {
  await set('');await page.keyboard.type(syntax)
  const first=(await json()).content[0];assert.equal(first.type,type,syntax);if(level)assert.equal(first.attrs.level,level)
}
checks.push('all requested inline Markdown and block prefix input rules')
for (const [key,mark] of [['Meta+b','bold'],['Meta+i','italic'],['Meta+e','code']]) {
  await set('keyboard');await page.keyboard.press('Meta+A');await page.keyboard.press(key)
  assert.equal((await json()).content[0].content[0].marks[0].type,mark,key)
}
for (const [key,type,level] of [['Meta+Shift+7','orderedList'],['Meta+Shift+8','bulletList'],['Meta+Alt+1','heading',1],['Meta+Alt+2','heading',2],['Meta+Alt+3','heading',3],['Meta+Shift+b','blockquote'],['Meta+Alt+c','codeBlock']]) {
  await set('keyboard');await page.keyboard.press(key)
  const first=(await json()).content[0];assert.equal(first.type,type,key);if(level)assert.equal(first.attrs.level,level)
}
await set('body');await page.keyboard.press('Meta+Alt+2');await page.keyboard.press('Meta+Alt+0');assert.equal((await json()).content[0].type,'paragraph')
await set('undo');await page.keyboard.press('Meta+A');await page.keyboard.press('Meta+b');await page.keyboard.press('Meta+z');assert.equal((await json()).content[0].content[0].marks,undefined);await page.keyboard.press('Meta+Shift+z');assert.equal((await json()).content[0].content[0].marks[0].type,'bold')
await set('');await page.keyboard.type('- first');await page.keyboard.press('Shift+Enter');await page.keyboard.type('nested');await page.keyboard.press('Tab');assert.equal((await json()).content[0].content[0].content[1].type,'bulletList');await page.keyboard.press('Shift+Tab');assert.equal((await json()).content[0].content.length,2)
checks.push('all requested format shortcuts / undo redo / list indent outdent')
await set({type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'这是一条富文本消息'}]},{type:'paragraph',content:[{type:'text',text:'重点内容',marks:[{type:'bold'}]},{type:'text',text:' 和 '},{type:'text',text:'补充说明',marks:[{type:'italic'}]}]},{type:'orderedList',attrs:{start:1},content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'保留列表与引用'}]}]}]},{type:'paragraph',content:[{type:'skillChip',attrs:{id:'review',label:'review'}},{type:'text',text:' '},{type:'fileChip',attrs:{id:'中文目录/设计 文档.md',label:'设计 文档.md'}}]}]})
await page.locator('.messages').evaluate(el=>el.scrollTop=el.scrollHeight);await shot('draft');await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.message.user .rich-document').waitFor();assert.equal(await page.locator('.message.user .rich-document .file-chip').getAttribute('title'),'中文目录/设计 文档.md');await shot('sent');await page.reload();await page.locator('.message.user .rich-document').waitFor();assert.equal(await page.locator('.message.user .rich-document strong').innerText(),'重点内容');checks.push('rich sent message and reload with chips / heading / lists')
await page.goto(base+'/tests/rich-ui.html?theme=dark');await edit().waitFor();await shot('desktop-dark')
await page.setViewportSize({width:390,height:844});await page.reload();await edit().waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await set('手机正文');await page.keyboard.press('Enter');await page.keyboard.type('next');assert.equal((await json()).content.length,2);await shot('mobile-dark');checks.push('mobile Enter / no horizontal overflow / dark theme')
await page.goto(base+'/tests/rich-ui.html?surface=chat');await edit().waitFor();await shot('mobile-chat-light');await page.setViewportSize({width:1440,height:1000});await page.reload();await edit().waitFor();await shot('desktop-chat-light');checks.push('assistant and work surfaces / light and dark / phone-desktop transition')
assert.deepEqual(errors,[])
await writeFile(out+'/browser-results.json',JSON.stringify({checks,errors,realBrowser:true,syntheticTransport:true},null,2))
console.log(JSON.stringify({checks,errors}))
}catch(e){await shot('failure');console.error(e);process.exitCode=1}finally{await browser.close()}
