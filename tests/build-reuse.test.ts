import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ensureBuild } from '../scripts/build/ensure.mjs'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-build-reuse-')); roots.push(root)
  await mkdir(join(root, 'packages/a'), { recursive: true })
  await writeFile(join(root, 'packages/a/input.ts'), 'export const a = 1')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lock1')
  const outputs = ['packages/a/dist', 'packages/b/dist']
  let builds = 0
  const options = { root, outputs, identity: { node: '22', abi: '127', compiler: '5.7', platform: 'test' }, run: async () => {}, build: async () => {
    builds++
    for (const output of outputs) { await mkdir(join(root, output), { recursive: true }); await writeFile(join(root, output, 'index.js'), 'output' + builds) }
  } }
  return { root, options, builds: () => builds }
}
it('reuses verified outputs without Git, invalidates changed source, lock, and toolchain', async () => {
  const f = await fixture()
  expect((await ensureBuild('workspace', f.options)).reused).toBe(false)
  expect((await ensureBuild('workspace', f.options)).reused).toBe(true)
  await writeFile(join(f.root, 'packages/a/input.ts'), 'export const a = 2')
  expect((await ensureBuild('workspace', f.options)).reused).toBe(false)
  await writeFile(join(f.root, 'pnpm-lock.yaml'), 'lock2')
  expect((await ensureBuild('workspace', f.options)).reused).toBe(false)
  expect((await ensureBuild('workspace', { ...f.options, identity: { ...f.options.identity, abi: 'new' } })).reused).toBe(false)
  expect(f.builds()).toBe(4)
})
it('rebuilds missing, empty, or tampered output trees even if another output exists', async () => {
  const f = await fixture(); await ensureBuild('workspace', f.options)
  await writeFile(join(f.root, 'packages/a/dist/index.js'), 'tampered')
  expect((await ensureBuild('workspace', f.options)).reused).toBe(false)
  await rm(join(f.root, 'packages/b/dist'), { recursive: true })
  expect((await ensureBuild('workspace', f.options)).reused).toBe(false)
  await rm(join(f.root, 'packages/b/dist/index.js'))
  expect((await ensureBuild('workspace', f.options)).reused).toBe(false)
  expect(f.builds()).toBe(4)
})
it('does not certify a build when inputs change during compilation or output is missing', async () => {
  const f = await fixture()
  await expect(ensureBuild('workspace', { ...f.options, build: async () => {
    await f.options.build(); await writeFile(join(f.root, 'pnpm-lock.yaml'), 'changed during build')
  } })).rejects.toThrow('BUILD_INPUT_CHANGED')
  await expect(readFile(join(f.root, '.pulse-dev/build-state/workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(join(f.root, 'packages/b/dist'), { recursive: true })
  await expect(ensureBuild('workspace', { ...f.options, build: async () => {} })).rejects.toThrow('BUILD_OUTPUT_MISSING')
})
it('serializes two simultaneous build requests without duplicate builds', async () => {
  const f = await fixture()
  const results = await Promise.all([ensureBuild('workspace', f.options), ensureBuild('workspace', f.options)])
  expect(results.map(x => x.reused).sort()).toEqual([false, true]); expect(f.builds()).toBe(1)
})
