import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, symlink, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import cp from 'node:child_process'
import { LspService, lexicalOutsideWorkspace, localFilePath } from '../packages/server/src/lsp/index.js'

const roots: string[] = []
const controllers: AbortController[] = []
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort())
  await new Promise(resolveTimer => setTimeout(resolveTimer, 150))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })))
})

it('rejects UNC paths and remote file URLs before any filesystem lookup', () => {
  expect(localFilePath('file://files.example/share/a.ts')).toBeUndefined()
  expect(localFilePath('file://FILES.EXAMPLE/share/a.ts')).toBeUndefined()
  const local = resolve('local-file.ts')
  expect(localFilePath(pathToFileURL(local).href)).toBe(local)
  if (process.platform === 'win32') expect(localFilePath('file:///etc/passwd')).toBeUndefined()
  else expect(localFilePath('file:///etc/passwd')).toBe('/etc/passwd')
  const root = 'C:\\work'
  expect(lexicalOutsideWorkspace(root, '\\\\files.example\\share\\a.ts', 'win32')).toBe(true)
  expect(lexicalOutsideWorkspace(root, '//files.example/share/a.ts', 'win32')).toBe(true)
  expect(lexicalOutsideWorkspace(root, 'file://files.example/share/a.ts', 'win32')).toBe(true)
  expect(lexicalOutsideWorkspace(root, '..\\outside.ts', 'win32')).toBe(true)
  expect(lexicalOutsideWorkspace(root, '..secret.ts', 'win32')).toBe(false)
  expect(lexicalOutsideWorkspace('/tmp/work', '/tmp/work/..secret.ts')).toBe(false)
  expect(lexicalOutsideWorkspace('/tmp/work', '/tmp/outside-lsp-probe.ts')).toBe(true)
})

it('keeps flat symbol names and does not open outside inputs or returned URIs', async () => {
  const calls: string[] = []
  const realpath = fs.realpath
  const spawn = cp.spawn
  const trace = process.platform === 'win32' ? process.env.PULSE_CI_SRT_LOG : undefined
  const worker = fileURLToPath(new URL('../packages/server/src/lsp/worker.cjs', import.meta.url))
  // Fixture-only observability: production keeps its sealed helper environment.
  if (trace) cp.spawn = function (file: string, args: string[], options: any) {
    return Reflect.apply(spawn, cp, [file, args, file === process.execPath && args.includes(worker) ? { ...options, env: { ...options.env, PULSE_CI_SRT_LOG: trace } } : options])
  } as typeof cp.spawn
  const began = Date.now()
  const phase = (phase: string) => { if (process.platform === 'win32') console.info('LSP_REPAIR_PHASE ' + JSON.stringify({ phase, elapsedMs: Date.now() - began })) }
  fs.realpath = async function (path, ...args) {
    const text = String(path).replaceAll('\\', '/')
    calls.push(text)
    if (text.endsWith('/outside-lsp-probe.ts') || text === '/etc/passwd' || text.includes('files.example')) throw new Error('OUTSIDE_IO')
    return realpath.call(fs, path, ...args)
  } as typeof fs.realpath
  syncBuiltinESMExports()
  try {
    const container = await mkdtemp(join(tmpdir(), 'pulse-lsp-repair2-'))
    roots.push(container)
    const root = join(container, 'workspace'), outsideFile = join(container, 'outside-lsp-probe.ts')
    await mkdir(root)
    await writeFile(outsideFile, 'private fixture')
    const controller = new AbortController()
    controllers.push(controller)
    await copyFile(resolve('tests/fixtures/lsp/server.cjs'), join(root, 'server.cjs'))
    await writeFile(join(root, 'a.ts'), 'const a=1\n')
    await symlink(outsideFile, join(root, 'link.ts'))
    const service = new LspService(root, { enabled: true, servers: { test: { command: process.execPath, args: [join(root, 'server.cjs'), 'flat'], languages: { '.ts': 'typescript' } } } }, controller.signal)
    phase('outside-checks')
    const outside = join(root, '..', 'outside-lsp-probe.ts')
    await expect(service.query('symbols', { path: outside }, controller.signal)).rejects.toThrow('CODE_PATH_OUTSIDE_WORKSPACE')
    await expect(service.query('symbols', { path: '\\\\files.example\\share\\a.ts' }, controller.signal)).rejects.toThrow('CODE_PATH_OUTSIDE_WORKSPACE')
    await expect(service.query('symbols', { path: 'file://files.example/share/a.ts' }, controller.signal)).rejects.toThrow('CODE_PATH_OUTSIDE_WORKSPACE')
    await expect(service.query('symbols', { path: 'link.ts' }, controller.signal)).rejects.toThrow('CODE_PATH_OUTSIDE_WORKSPACE')
    phase('symbols-start')
    const symbols = await service.query('symbols', { path: 'a.ts' }, controller.signal)
    phase('symbols-finish')
    const items = symbols.items as Array<{ name?: string; kind?: number; path?: string; children?: unknown[] }>
    expect(items.find(item => item.name === 'NamedSymbol')).toMatchObject({ name: 'NamedSymbol', kind: 12, path: 'a.ts' })
    expect(items.some(item => item.name === 'OutsideSymbol' || item.name === 'RemoteSymbol')).toBe(false)
    expect(JSON.stringify(items)).toContain('Inner')
    expect(calls.some(call => call.endsWith('/outside-lsp-probe.ts') || call === '/etc/passwd' || call.includes('files.example'))).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some(call => call.endsWith('/link.ts'))).toBe(true)
  } finally {
    fs.realpath = realpath
    cp.spawn = spawn
    syncBuiltinESMExports()
  }
}, 45000)
