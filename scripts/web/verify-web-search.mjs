/** Isolated Chromium + real HTTP acceptance. Build server, CLI and Web first. No production config/services. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'pulse-web-search-ui-'))
process.env.PULSE_HOME = temp
process.env.PULSE_BOOTSTRAP_RUNTIME = temp
const out = join(root, 'output/web-search-acceptance-' + Date.now())
const { createLocalHost, H5Server } = await import(join(root, 'packages/server/dist/index.js'))
const { searchWeb } = await import(join(root, 'packages/server/dist/web-search.js'))
const { fetchText, readPublicPage } = await import(join(root, 'packages/server/dist/web.js'))
const { hostOptions, parse } = await import(join(root, 'packages/cli/dist/bin.js'))
const require = createRequire(join(root, 'packages/server/package.json'))
const { chromium } = createRequire(require.resolve('@playwright/mcp'))('playwright')
const checks = [], limits = [], errors = []
let host, server, browser, upstream
try {
  await mkdir(out, { recursive: true })
  await cp(join(root, 'packages/web/dist'), join(temp, 'app/node_modules/@hunterzhu/pulse-server/dist/web'), { recursive: true })
  const dataDir = join(temp, 'data'), configPath = join(temp, 'config.json')
  await writeFile(configPath, JSON.stringify({ cwd: temp, dataDir, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock', allowNetwork: true }))
  let calls = 0
  const row = { title: 'SearXNG Search API', url: 'https://docs.searxng.org/dev/search_api.html', snippet: 'Official search API reference' }
  upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/search'); assert.equal(input.limit, 5)
    // The LAN smoke has no token; UI tests use a synthetic credential only.
    if (input.query !== 'LAN smoke') assert.equal(req.headers.authorization, 'Bearer ui-fixture-only')
    calls++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [row] }))
  })
  upstream.listen(0, '0.0.0.0'); await once(upstream, 'listening')
  const searchURL = `http://127.0.0.1:${upstream.address().port}/search`
  const lan = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address
  if (lan) {
    const url = `http://${lan}:${upstream.address().port}/search`
    assert.equal((await searchWeb('LAN smoke', 5, new AbortController().signal, { provider: 'custom', baseURL: url })).results.length, 1)
    await assert.rejects(readPublicPage(url, new AbortController().signal), /PRIVATE_NETWORK_URL_NOT_ALLOWED/)
    checks.push('real LAN search request; ordinary web.fetch still blocks LAN')
  } else limits.push('No LAN interface available')
  const prepare = path => hostOptions(parse(['--config', path]))
  host = createLocalHost(await prepare(configPath)); await host.init()
  server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0, configuration: { path: configPath, prepare } })
  const base = `http://127.0.0.1:${(await server.start()).port}`
  const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const cookie = session.headers.get('set-cookie').split(';')[0], split = cookie.indexOf('=')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }])
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/settings/builtin-plugins')
  await page.getByRole('combobox', { name: '搜索来源' }).click()
  await page.getByText('自定义 JSON 服务', { exact: true }).click()
  await page.getByLabel('搜索服务地址', { exact: true }).fill(searchURL)
  await page.getByLabel('搜索 Bearer Token', { exact: true }).fill('ui-fixture-only')
  await page.getByLabel('测试关键词', { exact: true }).fill('SearXNG API')
  await page.getByRole('button', { name: '测试搜索', exact: true }).click()
  await page.getByText('搜索成功，返回 1 条结果。', { exact: true }).waitFor()
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).webSearch, undefined)
  checks.push('desktop draft search over real HTTP without saving')
  await page.getByRole('button', { name: '保存全部', exact: true }).click()
  await page.getByText('所有修改已保存', { exact: true }).waitFor()
  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert(saved.webSearch.credentialRef); assert(!JSON.stringify(saved).includes('ui-fixture-only'))
  assert(!await readFile(configPath + '.bak', 'utf8').then(text => text.includes('ui-fixture-only')))
  assert.equal(await page.getByLabel('搜索 Bearer Token', { exact: true }).inputValue(), '')
  await page.reload(); await page.getByLabel('搜索服务地址', { exact: true }).waitFor()
  await page.getByRole('button', { name: '测试搜索', exact: true }).click()
  await page.getByText('搜索成功，返回 1 条结果。', { exact: true }).waitFor()
  checks.push('save, reload, stored credential resolution and search again')
  await page.screenshot({ path: join(out, 'desktop.png'), animations: 'disabled', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '测试搜索', exact: true }).click()
  await page.getByText('搜索成功，返回 1 条结果。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: join(out, 'mobile.png'), animations: 'disabled', fullPage: true })
  checks.push('390px mobile search without horizontal overflow')
  try {
    const source = await fetchText(row.url, new AbortController().signal, ['docs.searxng.org'])
    assert(source.text.length > 0); assert(source.url.startsWith('https://docs.searxng.org/'))
    checks.push('read the returned public source with web.fetch')
  } catch (error) { limits.push(`Public-source fetch: ${error.message}`) }
  if (process.env.PULSE_SEARCH_LIVE_SEARXNG_URL) {
    const live = await searchWeb('SearXNG API', 5, new AbortController().signal, { provider: 'searxng', baseURL: process.env.PULSE_SEARCH_LIVE_SEARXNG_URL })
    assert(live.results.length > 0); checks.push('real SearXNG search returned sources')
  } else limits.push('Real SearXNG not tested: no running service configured; SearXNG protocol covered by loopback fixtures')
  assert(calls >= 4); assert.deepEqual(errors, [])
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, limits, browserErrors: errors }, null, 2))
  console.log(JSON.stringify({ checks, limits, output: out }, null, 2))
} finally {
  await browser?.close(); await server?.stop(); await host?.close()
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
  await rm(temp, { recursive: true, force: true })
}
