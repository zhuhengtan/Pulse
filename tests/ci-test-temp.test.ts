import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { testTempEnvironment } from '../scripts/ci/test-temp.mjs'
import { carveWindowsReadDenies, windowsReadDenyRoots } from '../packages/adapters/src/tools/windows-read-policy.js'

it('isolates real fixture tmpdir from runner tool caches without opening private siblings', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-ci-temp-layout-')))
  const original = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  try {
    const runnerCache = join(root, 'setup-pnpm'), cargoCache = join(root, 'cargo-target')
    await mkdir(runnerCache); await mkdir(cargoCache)
    const environment = await testTempEnvironment(join(root, 'ci'))
    expect({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }).toEqual(original)
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").tmpdir())'], { env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 10000 })
    expect(child.status, child.stderr).toBe(0)
    expect(await realpath(child.stdout)).toBe(await realpath(environment.TEMP))
    const workspace = join(environment.TEMP, 'workspace'), scratch = join(environment.TEMP, 'scratch'), privateFile = join(environment.TEMP, 'private.json')
    await mkdir(workspace); await mkdir(scratch); await writeFile(privateFile, 'private')
    await mkdir(join(root, 'workspace'))
    const previous = await carveWindowsReadDenies(windowsReadDenyRoots(join(root, 'workspace'), []), [join(root, 'workspace')])
    expect(previous).toContain(runnerCache)
    expect(previous).toContain(cargoCache)
    const current = await carveWindowsReadDenies(windowsReadDenyRoots(workspace, []), [workspace, scratch])
    expect(current).toEqual([privateFile])
    expect(current).not.toContain(runnerCache)
    expect(current).not.toContain(cargoCache)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
