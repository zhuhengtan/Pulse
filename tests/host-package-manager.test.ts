import { afterEach, expect, it } from 'vitest'
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveHostPackageManager } from '../packages/adapters/src/tools/host-package-manager.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-host-pm-'))); roots.push(root)
  const bin = join(root, 'bin'), pkg = join(root, 'lib/node_modules/pnpm')
  await mkdir(bin, { recursive: true }); await mkdir(join(pkg, 'bin'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.cjs' } }))
  await writeFile(join(pkg, 'bin/pnpm.cjs'), 'process.stdout.write("HOST_PACKAGE_OK")')
  await symlink(join(pkg, 'bin/pnpm.cjs'), join(bin, 'pnpm'))
  return { root, bin, pkg }
}
it('resolves a host-installed manager to its package without granting its NVM/home parent', async () => {
  const { bin, pkg } = await fixture()
  expect(await resolveHostPackageManager('pnpm', process.execPath, bin)).toEqual({ executable: process.execPath, prefixArgs: [join(pkg, 'bin/pnpm.cjs')], readRoot: pkg })
  expect(await resolveHostPackageManager('git', process.execPath, bin)).toBeUndefined()
})
it('does not search beyond a shadowing unknown PATH shim or accept an undeclared package entry', async () => {
  const { root, bin, pkg } = await fixture(), shadow = join(root, 'shadow')
  await mkdir(shadow); await writeFile(join(shadow, 'pnpm'), '#!/bin/sh\nexit 0\n'); await chmod(join(shadow, 'pnpm'), 0o755)
  const { delimiter } = await import('node:path')
  expect(await resolveHostPackageManager('pnpm', process.execPath, shadow + delimiter + bin)).toBeUndefined()
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'other.cjs' } }))
  expect(await resolveHostPackageManager('pnpm', process.execPath, bin)).toBeUndefined()
})
it.skipIf(process.platform === 'win32')('executes the real host pnpm with a packaged-node-like child PATH', async () => {
  const { root } = await fixture()
  await writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}')
  await writeFile(join(root, 'probe.cjs'), 'process.stdout.write("PACKAGED_PATH_OK")')
  // The real production node is standalone, so its directory has no pnpm.
  // Merely changing the child PATH while keeping the development Node would
  // miss the regression: runShell always prepends that Node's bin directory.
  const runtime = join(root, 'runtime'); await mkdir(runtime)
  const node = join(runtime, 'node'); await copyFile(process.execPath, node); await chmod(node, 0o755)
  const module = new URL('../packages/adapters/dist/tools/shell.js', import.meta.url).href
  await writeFile(join(root, 'launch.mjs'), `import { runShell } from ${JSON.stringify(module)}; const result = await runShell('pnpm', ['exec', 'node', 'probe.cjs'], { cwd: ${JSON.stringify(root)}, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 30_000 }); console.log(JSON.stringify(result))`)
  const output = await promisify(execFile)(node, [join(root, 'launch.mjs')], { timeout: 45_000 })
  const result = JSON.parse(output.stdout)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('PACKAGED_PATH_OK')
})
