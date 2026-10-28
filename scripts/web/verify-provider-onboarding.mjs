/** Isolated real HTTP + Chromium/Electron acceptance. No production data or provider keys. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const temp = await realpath(await mkdtemp(join(tmpdir(), 'pulse-provider-ui-')))
process.env.PULSE_HOME = temp
const require = createRequire(root + '/packages/server/package.json')
const { chromium, _electron } = createRequire(require.resolve('@playwright/mcp'))('playwright')
const { createLocalHost, H5Server } = await import(root + '/packages/server/dist/index.js')
const { hostOptions, parse } = await import(root + '/packages/cli/dist/bin.js')
const electron = process.argv.includes('--electron')
const out = join(root, 'artifacts/provider-onboarding-20261028', electron ? 'electron' : 'chromium')
const dataDir = join(temp, 'data'), configPath = join(temp, 'config.json')
let server, host, browser, app, upstream
const checks = [], errors = []
let providerCalls = 0
try {
  await mkdir(out, { recursive: true })
  await writeFile(configPath, JSON.stringify({ cwd: temp, dataDir, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', capabilities: { enabled: [] }, providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock' }))
  upstream = createServer(async (req, res) => {
    if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'local-model' }, { name: 'embeddinggemma:latest' }, { name: 'local-cloud-alias', remote_host: 'https://ollama.com' }] })); return }
    if (req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [...Array.from({ length: 41 }, (_, index) => ({ id: `model-${index}`, name: `测试对话模型 ${index}`, supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } })), { id: 'embedding-one' }, { id: 'reranker-one' }] })); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); providerCalls++
    const hasToolResult = body.messages.some(item => item.role === 'tool')
    if (body.tools?.length && !hasToolResult) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: 'private probe reasoning', tool_calls: [{ id: 'native-probe', type: 'function', function: { name: 'pulse_echo', arguments: '{"value":"PULSE_OK"}' } }] }, finish_reason: 'tool_calls' }] })); return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ delta: { content: hasToolResult ? '{"ok":true}' : 'PULSE_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const providerURL = `http://127.0.0.1:${upstream.address().port}`
  const prepare = path => hostOptions(parse(['--config', path]))
  host = createLocalHost(await prepare(configPath)); await host.init()
  server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0, configuration: { path: configPath, prepare } })
  const { port } = await server.start(), base = `http://127.0.0.1:${port}`
  const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const cookie = session.headers.get('set-cookie').split(';')[0]
  let page
  if (electron) {
    await writeFile(join(dataDir, 'service.json'), JSON.stringify({ protocol: 1, port, pid: process.pid }))
    const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(temp, 'profile'), PULSE_DESKTOP_DATA_DIR: dataDir, PULSE_DESKTOP_INSTALL_ROOT: join(temp, 'install'), PULSE_DESKTOP_SHELL_HOME: join(temp, 'shell'), PULSE_DESKTOP_DEV_URL: base, PULSE_CONFIG: configPath, PULSE_JARVIS_ENABLED: 'false' }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ args: [root + '/packages/desktop'], executablePath: createRequire(root + '/packages/desktop/package.json')('electron'), env, timeout: 30000 })
    page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 })
  } else {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const split = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }]); page = await context.newPage()
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/settings/models')
  await page.getByRole('button', { name: '＋ 添加服务商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).waitFor()
  for (const name of ['Ollama', 'MiniMax', '智谱', 'OpenAI', 'Anthropic', 'Gemini', '通义千问 / 百炼', '火山方舟', 'Moonshot / Kimi', 'SiliconFlow / 硅基流动', 'OpenRouter']) await dialog.getByRole('button', { name, exact: true }).waitFor()
  checks.push('all twelve vendor presets')
  await page.screenshot({ animations: 'disabled', path: join(out, '01-presets.png') })
  await dialog.getByRole('button', { name: '自定义 OpenAI 兼容接口', exact: true }).click()
  await dialog.getByLabel('接入名称', { exact: true }).fill('隔离验收账号')
  await dialog.getByLabel('API Key', { exact: true }).fill('isolated-fixture-secret')
  await dialog.getByLabel('服务地址', { exact: true }).fill(providerURL)
  await dialog.getByRole('button', { name: '获取全部对话模型', exact: true }).click()
  await dialog.getByText('将导入 41 个对话模型', { exact: true }).waitFor()
  assert.equal(await dialog.locator('.provider-model-list li').count(), 15)
  await dialog.getByRole('button', { name: '下一页', exact: true }).click()
  await dialog.getByText('测试对话模型 15', { exact: true }).first().waitFor()
  await dialog.getByLabel('搜索接入模型').fill('model-40')
  assert.equal(await dialog.locator('.provider-model-list li').count(), 1)
  checks.push('real directory discovery, filtering, pagination, import all 41')
  await dialog.getByLabel('搜索接入模型').fill('')
  await dialog.getByRole('button', { name: '验证所选模型', exact: true }).click()
  await dialog.getByRole('button', { name: '完成接入', exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await dialog.locator('.provider-probe [data-status="passed"]').count(), 3)
  assert.equal(providerCalls, 3)
  checks.push('streaming chat, tool round trip and structured JSON in three calls')
  // Mask credential controls in saved evidence without changing the verified form.
  await page.screenshot({ animations: 'disabled', path: join(out, '02-verified.png'), mask: [dialog.getByLabel('API Key', { exact: true })] })
  await dialog.getByRole('button', { name: '完成接入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText('隔离验收账号', { exact: true }).waitFor()
  const saved = JSON.parse(await readFile(configPath, 'utf8')), account = Object.values(saved.providers).find(item => item.name === '隔离验收账号')
  assert.equal(Object.keys(account.models).length, 41); assert(account.credentialRef); assert(!JSON.stringify(saved).includes('isolated-fixture-secret'))
  assert.equal(saved.activeModel.split('/')[1], 'model-0')
  const cli = await prepare(configPath); assert.equal(cli.provider.apiKey, 'isolated-fixture-secret')
  assert(!await page.evaluate(() => JSON.stringify(localStorage)).then(text => text.includes('isolated-fixture-secret')))
  checks.push('separate Key persistence, live default application and CLI credential resolution')
  await page.getByRole('button', { name: '更新 Key / 刷新模型', exact: true }).click()
  await dialog.getByLabel('API Key', { exact: true }).waitFor(); assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), '')
  await dialog.getByRole('button', { name: '获取全部对话模型', exact: true }).click()
  await dialog.getByText('将导入 41 个对话模型', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  checks.push('refresh using saved credential and cancel without changes')
  await page.screenshot({ animations: 'disabled', path: join(out, '03-connected.png') })
  await page.getByRole('button', { name: '＋ 添加服务商', exact: true }).click()
  await dialog.getByRole('button', { name: 'Ollama', exact: true }).click()
  assert.equal(await dialog.getByRole('button', { name: '获取全部对话模型', exact: true }).isEnabled(), true)
  await dialog.getByRole('combobox', { name: '站点与套餐' }).click()
  await page.getByText('Ollama Cloud · 官方云端', { exact: true }).click()
  assert.equal(await dialog.getByLabel('服务地址', { exact: true }).inputValue(), 'https://ollama.com/v1')
  assert.equal(await dialog.getByRole('button', { name: '获取全部对话模型', exact: true }).isEnabled(), false)
  await dialog.getByLabel('API Key', { exact: true }).fill('cloud-fixture-only')
  assert.equal(await dialog.getByRole('button', { name: '获取全部对话模型', exact: true }).isEnabled(), true)
  await dialog.getByRole('combobox', { name: '站点与套餐' }).click()
  await page.getByText('本机 Ollama · 无需 Key', { exact: true }).click()
  await dialog.getByLabel('接入名称', { exact: true }).fill('隔离 Ollama 验收账号')
  await dialog.getByLabel('服务地址', { exact: true }).fill(providerURL)
  await dialog.getByRole('button', { name: '获取全部对话模型', exact: true }).click()
  await dialog.getByText('将导入 2 个对话模型', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '验证所选模型', exact: true }).click()
  await dialog.getByRole('button', { name: '完成接入', exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await dialog.locator('.provider-probe [data-status="passed"]').count(), 3)
  await dialog.getByRole('button', { name: '完成接入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const afterOllama = JSON.parse(await readFile(configPath, 'utf8'))
  const ollamaAccount = Object.values(afterOllama.providers).find(item => item.name === '隔离 Ollama 验收账号')
  assert.equal(ollamaAccount.provider, 'ollama'); assert.equal(ollamaAccount.credentialRef, undefined)
  assert.equal(Object.values(ollamaAccount.models).find(item => item.modelCode === 'local-cloud-alias').remote, true)
  assert.equal(Object.keys(JSON.parse(await readFile(join(temp, 'provider-credentials.json'), 'utf8'))).length, 1)
  assert.equal(afterOllama.activeModel, saved.activeModel)
  checks.push('local Ollama without Key, cloud Key requirement, native tags, privacy metadata, no credential creation')
  await page.screenshot({ animations: 'disabled', path: join(out, '04-ollama.png') })
  if (!electron) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '＋ 添加服务商', exact: true }).click(); await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).scrollIntoViewIfNeeded()
    await page.waitForFunction(() => { const element = document.querySelector('.provider-wizard'); if (!element) return false; const rect = element.getBoundingClientRect(); return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && getComputedStyle(element).opacity === '1' })
    assert(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth))
    await page.screenshot({ animations: 'disabled', path: join(out, '04-narrow-layout.png') }); checks.push('narrow layout')
  }
  assert.deepEqual(errors, [])
  await writeFile(join(out, 'result.json'), JSON.stringify({ success: true, mode: electron ? 'electron' : 'chromium', checks, providerCalls, errors }, null, 2))
  console.log(JSON.stringify({ success: true, mode: electron ? 'electron' : 'chromium', checks, artifacts: out }))
} finally {
  await app?.close(); await browser?.close(); await server?.stop(); await host?.close()
  if (upstream) await new Promise(resolve => upstream.close(resolve))
  await rm(temp, { recursive: true, force: true })
}
