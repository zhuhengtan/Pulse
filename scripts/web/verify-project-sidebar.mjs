/** Isolated real H5 + SQLite UI acceptance; no provider calls or user-project writes. */
import { createServer, request as proxyRequest } from 'node:http'
import { createReadStream } from 'node:fs'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const req = createRequire(root + '/packages/server/package.json'), { chromium, _electron } = createRequire(req.resolve('@playwright/mcp'))('playwright')
const { createLocalHost, H5Server } = await import(root + '/packages/server/dist/index.js')
const { H5ProjectCatalog } = await import(root + '/packages/server/dist/h5/projects.js')
const electron = process.argv.includes('--electron'), out = root + '/artifacts/project-hover-2026-10-23' + (electron ? '/electron' : '')
const temp = await realpath(await mkdtemp(join(tmpdir(), 'pulse-project-ui-'))), dataDir = join(temp, 'data')
let host, server, frontend, browser, app, page
const errors = []
try {
  await mkdir(out, { recursive: true }); await mkdir(dataDir)
  const folders = ['main', 'second', 'source', 'added'].map(name => join(temp, name)); await Promise.all(folders.map(path => mkdir(path)))
  const catalog = new H5ProjectCatalog(dataDir)
  const longName = '一个名字很长的项目用于验证隐藏操作按钮时完整利用侧栏空间'
  const first = await catalog.add(longName, folders[0]), second = await catalog.add('Second project', folders[1])
  await catalog.update(first.id, { folders: [folders[0], folders[2]] }); await catalog.reorder([first.id, second.id])
  host = createLocalHost({ cwd: folders[0], dataDir, jarvis: { enabled: false }, taskController: false, mockResponse: 'isolated verification' })
  await host.init()
  const longTitle = '这是一条很长的会话标题，用于确认悬浮时以舒适的速度完整播放一次，并且移开鼠标后恢复原位'
  const conversation = await host.createConversation({ title: longTitle, cwd: folders[0], projectId: first.id })
  server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 }); const { port } = await server.start(), base = `http://127.0.0.1:${port}`
  // Serve the current web build without replacing the resident service's bundled assets.
  const webRoot = root + '/packages/web/dist'
  let uiBase
  frontend = createServer((req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/preview/')) {
      if (req.headers.origin && req.headers.origin !== uiBase) { res.writeHead(403).end(); return }
      const forwarded = { ...req.headers, host: new URL(base).host, ...(req.headers.origin ? { origin: base } : {}) }
      const upstream = proxyRequest(base + req.url, { method: req.method, headers: forwarded }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res) })
      upstream.on('error', () => res.writeHead(502).end()); req.pipe(upstream); return
    }
    const path = req.url.split('?')[0].startsWith('/assets/') ? resolve(webRoot, '.' + req.url.split('?')[0]) : webRoot + '/index.html'
    if (!path.startsWith(webRoot + '/')) { res.writeHead(403).end(); return }
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream')
    const stream = createReadStream(path); stream.on('error', () => res.writeHead(404).end()); stream.pipe(res)
  })
  await new Promise(done => frontend.listen(0, '127.0.0.1', done)); uiBase = `http://127.0.0.1:${frontend.address().port}`
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const headers = { Origin: base, Cookie: local.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert(res.ok, `${path}: ${res.status}`); return res.json()
  }
  if (electron) {
    await writeFile(join(dataDir, 'service.json'), JSON.stringify({ protocol: 1, port, pid: process.pid }))
    const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(temp, 'profile'), PULSE_DESKTOP_DATA_DIR: dataDir, PULSE_DESKTOP_INSTALL_ROOT: join(temp, 'install'), PULSE_DESKTOP_SHELL_HOME: join(temp, 'shell'), PULSE_DESKTOP_DEV_URL: uiBase, PULSE_CONFIG: join(temp, 'config.json'), PULSE_JARVIS_ENABLED: 'false' }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ args: [root + '/packages/desktop'], executablePath: createRequire(root + '/packages/desktop/package.json')('electron'), env, timeout: 30000 }); page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 })
  } else { browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }) }
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(uiBase + '/work/' + conversation.id)
  const row = id => page.locator(`[data-project-id="${id}"]`)
  const shot = async name => { await page.waitForTimeout(250); await page.screenshot({ path: out + '/' + name + '.png' }) }
  await row(first.id).waitFor()
  await page.mouse.move(1300, 100)
  assert.equal(await row(first.id).locator('.project-row-actions').evaluate(el => el.getBoundingClientRect().width), 0)
  const fullWidth = await row(first.id).locator('.project-name').evaluate(el => el.getBoundingClientRect().width)
  await row(first.id).hover()
  assert((await row(first.id).locator('.project-name').evaluate(el => el.getBoundingClientRect().width)) < fullWidth - 40)
  assert.equal(await row(first.id).locator('[data-icon="folder-open"]').count(), 1)
  await page.getByRole('button', { name: '折叠项目：' + longName }).click()
  assert.equal(await row(first.id).locator('[data-icon="folder"]').count(), 1)
  await page.getByRole('button', { name: '展开项目：' + longName }).click()
  await row(second.id).dragTo(row(first.id), { targetPosition: { x: 15, y: 5 } })
  await page.waitForFunction(id => document.querySelector('[data-project-id]')?.getAttribute('data-project-id') === id, second.id)
  await page.waitForTimeout(200); assert.deepEqual((await api('/api/projects')).map(item => item.id), [second.id, first.id])
  await page.reload(); await row(first.id).waitFor(); assert.equal(await page.locator('[data-project-id]').first().getAttribute('data-project-id'), second.id)
  await row(first.id).hover()
  const info = page.getByRole('region', { name: '项目信息：' + longName })
  await info.waitFor(); assert.match(await info.innerText(), /1 次聊天/)
  assert.equal(await info.locator('.project-info-folder').count(), 2)
  await info.getByRole('button', { name: '置顶项目', exact: true }).click()
  await page.waitForTimeout(200); assert.equal((await api('/api/projects')).find(item => item.id === first.id).pinned, true)
  await page.reload(); await row(first.id).hover(); await info.waitFor()
  assert.equal(await info.getByRole('button', { name: '取消置顶项目' }).getAttribute('aria-pressed'), 'true')
  await shot('project-info-light')
  await info.getByRole('button', { name: '取消置顶项目' }).click()
  await page.waitForTimeout(200); assert.equal((await api('/api/projects')).find(item => item.id === first.id).pinned, false)
  await info.getByRole('button', { name: '编辑项目', exact: true }).click()
  const infoEditor = page.getByRole('dialog', { name: '编辑项目' }); await infoEditor.waitFor(); await infoEditor.getByRole('button', { name: '取消', exact: true }).click()
  await api('/api/projects/order', 'POST', { ids: [second.id, first.id] }); await page.reload(); await row(first.id).waitFor()
  const title = page.getByRole('button', { name: longTitle, exact: true }).locator('.history-title')
  await page.mouse.move(1300, 100)
  const idle = await title.locator('.history-title-text').evaluate(el => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth }))
  assert.equal(idle.overflow, 'ellipsis'); assert.equal(idle.clipped, true); await shot('resting-title-ellipsis')
  await title.hover(); await page.waitForTimeout(1200)
  const marquee = await title.locator('.history-title-text').evaluate(el => { const animation = el.getAnimations()[0]; return { distance: el.scrollWidth - el.parentElement.clientWidth, overflow: getComputedStyle(el).textOverflow, transform: getComputedStyle(el).transform, count: el.getAnimations().length, ...(animation ? { target: animation.effect.getKeyframes().at(-1).transform, duration: animation.effect.getTiming().duration, iterations: animation.effect.getTiming().iterations } : {}) } })
  assert.equal(marquee.count, 1); assert.equal(marquee.iterations, 1); assert.equal(marquee.overflow, 'clip'); assert(Math.abs(marquee.duration - Math.max(1250, Math.abs(parseFloat(marquee.target.match(/translateX\((-?[\d.]+)px\)/)[1])) / 48 * 1000)) < 1, JSON.stringify(marquee)); assert.notEqual(marquee.transform, 'none'); await shot('hover-title-no-ellipsis')
  await page.mouse.move(1300, 100); assert.equal(await title.locator('.history-title-text').evaluate(el => el.getAnimations().length), 0); assert.equal(await title.locator('.history-title-text').evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis')
  await page.getByRole('button', { name: longTitle, exact: true }).dblclick()
  const rename = page.getByRole('dialog', { name: '重命名对话' }); await rename.waitFor(); await rename.getByRole('textbox', { name: '对话标题' }).fill('已在弹窗中重命名'); await rename.getByRole('button', { name: '保存', exact: true }).click(); await rename.waitFor({ state: 'hidden' })
  assert.equal((await api('/api/conversations')).find(item => item.id === conversation.id).title, '已在弹窗中重命名')
  await row(first.id).hover(); await page.getByRole('button', { name: '项目操作：' + longName }).click(); await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑项目' }); await edit.waitFor()
  await shot('edit-project-light')
  await edit.getByRole('textbox', { name: '项目名称' }).fill('Edited project')
  await edit.getByRole('button', { name: '设为主文件夹：' + folders[2] }).click()
  await edit.getByRole('button', { name: '移除文件夹：' + folders[0] }).click()
  await edit.getByRole('button', { name: '添加文件夹' }).click()
  const picker = page.getByRole('dialog', { name: '选择电脑文件夹' }); await picker.waitFor(); await picker.locator('.host-path-entries[aria-busy="false"]').waitFor()
  await picker.getByRole('textbox', { name: '电脑绝对路径' }).fill(folders[3]); await picker.getByRole('button', { name: '前往', exact: true }).click(); await page.waitForFunction(path => document.querySelector('.host-path-selection')?.textContent?.includes(path), folders[3]); await picker.getByRole('button', { name: '选择此文件夹' }).click(); await picker.waitFor({ state: 'hidden' })
  await edit.getByRole('button', { name: '保存', exact: true }).click(); await edit.waitFor({ state: 'hidden' })
  const edited = (await api('/api/projects')).find(item => item.id === first.id)
  assert.equal(edited.cwd, folders[2]); assert.deepEqual(edited.folders, [folders[2], folders[3]])
  assert.equal((await api('/api/conversations')).find(item => item.id === conversation.id).cwd, folders[0])
  assert.equal((await api('/api/conversations', 'POST', { projectId: first.id, title: 'New primary' })).cwd, folders[2])
  await page.reload(); await page.getByRole('button', { name: '折叠项目：Edited project' }).waitFor()
  await page.evaluate(() => { localStorage.setItem('pulse-web-theme', 'dark'); document.documentElement.dataset.theme = 'dark' })
  await row(first.id).hover(); await page.getByRole('region', { name: '项目信息：Edited project' }).waitFor(); await shot('project-info-dark')
  await page.getByRole('button', { name: '项目操作：Edited project' }).click(); await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click(); await edit.waitFor(); await shot('edit-project-dark'); await edit.getByRole('button', { name: '取消', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '历史对话', exact: true }).click(); await page.getByRole('dialog').waitFor(); await shot('mobile-sidebar')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  if (!electron) {
    const cdp = await page.context().newCDPSession(page)
    const source = await row(first.id).locator('.project-drag-grip').boundingBox(), target = await row(second.id).boundingBox()
    const x = source.x + source.width / 2, start = source.y + source.height / 2, end = target.y + 6
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] })
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * i / 8 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForFunction(id => document.querySelector('.pulse-history-drawer [data-project-id]')?.getAttribute('data-project-id') === id, first.id)
    await page.waitForTimeout(200); assert.equal((await api('/api/projects'))[0].id, first.id); await cdp.detach()
  }
  assert.deepEqual(errors, [])
  await writeFile(out + '/results.json', JSON.stringify({ electron, realBackend: true, mockModel: true, touchEmulation: !electron, checks: ['drag order and refresh', 'folder open/closed icons', 'hover width release', 'marquee 48px/s once and reset', 'idle ellipsis / hover clip', 'project info / pin and unpin persistence / edit', 'double click rename', 'source-folder edit and primary persistence', 'existing/new conversation cwd', 'light/dark/mobile'], errors }, null, 2)); await rm(out + '/failure.png', { force: true }); console.log('PASS project sidebar refinements, real backend, ' + (electron ? 'Electron' : 'Chromium'))
} catch (failure) { if (page && !page.isClosed()) await page.screenshot({ path: out + '/failure.png' }).catch(() => {}); throw failure }
finally { await app?.close(); await browser?.close(); if(frontend)await new Promise(done => frontend.close(done)); await server?.stop(); await host?.close(); await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
