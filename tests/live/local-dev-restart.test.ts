import { expect, it } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inspectFrontendPort } from '../../scripts/desktop/restart-frontend.mjs'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
async function port() {
 const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
 const value = (server.address() as { port: number }).port
 await new Promise<void>(resolve => server.close(() => resolve())); return value
}
it.runIf(process.env.PULSE_LOCAL_DEV_LIVE === '1')('restarts the verified dev backend and Vite, retaining ports and conversations', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-restart-live-')))
 const backendPort = await port(), webPort = await port(), url = `http://127.0.0.1:${webPort}`, base = `http://127.0.0.1:${backendPort}`
 const data = join(root, 'dev/h5/data'), descriptorPath = join(data, 'service.json')
 const env = { ...process.env, PULSE_DEV_DIR: join(root, 'dev'), PULSE_HOME: join(root, 'home'), PULSE_CONFIG: join(root, 'config.json'), PULSE_WEB_DEV_PORT: String(backendPort), PULSE_DESKTOP_DEV_URL: url + '/work/new', PULSE_JARVIS_ENABLED: 'false' }
 const launcher = spawn('bash', [join(repo, 'start-dev.sh'), '--web-only', '--no-build'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
 let output = ''
 let restartedLauncher: ReturnType<typeof spawn> | undefined
 launcher.stdout.on('data', value => { output += value }); launcher.stderr.on('data', value => { output += value })
 const descriptor = async () => JSON.parse(await readFile(descriptorPath, 'utf8'))
 const restart = (extra = {}) => exec('bash', [join(repo, 'restart-dev.sh'), '--web-only', '--no-build'], { cwd: root, env: { ...env, ...extra }, timeout: 60000 })
 const backendPids = new Set<number>()
 try {
  await expect.poll(async () => {
   if (launcher.exitCode !== null) throw new Error(output)
   return fetch(url + '/__pulse_dev').then(r => r.ok, () => false)
  }, { timeout: 60000 }).toBe(true)
  const before = await descriptor(); backendPids.add(before.pid)
  const beforeFrontend = await inspectFrontendPort(webPort)
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const cookie = local.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }
  const conversation = await fetch(base + '/api/conversations', { method: 'POST', headers, body: JSON.stringify({ title: '重启后保留的会话', projectId: null }) }).then(r => r.json()) as { id: string }
  expect(conversation.id).toBeTruthy()
  await writeFile(join(data, 'restart-preservation.txt'), 'keep data')
  // A misleading descriptor must never be sufficient to signal an unrelated PID.
  await writeFile(descriptorPath, JSON.stringify({ ...before, pid: launcher.pid }))
  await expect(restart()).rejects.toThrow('身份核验失败')
  expect(launcher.exitCode).toBeNull(); process.kill(before.pid, 0)
  await writeFile(descriptorPath, JSON.stringify({ ...before, port: 7332 }))
  await expect(restart()).rejects.toThrow('身份或数据目录不匹配')
  process.kill(before.pid, 0)
  await writeFile(descriptorPath, JSON.stringify(before))
  await expect(restart({ PULSE_WEB_DEV_PORT: '7332' })).rejects.toThrow('7332')
  let restartOutput = ''
  restartedLauncher = spawn('bash', [join(repo, 'restart-dev.sh'), '--web-only', '--no-build'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  restartedLauncher.stdout?.on('data', value => { restartOutput += value }); restartedLauncher.stderr?.on('data', value => { restartOutput += value })
  await expect.poll(() => {
   if (restartedLauncher!.exitCode !== null) throw new Error(restartOutput)
   return restartOutput.includes('网页开发预览：')
  }, { timeout: 60000 }).toBe(true)
  expect(restartOutput).toContain('开发后台已正常退出')
  expect(restartOutput).toContain('开发前端已正常退出')
  expect((await inspectFrontendPort(webPort)).pid).not.toBe(beforeFrontend.pid)
  const after = await descriptor(); backendPids.add(after.pid)
  expect(after.pid).not.toBe(before.pid); expect(after.port).toBe(before.port)
  expect(() => process.kill(before.pid, 0)).toThrow()
  expect(await readFile(join(data, 'restart-preservation.txt'), 'utf8')).toBe('keep data')
  const conversations = await fetch(base + '/api/conversations', { headers }).then(r => r.json()) as Array<{ id: string; title: string }>
  expect(conversations).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversation.id, title: '重启后保留的会话' })]))
  expect(await fetch(url + '/__pulse_dev').then(r => r.json())).toMatchObject({ backend: base, workspace: repo })
  await expect.poll(() => launcher.exitCode).toBe(0)
  console.log(JSON.stringify({ restarted: true, samePort: true, conversationPreserved: true, restartedFrontend: true, rejectsWrongPid: true, protects7332: true }))
 } finally {
  const current = await descriptor().catch(() => undefined)
  if (current?.pid && current.pid !== launcher.pid) backendPids.add(current.pid)
  if (launcher.exitCode === null) launcher.kill('SIGTERM')
  if (restartedLauncher?.exitCode === null) restartedLauncher.kill('SIGTERM')
  for (const pid of backendPids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  await new Promise(resolve => setTimeout(resolve, 2000))
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
 }
}, 150000)
