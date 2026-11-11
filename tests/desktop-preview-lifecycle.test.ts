import { afterEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { previewProcessExit, runDesktopPreview } from '../scripts/desktop/preview-lifecycle.mjs'

const children: ChildProcess[] = []
function launch(code: string, ipc = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ipc ? ['ignore', 'ignore', 'pipe', 'ipc'] : ['ignore', 'ignore', 'pipe'] })
  children.push(child); return child
}
afterEach(async () => { await Promise.all(children.splice(0).map(async child => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } })) })
async function frontend() {
  const child = launch(`import {createServer} from 'node:http'; const server=createServer((req,res)=>res.end('vite-fixture')); server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));`, true)
  const [message] = await once(child, 'message') as [{ port: number }]
  return { child, url: `http://127.0.0.1:${message.port}` }
}
it('keeps the owned frontend available after the secondary Electron exits successfully', async () => {
  const vite = await frontend(), desktop = launch('process.exit(0)'), log = vi.fn()
  let finished = false
  const running = runDesktopPreview({ desktop, vite: vite.child, log }).then(value => { finished = true; return value })
  await vi.waitFor(() => expect(log).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  expect(await fetch(vite.url).then(response => response.text())).toBe('vite-fixture')
  vite.child.kill('SIGTERM'); await running
  expect(finished).toBe(true)
})
it('does not take ownership of an existing frontend', async () => {
  const desktop = launch('process.exit(0)'), log = vi.fn()
  await expect(runDesktopPreview({ desktop, vite: undefined, log })).resolves.toMatchObject({ code: 0 })
  expect(log).not.toHaveBeenCalled()
})
it('surfaces an Electron crash instead of treating it as a tray handoff', async () => {
  const desktop = launch('process.exit(7)'), log = vi.fn()
  await expect(runDesktopPreview({ desktop, vite: undefined, log })).rejects.toThrow('Electron 开发预览退出（7）')
  expect(log).not.toHaveBeenCalled()
})
it('returns promptly on interruption and handles a child that has already exited', async () => {
  const desktop = launch('process.exit(0)'); await once(desktop, 'exit')
  expect(await previewProcessExit(desktop)).toMatchObject({ code: 0 })
  const log = vi.fn()
  await expect(runDesktopPreview({ desktop, vite: { exitCode: null, signalCode: null }, interrupted: () => true, log })).resolves.toMatchObject({ code: 0 })
  expect(log).not.toHaveBeenCalled()
})
