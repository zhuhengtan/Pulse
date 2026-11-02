import { EventEmitter } from 'node:events'
import cp from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { LspService, LSP_HELPER_EXIT_GRACE_MS, releaseOwnedHelper, windowsSystemTaskkill, type OwnedHelper } from '../packages/server/src/lsp/index.js'

afterEach(() => { vi.useRealTimers() })

function withSystemRoot(root: string | undefined, run: () => void): void {
  const previous = process.env.SystemRoot
  const upper = process.env.SYSTEMROOT
  const path = process.env.PATH
  if (root === undefined) { delete process.env.SystemRoot; delete process.env.SYSTEMROOT } else { process.env.SystemRoot = root; process.env.SYSTEMROOT = root }
  try { run() } finally {
    if (previous === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = previous
    if (upper === undefined) delete process.env.SYSTEMROOT
    else process.env.SYSTEMROOT = upper
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
}

function helper(pid: number, exitCode: number | null = null): EventEmitter & OwnedHelper {
  const child = new EventEmitter() as EventEmitter & OwnedHelper
  child.pid = pid
  child.exitCode = exitCode
  child.signalCode = null
  child.stdin = { end: vi.fn() }
  child.kill = vi.fn(() => true)
  return child
}

it('ends stdin and taskkills only a still-live owned Windows helper after the grace period', () => {
  vi.useFakeTimers()
  const child = helper(42)
  const calls: Array<[string, string[]]> = []
  withSystemRoot('C:\\Windows', () => {
    process.env.PATH = 'C:\\untrusted\\project'
    releaseOwnedHelper(child, 42, 'win32', (file, args) => { calls.push([file, args]) })
    expect(child.stdin?.end).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
  })
  expect(calls).toEqual([['C:\\Windows\\System32\\taskkill.exe', ['/PID', '42', '/T', '/F']]])
  expect(calls[0]?.[0]).not.toBe('taskkill.exe')
  expect(calls[0]?.[0].startsWith('C:\\untrusted')).toBe(false)
  expect(child.kill).not.toHaveBeenCalled()
})

it('does not resolve taskkill from the project when SystemRoot is missing, relative, or a UNC share', () => {
  expect(windowsSystemTaskkill('C:\\Windows')).toBe('C:\\Windows\\System32\\taskkill.exe')
  expect(windowsSystemTaskkill('Windows')).toBeUndefined()
  expect(windowsSystemTaskkill('C:\\Windows\\..\\project')).toBeUndefined()
  expect(windowsSystemTaskkill('\\\\files.example\\share')).toBeUndefined()
  vi.useFakeTimers()
  const child = helper(42)
  const calls: string[] = []
  withSystemRoot(undefined, () => {
    releaseOwnedHelper(child, 42, 'win32', () => { calls.push('bare') })
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS)
  })
  expect(calls).toEqual([])
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
})

it('does not taskkill an owned helper that exits or no longer matches during the grace period', () => {
  vi.useFakeTimers()
  const exited = helper(42, 0)
  const calls: string[] = []
  releaseOwnedHelper(exited, 42, 'win32', () => { calls.push('kill') })
  vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS + 50)
  expect(calls).toEqual([])
  expect(exited.kill).not.toHaveBeenCalled()

  const closing = helper(42)
  releaseOwnedHelper(closing, 42, 'win32', () => { calls.push('kill') })
  closing.emit('close')
  vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS + 50)
  expect(calls).toEqual([])

  const recycled = helper(99)
  releaseOwnedHelper(recycled, 42, 'win32', () => { calls.push('kill') })
  vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS + 50)
  expect(calls).toEqual([])
  expect(recycled.kill).not.toHaveBeenCalled()
  expect(recycled.stdin?.end).toHaveBeenCalledOnce()
})

it('falls back to SIGTERM only when the Windows tree kill fails and the same helper is still live', () => {
  vi.useFakeTimers()
  const child = helper(42)
  withSystemRoot('C:\\Windows', () => {
    releaseOwnedHelper(child, 42, 'win32', () => { throw new Error('taskkill failed') })
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS)
  })
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')

  const gone = helper(43)
  withSystemRoot('C:\\Windows', () => {
    releaseOwnedHelper(gone, 43, 'win32', () => { gone.exitCode = 0; throw new Error('taskkill failed') })
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS)
  })
  expect(gone.kill).not.toHaveBeenCalled()
})

it('signals a non-Windows helper immediately and does not use taskkill', () => {
  const child = helper(42)
  const calls: string[] = []
  releaseOwnedHelper(child, 42, 'linux', () => { calls.push('taskkill') })
  expect(child.stdin?.end).toHaveBeenCalledOnce()
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(calls).toEqual([])
})

it.each([false, true])('handles scripted helper EOF before process exit without losing a complete reply (reply=%s)', async complete => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-lsp-eof-'))
  const script = join(root, 'helper.cjs')
  await writeFile(join(root, 'a.ts'), 'const a=1\n')
  // A real stdio pipe with a scripted peer, not a real language server/sandbox.
  await writeFile(script, `let bytes=Buffer.alloc(0),done=false;
const send=(id,result)=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result}));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body]))};
process.on('SIGTERM',()=>{});
process.stdin.on('end',()=>{if(done)setTimeout(()=>process.exit(0),1000)});
process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);for(;;){const at=bytes.indexOf('\\r\\n\\r\\n');if(at<0)return;const length=Number(/Content-Length: (\\d+)/i.exec(bytes.subarray(0,at).toString())[1]);if(bytes.length<at+4+length)return;const message=JSON.parse(bytes.subarray(at+4,at+4+length));bytes=bytes.subarray(at+4+length);if(message.method==='initialize')send(message.id,{capabilities:{}});else if(message.method==='textDocument/documentSymbol'&&!done){done=true;if(${complete})send(message.id,[{name:'complete reply',kind:12}]);process.stdout.end();setTimeout(()=>process.exit(0),4000)}}});`)
  const spawn = cp.spawn, worker = fileURLToPath(new URL('../packages/server/src/lsp/worker.cjs', import.meta.url))
  const children: ReturnType<typeof cp.spawn>[] = [], closed: Promise<void>[] = []
  const controller = new AbortController()
  cp.spawn = function (file: string, args: string[], options: any) {
    const owned = file === process.execPath && Array.isArray(args) && args.includes(worker)
    const child = Reflect.apply(spawn, cp, [file, owned ? [script] : args, options])
    if (owned) { children.push(child); closed.push(new Promise<void>(done => child.once('close', done))) }
    return child
  } as typeof cp.spawn
  syncBuiltinESMExports()
  try {
    const service = new LspService(root, { enabled: true, servers: { test: { command: process.execPath, args: [script], languages: { '.ts': 'typescript' } } } }, controller.signal)
    const query = () => service.query('symbols', { path: 'a.ts' }, controller.signal)
    if (complete) expect(JSON.stringify(await query())).toContain('complete reply')
    else await expect(query()).rejects.toThrow('LSP_SERVER_UNAVAILABLE')
    expect(children).toHaveLength(1)
    expect(children[0]!.exitCode).toBeNull()
    const stdout = children[0]!.stdout!
    if (!stdout.readableEnded) await new Promise<void>(done => stdout.once('end', done))
    await new Promise(resolve => setTimeout(resolve, LSP_HELPER_EXIT_GRACE_MS + 100))
    expect(children[0]!.exitCode).toBeNull()
    expect(children[0]!.signalCode).toBeNull()
    if (complete) {
      // Completed results survive EOF; the next query must get a fresh peer.
      expect(JSON.stringify(await query())).toContain('complete reply')
      expect(children).toHaveLength(2)
    }
  } finally {
    controller.abort()
    await Promise.all(closed)
    cp.spawn = spawn
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})
