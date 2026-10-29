/** Isolated real HTTP and Chromium acceptance; no production configuration or paid service calls. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'pulse-builtin-ui-'))
process.env.PULSE_HOME = temp
process.env.PULSE_BOOTSTRAP_RUNTIME = temp
const out = join(root, 'output/builtin-plugin-acceptance-' + Date.now())
const { createLocalHost, H5Server } = await import(join(root, 'packages/server/dist/index.js'))
const { startGeneration } = await import(join(root, 'packages/server/dist/builtin-plugins/adapters.js'))
const { readPublicPage } = await import(join(root, 'packages/server/dist/web.js'))
const { hostOptions, parse } = await import(join(root, 'packages/cli/dist/bin.js'))
const require = createRequire(join(root, 'packages/server/package.json'))
const { chromium } = createRequire(require.resolve('@playwright/mcp'))('playwright')
const checks = [], errors = [], calls = []
let host, server, browser, upstream, cookie, base, page
try {
  await mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  // Produce valid native browser media for playback, rather than a magic-header fixture.
  const media = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f46c65'; ctx.fillRect(0, 0, 160, 90)
    const stream = canvas.captureStream(10), chunks = []
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
    const done = new Promise(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = resolve })
    recorder.start(); const paint = setInterval(() => { ctx.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); ctx.fillRect(0, 0, 160, 90) }, 50); await new Promise(resolve => setTimeout(resolve, 1200)); clearInterval(paint); recorder.stop(); await done
    stream.getTracks().forEach(track => track.stop())
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
    return { png: canvas.toDataURL('image/png').split(',')[1], video: btoa(String.fromCharCode(...bytes)) }
  })
  const wav = Buffer.alloc(44 + 4800)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40)
  let slowDone = false, deletes = 0
  upstream = createServer(async (req, res) => {
    if (req.method === 'DELETE') { deletes++; res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(slowDone ? { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: media.png }] } : { status: 'running', id: 'slow' })); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString()); calls.push(input.kind)
    const output = input.kind === 'video' ? { mediaType: 'video/webm', dataBase64: media.video } : input.kind === 'image' ? { mediaType: 'image/png', dataBase64: media.png } : { mediaType: 'audio/wav', dataBase64: wav.toString('base64') }
    if (input.prompt === 'cleared') assert.equal(req.headers.authorization, undefined)
    else if (input.prompt !== 'LAN smoke') assert.equal(req.headers.authorization, 'Bearer ui-media-synthetic')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(input.prompt === 'slow' ? { status: 'queued', id: 'slow' } : { status: 'succeeded', outputs: [output] }))
  })
  upstream.listen(0, '0.0.0.0'); await once(upstream, 'listening')
  const service = 'http://127.0.0.1:' + upstream.address().port
  const lan = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address
  if (lan) {
    const baseURL = 'http://' + lan + ':' + upstream.address().port
    assert((await startGeneration({ adapter: 'custom', source: 'standalone', model: 'test', baseURL }, 'image', { prompt: 'LAN smoke' }, [], new AbortController().signal)).asset)
    await assert.rejects(readPublicPage(baseURL, new AbortController().signal), /PRIVATE_NETWORK_URL_NOT_ALLOWED/)
    checks.push('LAN generation HTTP succeeds while ordinary web.fetch denies private targets')
  }
  await cp(join(root, 'packages/web/dist'), join(temp, 'app/node_modules/@hunterzhu/pulse-server/dist/web'), { recursive: true })
  const configPath = join(temp, 'config.json'), dataDir = join(temp, 'data')
  await writeFile(configPath, JSON.stringify({ cwd: temp, dataDir, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock', allowNetwork: true }))
  const prepare = path => hostOptions(parse(['--config', path]))
  host = createLocalHost(await prepare(configPath)); await host.init()
  server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0, configuration: { path: configPath, prepare } })
  base = 'http://127.0.0.1:' + (await server.start()).port
  const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  cookie = session.headers.get('set-cookie').split(';')[0]; const split = cookie.indexOf('=')
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }])
  const api = async (path, method = 'GET', input) => {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
    assert(response.ok, await response.clone().text()); return response.json()
  }
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(base + '/settings/builtin-plugins')
  for (const title of ['网页搜索', '图片生成', '视频生成', '音频生成']) await page.getByRole('heading', { name: title, exact: true }).waitFor()
  assert.equal(await page.getByLabel('启用图片生成').getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByLabel('启用视频生成').getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByLabel('启用音频生成').getAttribute('aria-checked'), 'false')
  const connection = async kind => {
    await page.getByRole('combobox', { name: kind + '协议', exact: true }).click()
    await page.getByText('自定义 JSON 服务（本地或远程）', { exact: true }).last().click()
    await page.getByLabel(kind + '服务地址', { exact: true }).fill(service)
    await page.getByLabel(kind + '模型代码', { exact: true }).fill('fixture')
    await page.getByLabel(kind + '访问令牌', { exact: true }).fill('ui-media-synthetic')
  }
  await page.getByLabel('启用图片生成').click(); await connection('图片')
  await page.getByLabel('启用视频生成').click(); await connection('视频')
  await page.getByLabel('启用音频生成').click()
  for (const kind of ['语音', '音乐', '音效']) { await page.getByLabel('配置' + kind, { exact: true }).check(); await connection(kind) }
  await page.getByRole('button', { name: '保存全部', exact: true }).click()
  await page.getByText('所有修改已保存', { exact: true }).waitFor()
  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert(saved.builtinPlugins.image_gen.connection.credentialRef)
  assert(!JSON.stringify(saved).includes('ui-media-synthetic'))
  assert(!(await readFile(configPath + '.bak', 'utf8')).includes('ui-media-synthetic'))
  await page.reload(); await page.getByLabel('图片服务地址', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('图片访问令牌', { exact: true }).inputValue(), '')
  checks.push('four plugin cards; five independent generation connections; save/reload with separate masked credentials')
  for (const kind of ['图片', '视频', '语音', '音乐', '音效']) {
    const section = page.locator('section.config-entity').filter({ has: page.getByRole('heading', { name: kind + '试生成', exact: true }) })
    await section.getByRole('button', { name: '试生成' + kind, exact: true }).click()
    await section.getByText(/生成成功/).waitFor()
    if (kind === '图片') assert(await section.locator('img').evaluate(el => el.complete && el.naturalWidth > 0))
    else {
      const tag = kind === '视频' ? 'video' : 'audio'
      await section.locator(tag).evaluate(async el => { if (el.readyState < 1) await new Promise((resolve, reject) => { el.onloadedmetadata = resolve; el.onerror = reject }); el.loop = true; await el.play(); el.pause() })
    }
    assert(await section.getByRole('link', { name: '下载结果' }).getAttribute('href'))
  }
  checks.push('real HTTP image, video, speech, music and sound outputs; native browser preview/playback and download')
  const startSlow = () => api('/api/config/builtin-plugins/image/test', 'POST', { prompt: 'slow' })
  const awaitRunning = async () => {
    for (let n = 0; n < 100; n++) { const { jobs } = await api('/api/builtin-plugins/jobs'); if (jobs.some(j => j.state === 'running')) return; await page.waitForTimeout(50) }
    throw new Error('slow job did not start')
  }
  const slow = startSlow(); await awaitRunning()
  await page.getByLabel('启用图片生成').click()
  await page.getByRole('button', { name: '保存全部', exact: true }).click()
  await page.getByRole('button', { name: '取消关闭', exact: true }).click()
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).builtinPlugins.image_gen.enabled, true)
  await page.getByRole('button', { name: '保存全部', exact: true }).click()
  await page.getByRole('button', { name: '不停止，等待已有请求完成', exact: true }).click()
  await page.getByText('所有修改已保存', { exact: true }).waitFor()
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).builtinPlugins.image_gen.enabled, false)
  slowDone = true; await slow
  checks.push('cancel-disable preserves saved state; finish choice denies new calls and lets the original request save its artifact')
  await page.getByLabel('启用图片生成').click()
  await page.getByRole('button', { name: '保存全部', exact: true }).click(); await page.getByText('所有修改已保存', { exact: true }).waitFor()
  slowDone = false
  const stopped = startSlow().catch(e => e); await awaitRunning()
  await page.getByLabel('启用图片生成').click(); await page.getByRole('button', { name: '保存全部', exact: true }).click()
  await page.getByRole('button', { name: '停止并尽力取消', exact: true }).click()
  await page.getByText('所有修改已保存', { exact: true }).waitFor(); await stopped
  assert.equal(deletes, 1)
  checks.push('stop choice aborts in-flight local wait and sends the custom DELETE cancellation')
  await page.getByLabel('配置音乐', { exact: true }).click()
  await page.getByLabel('音乐服务地址', { exact: true }).waitFor({ state: 'detached' })
  assert.equal(await page.getByLabel('语音服务地址', { exact: true }).inputValue(), service)
  assert.equal(await page.getByLabel('启用视频生成', { exact: true }).getAttribute('aria-checked'), 'true')
  await page.getByLabel('启用图片生成', { exact: true }).click()
  await page.getByRole('button', { name: '清除图片凭据', exact: true }).click()
  await page.getByRole('button', { name: '清除图片凭据', exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '保存全部', exact: true }).click()
  await page.getByText('所有修改已保存', { exact: true }).waitFor()
  const clearedFile = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(clearedFile.builtinPlugins.audio_gen.modes.music, undefined)
  assert.equal(clearedFile.builtinPlugins.image_gen.connection.credentialRef, undefined)
  assert.equal(clearedFile.builtinPlugins.video_gen.enabled, true)
  await page.reload()
  await page.getByLabel('语音服务地址', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('配置音乐', { exact: true }).isChecked(), false)
  assert.equal(await page.getByLabel('音乐服务地址', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('图片服务地址', { exact: true }).inputValue(), service)
  assert.equal(await page.getByRole('button', { name: '清除图片凭据', exact: true }).count(), 0)
  assert.equal(await page.getByLabel('启用视频生成', { exact: true }).getAttribute('aria-checked'), 'true')
  const clearedSection = page.locator('section.config-entity').filter({ has: page.getByRole('heading', { name: '图片试生成', exact: true }) })
  await clearedSection.getByLabel('图片测试提示词', { exact: true }).fill('cleared')
  await clearedSection.getByRole('button', { name: '试生成图片', exact: true }).click()
  await clearedSection.getByText(/生成成功/).waitFor()
  const denied = await fetch(base + '/api/config/builtin-plugins/music/test', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'cleared' }) })
  assert.equal(denied.ok, false)
  assert((await denied.text()).includes('PLUGIN_MODE_NOT_CONFIGURED'))
  checks.push('unchecking music stays off after save and reload; a cleared credential sends no authorization')
  await page.screenshot({ path: join(out, 'desktop.png'), animations: 'disabled', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(out, 'mobile.png'), animations: 'disabled', fullPage: true })
  checks.push('390px settings page without horizontal overflow')
  assert.deepEqual(errors, [])
  const limits = ['No paid native cloud generation was invoked; protocol contract tests do not establish live provider availability.', 'No real ComfyUI/model installation or real SearXNG instance was available.']
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, limits, browserErrors: errors, calls }, null, 2))
  console.log(JSON.stringify({ checks, limits, output: out }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ url: page?.url(), errors, text: await page?.locator('body').innerText().catch(() => '') }))
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser?.close(); await server?.stop(); await host?.close()
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
  await rm(temp, { recursive: true, force: true })
}
