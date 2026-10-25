/** Real online skill installation in an isolated H5/Chromium or Electron profile. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const temp = await realpath(await mkdtemp(join(tmpdir(), 'pulse-skill-ui-')))
process.env.PULSE_HOME = temp
const req = createRequire(root + '/packages/server/package.json')
const { chromium, _electron } = createRequire(req.resolve('@playwright/mcp'))('playwright')
const { createLocalHost, H5Server, createBuiltinSkillCapabilityPack, createSkillCapabilityPack } = await import(root + '/packages/server/dist/index.js')
const electron = process.argv.includes('--electron'), out = root + '/artifacts/skill-marketplace-20261025/' + (electron ? 'electron' : 'chromium')
const dataDir = join(temp, 'data'), configPath = join(temp, 'config.json')
let host, server, browser, app, page
const errors = [], checks = []
try {
  await mkdir(out, { recursive: true }); await mkdir(dataDir)
  await writeFile(configPath, JSON.stringify({ providers: { mock: { provider: 'mock', name: 'Mock' } }, models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } }, activeModel: 'mock', approvalMode: 'ask', capabilities: { enabled: [], skills: [] } }))
  const packs = [createBuiltinSkillCapabilityPack(), createSkillCapabilityPack()]
  const prepare = async path => { const value = JSON.parse(await readFile(path, 'utf8')); return { cwd: temp, dataDir, skillConfigPath: configPath, taskController: false, jarvis: { enabled: false }, capabilityPacks: packs, enabledCapabilityPacks: ['builtin-skills', ...value.capabilities.enabled], capabilityConfig: { skills: value.capabilities.skills }, mockResponse: 'isolated verification' } }
  host = createLocalHost(await prepare(configPath)); await host.init()
  const conversation = await host.createConversation({ title: 'Skill installation verification', cwd: temp })
  server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0, configuration: { path: configPath, prepare } }); const { port } = await server.start(), base = `http://127.0.0.1:${port}`
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const cookie = local.headers.get('set-cookie').split(';')[0]
  if (electron) {
    await writeFile(join(dataDir, 'service.json'), JSON.stringify({ protocol: 1, port, pid: process.pid }))
    const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(temp, 'profile'), PULSE_DESKTOP_DATA_DIR: dataDir, PULSE_DESKTOP_INSTALL_ROOT: join(temp, 'install'), PULSE_DESKTOP_SHELL_HOME: join(temp, 'shell'), PULSE_DESKTOP_DEV_URL: base, PULSE_CONFIG: configPath, PULSE_JARVIS_ENABLED: 'false' }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ args: [root + '/packages/desktop'], executablePath: createRequire(root + '/packages/desktop/package.json')('electron'), env, timeout: 30000 }); page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 })
  } else {
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const split = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }]); page = await context.newPage()
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/settings/tools')
  await page.getByRole('button', { name: '已安装', exact: true }).click()
  await page.getByText('/skill-creator', { exact: false }).waitFor(); checks.push('offline built-in creator visible')
  await page.screenshot({ path: out + '/01-builtin.png' })
  await page.getByRole('button', { name: '技能市场', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索技能' }).fill('react')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '查看详情', exact: true }).first().waitFor({ timeout: 75000 }); checks.push('real skills.sh search')
  await page.getByRole('textbox', { name: 'GitHub 技能仓库地址' }).fill('vercel-labs/skills@find-skills')
  await page.getByRole('button', { name: '查看仓库', exact: true }).click()
  const install = page.getByRole('button', { name: '安装并启用', exact: true }); await install.waitFor({ timeout: 75000 })
  await page.screenshot({ path: out + '/02-preview.png' })
  await install.click(); await page.getByText('技能已安装并启用，可在输入框键入 / 后选择。', { exact: true }).waitFor({ timeout: 15000 }); checks.push('real GitHub install and config activation')
  const config = JSON.parse(await readFile(configPath, 'utf8')); assert(config.capabilities.enabled.includes('skills')); assert(config.capabilities.skills.includes('find-skills'))
  const receipt = JSON.parse(await readFile(join(temp, 'skills/find-skills/.pulse-install.json'), 'utf8')); assert.match(receipt.origin.commit, /^[a-f0-9]{40}$/)
  await page.goto(base + '/work/' + conversation.id)
  const editor = page.locator('.tiptap[contenteditable="true"]').first(); await editor.waitFor(); await editor.fill('/find')
  await page.getByRole('option').filter({ hasText: 'find-skills' }).first().waitFor({ timeout: 10000 }); checks.push('installed slash suggestion without restart')
  await page.screenshot({ path: out + '/03-slash.png' })
  await page.goto(base + '/settings/tools'); await page.getByRole('button', { name: '已安装', exact: true }).click()
  const row = page.locator('.skill-list article').filter({ hasText: '/find-skills' })
  await row.getByRole('button', { name: '更新', exact: true }).click(); await page.getByText('技能已安装并启用，可在输入框键入 / 后选择。', { exact: true }).waitFor({ timeout: 75000 }); checks.push('real manual update')
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: out + '/04-mobile.png' }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); checks.push('mobile viewport no horizontal overflow')
  assert.deepEqual(errors, [])
  await writeFile(out + '/result.json', JSON.stringify({ success: true, platform: process.platform, mode: electron ? 'electron' : 'chromium', checks, origin: receipt.origin, errors }, null, 2))
  console.log(JSON.stringify({ success: true, out, checks }))
} catch (error) {
  if (page) { await page.screenshot({ path: out + '/failure.png' }).catch(() => {}); await writeFile(out + '/failure.txt', String(error) + '\n' + await page.locator('body').innerText().catch(() => '')) }
  throw error
} finally {
  if (app) await app.close(); if (browser) await browser.close(); if (server) await server.stop(); if (host) await host.close(); await rm(temp, { recursive: true, force: true })
}
