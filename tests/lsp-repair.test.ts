import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LspService, LSP_CANCEL_QUIET_MS, parseLspConfig } from '../packages/server/src/lsp/index.js'
import { LspFrames } from '../packages/server/src/lsp/protocol.js'

const roots: string[] = []
const controllers: AbortController[] = []
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort())
  await new Promise(resolve => setTimeout(resolve, 150))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function names(nodes: any[]): string[] {
  return nodes.flatMap(node => [node.name, ...names(node.children ?? [])])
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
async function fixture(mode = '', extra: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-lsp-repair-'))
  roots.push(root)
  const controller = new AbortController()
  controllers.push(controller)
  await copyFile(resolve('tests/fixtures/lsp/server.cjs'), join(root, 'server.cjs'))
  await writeFile(join(root, 'a.ts'), 'const a=1\n')
  const hold = join(root, 'hold')
  const args = [join(root, 'server.cjs'), mode, ...extra]
  if (mode === 'hang') { await writeFile(hold, 'hold'); args.push(`hold=${hold}`) }
  const config = { enabled: true as const, servers: { test: { command: process.execPath, args: args.filter(arg => arg !== ''), languages: { '.ts': 'typescript' } } } }
  return { root, hold, controller, config, service: new LspService(root, config, controller.signal) }
}

it('rejects a completed oversized header and a header that only exceeds the cap when joined', () => {
  let accepted = false
  const probe = Buffer.from('X: ' + 'a'.repeat(20000) + '\r\nContent-Length: 17\r\n\r\n{"jsonrpc":"2.0"}')
  expect(() => new LspFrames(() => { accepted = true }).push(probe)).toThrow('LSP_HEADER_TOO_LARGE')
  expect(accepted).toBe(false)
  const split = new LspFrames(() => { accepted = true })
  split.push(probe.subarray(0, 4000))
  expect(() => split.push(probe.subarray(4000))).toThrow('LSP_HEADER_TOO_LARGE')
  expect(() => new LspFrames(() => {}).push(Buffer.alloc(9000))).toThrow('LSP_HEADER_TOO_LARGE')
  expect(() => new LspFrames(() => {}).push(Buffer.from('Content-Length: 3000000\r\n\r\n'))).toThrow('LSP_FRAME_TOO_LARGE')
})

it('keeps nested symbol names and ranges, and truncates by total nodes and depth', async () => {
  const tree = await fixture('tree')
  const nested = await tree.service.query('symbols', { path: 'a.ts' }, tree.controller.signal)
  expect(names(nested.items as any[])).toEqual(['Outer', 'Inner', 'Leaf'])
  expect(nested.truncated).toBe(false)
  expect((nested.items as any[])[0].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } })
  const wide = await fixture('wide')
  const capped = await wide.service.query('symbols', { path: 'a.ts' }, wide.controller.signal)
  expect(names(capped.items as any[])).toEqual(['Root', ...Array.from({ length: 99 }, (_, index) => 'N' + index)])
  expect(names(capped.items as any[])).not.toContain('N99')
  expect(capped.truncated).toBe(true)
  const deep = await fixture('deep')
  const limited = await deep.service.query('symbols', { path: 'a.ts' }, deep.controller.signal)
  expect(names(limited.items as any[])).toEqual(['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'])
  expect(limited.truncated).toBe(true)
}, 45000)

it('allows a workspace file named ..secret.ts and still rejects a parent segment', async () => {
  const f = await fixture()
  await writeFile(join(f.root, '..secret.ts'), 'const a=1\n')
  const symbols = await f.service.query('symbols', { path: '..secret.ts' }, f.controller.signal)
  expect(JSON.stringify(symbols)).toContain('write=denied')
  const definition = await f.service.query('definition', { path: '..secret.ts', line: 1, column: 1 }, f.controller.signal)
  expect(definition.items).toEqual([expect.objectContaining({ path: '..secret.ts' })])
  await expect(f.service.query('symbols', { path: '..' }, f.controller.signal)).rejects.toThrow('CODE_PATH_OUTSIDE_WORKSPACE')
}, 45000)

it('rejects enabled strings and workspace-root overrides before starting a server', async () => {
  const f = await fixture()
  const bad = { enabled: 'false', servers: { test: { command: process.execPath, args: [join(f.root, 'server.cjs')], languages: { '.ts': 'typescript' } } } }
  expect(() => new LspService(f.root, bad as any, f.controller.signal)).toThrow('LSP_CONFIG_INVALID')
  expect(() => parseLspConfig({ enabled: true, root: f.root, servers: { test: { command: 'x', languages: { '.ts': 'typescript' } } } })).toThrow('LSP_CONFIG_INVALID')
  expect(() => parseLspConfig({ enabled: true, servers: { test: { command: 'x', languages: { '.ts': 'typescript' }, root: '/etc' } } })).toThrow('LSP_CONFIG_INVALID')
  await expect(new LspService(f.root, { enabled: false, servers: f.config.servers }, f.controller.signal).query('symbols', { path: 'a.ts' }, f.controller.signal)).rejects.toThrow('CODE_SERVER_UNAVAILABLE')
  await expect(readFile(join(f.root, 'unauthorized.txt'))).rejects.toThrow()
})

it('uses the config captured at construction after the caller mutates it', async () => {
  const f = await fixture()
  f.config.enabled = false as any
  f.config.servers.test.command = 'evil'
  const result = await f.service.query('symbols', { path: 'a.ts' }, f.controller.signal)
  expect(JSON.stringify(result)).toContain('write=denied')
}, 45000)

it('retires a silent cancelled server and serves the next query from a new process', async () => {
  const f = await fixture('hang', ['track'])
  const symbolsSignal = new AbortController()
  const pending = f.service.query('symbols', { path: 'a.ts' }, symbolsSignal.signal)
  const settled = pending.then(() => undefined, (error: Error) => error)
  const diagnostic = await f.service.query('diagnostics', { path: 'a.ts' }, f.controller.signal)
  const first = Number(/pid=(\d+)/.exec(JSON.stringify(diagnostic))?.[1])
  expect(first).toBeGreaterThan(0)
  symbolsSignal.abort()
  const error = await settled
  expect(String((error as Error).message ?? error)).toMatch(/CANCELLED/)
  await new Promise(resolve => setTimeout(resolve, LSP_CANCEL_QUIET_MS + 700))
  expect(alive(first)).toBe(false)
  await unlink(f.hold)
  const next = await f.service.query('symbols', { path: 'a.ts' }, f.controller.signal)
  const second = Number(/pid=(\d+)/.exec(JSON.stringify(next))?.[1])
  expect(second).toBeGreaterThan(0)
  expect(second).not.toBe(first)
}, 45000)

it('keeps a connection that still answers after a sibling request is cancelled', async () => {
  const f = await fixture('hang', ['track'])
  const symbolsSignal = new AbortController()
  const pending = f.service.query('symbols', { path: 'a.ts' }, symbolsSignal.signal)
  const settled = pending.then(() => undefined, (error: Error) => error)
  const firstDiagnostic = await f.service.query('diagnostics', { path: 'a.ts' }, f.controller.signal)
  const first = Number(/pid=(\d+)/.exec(JSON.stringify(firstDiagnostic))?.[1])
  symbolsSignal.abort()
  const again = await f.service.query('diagnostics', { path: 'a.ts' }, f.controller.signal)
  expect(Number(/pid=(\d+)/.exec(JSON.stringify(again))?.[1])).toBe(first)
  await new Promise(resolve => setTimeout(resolve, LSP_CANCEL_QUIET_MS + 400))
  expect(alive(first)).toBe(true)
  await unlink(f.hold)
  const next = await f.service.query('symbols', { path: 'a.ts' }, f.controller.signal)
  expect(Number(/pid=(\d+)/.exec(JSON.stringify(next))?.[1])).toBe(first)
  await settled
}, 45000)
