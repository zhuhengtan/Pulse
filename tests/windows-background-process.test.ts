import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

// Evaluate the actual launch options without Electron, Windows or real services.
// Background workers must stay hidden while keeping their IPC/logging channels.
const launches = [
  ['packages/desktop/src/main.mjs', 'spawn(runtime,', false],
  ['packages/desktop/src/main.mjs', 'spawn(installation.node,', true],
  ['packages/desktop/src/update-control.mjs', 'spawn(node,', false],
  ['packages/server/src/updates/reader-client.ts', 'spawn(node,', true],
  ['packages/server/src/updates/coordinator.ts', 'spawn(runtime.node,', true],
  ['packages/server/src/updates/launcher.ts', 'spawn(join(runtime,', false],
  ['packages/server/src/h5/work-worker.ts', 'fork(options.entry,', true],
  ['scripts/desktop/start-local.mjs', 'spawn(process.execPath,', false],
] as const

it.each(launches)('hides the background console in %s (%s) and preserves its channels', (path, callPrefix, ipc) => {
  const source = ts.createSourceFile(path, readFileSync(new URL('../' + path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  let options: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.getText(source).startsWith(callPrefix)) options = node.arguments[2]
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(options).toBeDefined()
  const context = {
    module: { exports: {} }, process: { platform: 'win32', pid: 123, env: { FIXTURE: 'kept' }, cwd: () => '/cwd' },
    join, homedir: () => '/home', diagnosticDirectory: () => '/logs', serviceRuntimeEnvironment: () => ({ RUNTIME: 'kept' }),
    installation: { root: '/install' }, directory: '/data', spec: { root: '/root' }, runtime: { directory: undefined },
    token: 'fixture-token', baseRuntime: '/base', maintenance: false, source: '/source', root: '/root', base: '/base',
    manifest: { buildId: 'fixture-build' }, createHash: () => ({ update: () => ({ digest: () => 'fixture-hash' }) }),
    options: { cwd: '/cwd' }, env: { FIXTURE: 'kept' }, repo: '/repo', output: { fd: 42 },
  }
  const code = ts.transpileModule(`module.exports = (${options!.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const launch = new Function('context', `with (context) { ${code}; return module.exports }`)(context)
  expect(launch.windowsHide).toBe(true)
  expect(launch.env.FIXTURE).toBe('kept')
  if (ipc) expect(launch.stdio).toContain('ipc')
  if (path === 'packages/desktop/src/main.mjs' && !ipc) {
    expect(launch.detached).toBe(true)
    expect(launch.stdio).toBe('ignore')
  }
})
