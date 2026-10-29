import { expect, it } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile), repo = fileURLToPath(new URL('../../', import.meta.url))
async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
it.runIf(process.env.PULSE_LOCAL_DEV_LIVE === '1')('automatically connects the root launcher to the saved backend, reuses its chosen Vite and preserves data on restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-auto-endpoints-')))
  const data = join(root, 'dev/h5/data'), descriptorPath = join(data, 'service.json'), backendPort = await freePort()
  const base = `http://127.0.0.1:${backendPort}`
  const env: NodeJS.ProcessEnv = { ...process.env, PULSE_DEV_DIR: join(root, 'dev'), PULSE_HOME: join(root, 'home'), PULSE_CONFIG: join(root, 'config.json'), PULSE_JARVIS_ENABLED: 'false' }
  delete env.PULSE_DESKTOP_DEV_URL
  // Simulate a saved backend whose actual port differs from the requested default.
  env.PULSE_WEB_DEV_PORT = String(await freePort())
  const backend = spawn(process.execPath, [join(repo, 'packages/cli/dist/bin.js'), 'h5', 'daemon', '--port', String(backendPort), '--data-dir', data], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let launcher: ChildProcess | undefined, output = '', backendOutput = ''
  const pids = new Set<number>()
  backend.stdout?.on('data', value => { backendOutput += value }); backend.stderr?.on('data', value => { backendOutput += value })
  const descriptor = () => readFile(descriptorPath, 'utf8').then(JSON.parse)
  try {
    await expect.poll(async () => {
      if (backend.exitCode !== null) throw new Error(backendOutput)
      return descriptor().then(value => value.port === backendPort, () => false)
    }, { timeout: 20000 }).toBe(true)
    pids.add(backend.pid!)
    await writeFile(join(data, 'preserved-marker.txt'), 'same development data')
    launcher = spawn('bash', [join(repo, 'start-dev.sh'), '--web-only', '--no-build'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    launcher.stdout?.on('data', value => { output += value }); launcher.stderr?.on('data', value => { output += value })
    let selected = ''
    await expect.poll(() => {
      if (launcher!.exitCode !== null) throw new Error(output)
      selected = output.match(/网页开发预览：(http:\/\/[^\s（]+)/)?.[1] ?? ''
      return Boolean(selected)
    }, { timeout: 30000 }).toBe(true)
    const origin = new URL(selected).origin
    expect(new URL(selected).pathname).toBe('/work/new')
    expect(await fetch(origin + '/__pulse_dev').then(r => r.json())).toMatchObject({ workspace: repo, backend: base })
    expect((await descriptor()).pid).toBe(backend.pid)
    const local = await fetch(origin + '/api/session/local', { method: 'POST', headers: { Origin: origin } })
    const cookie = local.headers.get('set-cookie')!.split(';')[0]!
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
    const conversation = await fetch(origin + '/api/conversations', { method: 'POST', headers, body: JSON.stringify({ title: '自动端口保持会话', projectId: null }) }).then(r => r.json())
    expect(conversation.id).toBeTruthy()
    const repeated = await exec('bash', [join(repo, 'start-dev.sh'), '--web-only', '--no-build'], { cwd: root, env, timeout: 30000 })
    expect(repeated.stdout).toContain('复用已有前端')
    expect(repeated.stdout).toContain(selected)
    expect((await descriptor()).pid).toBe(backend.pid)
    const restarted = await exec('bash', [join(repo, 'restart-dev.sh'), '--web-only', '--no-build'], { cwd: root, env, timeout: 60000 })
    const after = await descriptor(); pids.add(after.pid)
    expect(after.pid).not.toBe(backend.pid); expect(after.port).toBe(backendPort)
    expect(restarted.stdout).toContain('复用已有前端')
    expect(await readFile(join(data, 'preserved-marker.txt'), 'utf8')).toBe('same development data')
    const conversations = await fetch(origin + '/api/conversations', { headers }).then(r => r.json())
    expect(conversations).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversation.id })]))
    console.log(JSON.stringify({ automaticFrontend: selected, savedBackendPort: backendPort, repeatedReuse: true, restartPreservesConversation: true }))
  } catch (error) { console.error(output, backendOutput); throw error }
  finally {
    if (launcher?.exitCode === null) launcher.kill('SIGTERM')
    const current = await descriptor().catch(() => undefined); if (current?.pid) pids.add(current.pid)
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
    await new Promise(resolve => setTimeout(resolve, 1500))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 120000)
