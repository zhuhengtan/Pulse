import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveShellIdentity } from '../packages/adapters/src/tools/shell.js'
import { assertFixtureCleanupExit, fixtureNodeChecks } from './helpers/fixture-node-check.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(files: Record<string, readonly string[]>, argv: readonly (readonly string[])[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-fixture-node-check-'))); roots.push(root)
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(join(root, name), contents[0]!)))
  const executor = await fixtureNodeChecks(root, argv, files)
  return { root, executor, options: { cwd: root, workspaceRoot: root, timeoutMs: 5000 } }
}

it('executes every fresh Node check and preserves a real assertion failure and stderr', async () => {
  // Direct node:test entry keeps console.error on stderr; --test relays it into TAP stdout.
  const argv = ['value.test.mjs']
  const f = await fixture({
    'feature.mjs': ['export const value = 2', 'export const value = 3'],
    'value.test.mjs': ["import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from './feature.mjs'; console.error('fixture stderr'); test('actual value', () => assert.equal(value, 2))"],
  }, [argv])
  const beforeLaunch = vi.fn(() => resolveShellIdentity('node', argv, f.root))
  const passed = await f.executor.execute('node', argv, { ...f.options, beforeLaunch })
  expect(passed).toMatchObject({ code: 0, aborted: false, timedOut: false, truncated: false })
  expect(passed.stdout).toContain('actual value'); expect(passed.stderr).toContain('fixture stderr')
  await writeFile(join(f.root, 'feature.mjs'), 'export const value = 3')
  const failed = await f.executor.execute('node', argv, { ...f.options, beforeLaunch })
  expect(failed).toMatchObject({ code: 1, aborted: false, timedOut: false, truncated: false })
  expect(failed.stdout).toContain('ERR_ASSERTION'); expect(failed.stderr).toContain('fixture stderr')
  expect(beforeLaunch).toHaveBeenCalledTimes(2)
  expect(f.executor.calls.map(call => call.args)).toEqual([argv, argv])
  expect(f.executor.calls.map(call => call.result?.code)).toEqual([0, 1])
})

it('rejects unknown commands, argv, directories, executable identity and changed script bytes before spawning', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': ['console.log("fixed check")'] }, [argv])
  for (const command of ['sh', process.execPath]) await expect(f.executor.execute(command, argv, f.options)).rejects.toThrow('NOT_ALLOWED')
  await expect(f.executor.execute('node', ['check.mjs', 'extra'], f.options)).rejects.toThrow('NOT_ALLOWED')
  await expect(f.executor.execute('node', ['-e', 'process.exit(0)'], f.options)).rejects.toThrow('NOT_ALLOWED')
  await expect(f.executor.execute('node', argv, { ...f.options, cwd: dirname(f.root) })).rejects.toThrow('NOT_ALLOWED')
  await expect(f.executor.execute('node', argv, { ...f.options, workspaceRoot: dirname(f.root) })).rejects.toThrow('NOT_ALLOWED')
  const identity = await resolveShellIdentity('node', argv, f.root)
  const refresh = vi.fn(async () => identity)
  await expect(f.executor.execute('node', argv, { ...f.options, expectedIdentity: { ...identity, fingerprint: 'changed' }, beforeLaunch: refresh })).rejects.toThrow('NOT_ALLOWED')
  expect(refresh).not.toHaveBeenCalled()
  await expect(f.executor.execute('node', argv, { ...f.options, beforeLaunch: async () => ({ ...identity, fingerprint: 'changed' }) })).rejects.toThrow('NOT_ALLOWED')
  await writeFile(join(f.root, 'check.mjs'), 'console.log("unrecognized replacement")')
  await expect(f.executor.execute('node', argv, f.options)).rejects.toThrow('NOT_ALLOWED')
  expect(f.executor.calls).toHaveLength(0)
  await expect(fixtureNodeChecks(f.root, [['-e', 'process.exit(0)']], { 'check.mjs': ['known'] })).rejects.toThrow('NOT_ALLOWED')
  await expect(fixtureNodeChecks(f.root, [['--eval=process.exit(0)']], { '--eval=process.exit(0)': ['known'] })).rejects.toThrow('NOT_ALLOWED')
})

const waiting = "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', \"const fs = require('node:fs'); setTimeout(() => fs.writeFileSync('leaked.txt', 'leaked'), 700); setInterval(() => { if (fs.existsSync('release-child')) process.exit(0) }, 20); setTimeout(() => process.exit(0), 3000)\"], { stdio: 'ignore' }); console.log('READY:' + child.pid); setInterval(() => {}, 1000)"
async function releaseDescendant(root: string, pid: number | undefined) {
  // A failed tree receipt must not leave even this intentionally adversarial
  // fixture running. Signal only its fixed workspace file, then prove PID exit.
  await writeFile(join(root, 'release-child'), 'stop')
  if (pid === undefined) return
  await vi.waitFor(() => {
    let alive = true
    try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error }
    expect(alive).toBe(false)
  }, { timeout: 5000 })
}

it('does not start an already-aborted check', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': ['console.log("fixed check")'] }, [argv])
  const controller = new AbortController(); controller.abort()
  expect(await f.executor.execute('node', argv, { ...f.options, signal: controller.signal })).toMatchObject({ code: null, aborted: true, timedOut: false })
  expect(f.executor.calls).toHaveLength(0)
})
it('cancels a running owned process tree and never reports success or leaks its child', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': [waiting] }, [argv])
  const controller = new AbortController()
  let descendant: number | undefined, output = ''
  try {
    const result = await f.executor.execute('node', argv, { ...f.options, signal: controller.signal, onOutput: (_stream, chunk) => {
      output += chunk.toString(); const ready = /READY:(\d+)\s/.exec(output)
      if (ready) { descendant = Number(ready[1]); controller.abort() }
    } })
    expect(descendant).toBeGreaterThan(0)
    expect(result).toMatchObject({ code: null, aborted: true, timedOut: false, truncated: false })
    expect(result.stdout).toContain('READY'); expect(f.executor.calls).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 900))
    await expect(readFile(join(f.root, 'leaked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await releaseDescendant(f.root, descendant) }
})
it('reports its bounded process timeout without fabricating an exit code', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': ['setInterval(() => {}, 1000)'] }, [argv])
  expect(await f.executor.execute('node', argv, { ...f.options, timeoutMs: 30 })).toMatchObject({ code: null, aborted: false, timedOut: true, truncated: false })
  expect(f.executor.calls).toHaveLength(1)
})
it('fails closed on output overflow and retains only bounded actual bytes', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': ["process.stdout.write('x'.repeat(256)); setInterval(() => {}, 1000)"] }, [argv])
  const result = await f.executor.execute('node', argv, { ...f.options, maxOutputBytes: 32 })
  expect(result).toEqual({ code: null, stdout: 'x'.repeat(32), stderr: '', truncated: true, timedOut: false, aborted: false })
  expect(f.executor.calls).toHaveLength(1)
})

it('rejects argv mutation during authorization instead of executing another command', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': ['console.log("fixed check")'] }, [argv])
  const identity = await resolveShellIdentity('node', argv, f.root)
  await expect(f.executor.execute('node', argv, { ...f.options, beforeLaunch: async () => {
    argv.splice(0, argv.length, '-e', 'process.exit(0)')
    return identity
  } })).rejects.toThrow('NOT_ALLOWED')
  expect(f.executor.calls).toHaveLength(0)
})
it('requires an explicit successful tree-cleanup receipt, never just the parent close', () => {
  expect(() => assertFixtureCleanupExit(0)).not.toThrow()
  for (const code of [null, 1, -1]) expect(() => assertFixtureCleanupExit(code)).toThrow('FIXTURE_NODE_CHECK_CLEANUP_FAILED')
})
it('does not treat a parent-exit race as proof that its descendants were cleaned up', async () => {
  const argv = ['check.mjs'], f = await fixture({ 'check.mjs': [waiting.replace('setInterval(() => {}, 1000)', 'process.exit(0)')] }, [argv])
  const controller = new AbortController()
  let result: Awaited<ReturnType<typeof f.executor.execute>> | undefined, descendant: number | undefined, output = ''
  try {
    try {
      result = await f.executor.execute('node', argv, { ...f.options, signal: controller.signal, onOutput: (_stream, chunk) => {
        output += chunk.toString(); const ready = /READY:(\d+)\s/.exec(output)
        if (ready) { descendant = Number(ready[1]); controller.abort() }
      } })
    } catch (error) {
      // Losing an exiting parent PID is unknown tree cleanup, never success.
      expect((error as Error).message).toBe('FIXTURE_NODE_CHECK_CLEANUP_FAILED')
    }
    expect(descendant).toBeGreaterThan(0)
    expect(f.executor.calls).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 900))
    if (result) {
      expect(result).toMatchObject({ code: null, aborted: true, timedOut: false, truncated: false })
      await expect(readFile(join(f.root, 'leaked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { await releaseDescendant(f.root, descendant) }
})
