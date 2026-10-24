import { expect, it } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function port() {
 const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
 const value = (server.address() as { port: number }).port
 await new Promise<void>(resolve => server.close(() => resolve())); return value
}
it.runIf(process.env.PULSE_LOCAL_DEV_LIVE === '1')('starts the root launcher, reuses services, checks ownership and leaves the backend running', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-oneclick-live-')))
 const [backendPort, webPort, debugPort] = await Promise.all([port(), port(), port()])
 const url = `http://127.0.0.1:${webPort}`
 const env = { ...process.env, PULSE_DEV_DIR: join(root, 'dev'), PULSE_HOME: join(root, 'home'), PULSE_CONFIG: join(root, 'config.json'), PULSE_WEB_DEV_PORT: String(backendPort), PULSE_DESKTOP_DEV_URL: `${url}/settings/desktop`, PULSE_JARVIS_ENABLED: 'false' }
 delete env.ELECTRON_RUN_AS_NODE
 const child = spawn(process.execPath, [join(repo, 'scripts/desktop/start-local.mjs'), '--no-build', '--', `--remote-debugging-port=${debugPort}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
 let output = '', code: number | null | undefined
 child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data }); child.on('exit', value => { code = value })
 let backendPid: number | undefined, browser: any
 const unrelated = httpServer((_req, res) => res.end('unrelated fixture'))
 try {
  await expect.poll(async () => {
   if (code !== undefined) throw new Error(output)
   return fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.ok).catch(() => false)
  }, { timeout: 90000 }).toBe(true)
  const require = createRequire(new URL('../../packages/server/package.json', import.meta.url))
  const { chromium } = createRequire(require.resolve('@playwright/mcp'))('playwright')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  const page = browser.contexts()[0].pages()[0]
  await page.getByText('开发预览使用仓库运行环境，不会注册系统命令或修改终端配置。', { exact: true }).waitFor({ timeout: 20000 })
  const descriptor = JSON.parse(await readFile(join(root, 'dev/h5/data/service.json'), 'utf8')); backendPid = descriptor.pid
  expect(descriptor.port).toBe(backendPort)
  expect(await readFile(join(root, 'dev/logs/backend.log'), 'utf8')).not.toMatch(/pair\?.*code=|配对码/)
  expect(await fetch(`${url}/__pulse_dev`).then(r => r.json())).toMatchObject({ workspace: repo, backend: `http://127.0.0.1:${backendPort}` })
  expect(await fetch(`${url}/@vite/client`).then(r => r.text())).toContain('WebSocket')
  const repeated = await exec(process.execPath, [join(repo, 'scripts/desktop/start-local.mjs'), '--web-only', '--no-build'], { cwd: root, env, timeout: 15000 })
  expect(repeated.stdout).toContain('复用开发后台')
  expect(repeated.stdout).toContain('复用已有前端')
  expect(JSON.parse(await readFile(join(root, 'dev/h5/data/service.json'), 'utf8')).pid).toBe(backendPid)
  await expect(exec(process.execPath, [join(repo, 'scripts/desktop/dev.mjs'), '--web-only'], { env: { ...env, PULSE_H5_TARGET: 'http://127.0.0.1:1' }, timeout: 15000 })).rejects.toThrow()
  expect(await fetch(`${url}/@vite/client`).then(r => r.ok)).toBe(true)
  await new Promise<void>(resolve => unrelated.listen(0, '127.0.0.1', resolve))
  const occupied = (unrelated.address() as { port: number }).port
  await expect(exec(process.execPath, [join(repo, 'scripts/desktop/start-local.mjs'), '--web-only', '--no-build'], { env: { ...env, PULSE_DEV_DIR: join(root, 'other-dev'), PULSE_WEB_DEV_PORT: String(occupied) }, timeout: 15000 })).rejects.toThrow()
  expect(await fetch(`http://127.0.0.1:${occupied}`).then(r => r.text())).toBe('unrelated fixture')
  await expect(exec(process.execPath, [join(repo, 'scripts/desktop/start-local.mjs'), '--no-build'], { env: { ...env, PULSE_WEB_DEV_PORT: '7332' }, timeout: 15000 })).rejects.toThrow()
  await page.screenshot({ path: join(tmpdir(), 'pulse-oneclick-development.png') })
  await page.evaluate(() => window.close())
  await expect.poll(() => code, { timeout: 15000 }).toBe(0)
  process.kill(backendPid!, 0)
  await expect.poll(() => fetch(`${url}/@vite/client`).then(() => true, () => false), { timeout: 10000 }).toBe(false)
  // Start a web-only frontend and stop the launcher with SIGTERM (Ctrl+C lifecycle).
  const web = spawn(process.execPath, [join(repo, 'scripts/desktop/start-local.mjs'), '--web-only', '--no-build'], { cwd: root, env, stdio: 'ignore' })
  try {
   await expect.poll(() => fetch(`${url}/@vite/client`).then(r => r.ok, () => false), { timeout: 15000 }).toBe(true)
   web.kill('SIGTERM')
   await expect.poll(() => fetch(`${url}/@vite/client`).then(() => true, () => false), { timeout: 15000 }).toBe(false)
   await expect.poll(() => web.exitCode, { timeout: 15000 }).toBe(0)
   process.kill(backendPid!, 0)
  } finally { if (web.exitCode === null) web.kill('SIGTERM') }
  console.log(JSON.stringify({ ok: true, electron: true, hotReload: true, reusedBackend: true, reusedVite: true, preservesUnrelatedPort: true, protects7332: true, ownedFrontendStops: true, backgroundSurvives: true }))
 } catch (error) { console.error(output); throw error }
 finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  backendPid ??= await readFile(join(root, 'dev/h5/data/service.json'), 'utf8').then(value => JSON.parse(value).pid).catch(() => undefined)
  if (backendPid) { try { process.kill(backendPid, 'SIGTERM') } catch {} }
  await new Promise<void>(resolve => unrelated.close(() => resolve()))
  await pause(2000); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
 }
}, 150000)
