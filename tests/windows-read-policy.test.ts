import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { carveWindowsReadDenies } from '../packages/adapters/src/tools/windows-read-policy.js'

it('denies siblings without placing inherited denies above allowed workspaces or toolchains', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pulse-windows-policy-')))
  try {
    const workspace = join(home, 'projects', 'work 雪')
    const sibling = join(home, 'projects', 'private')
    const scratch = join(home, 'temp', 'scratch')
    const toolchain = join(home, 'tools', 'node')
    for (const path of [workspace, sibling, scratch, toolchain]) await mkdir(path, { recursive: true })
    await writeFile(join(home, 'secret.txt'), 'secret')
    await writeFile(join(home, 'tools', 'credentials'), 'secret')
    await writeFile(join(home, 'temp', 'other.txt'), 'secret')
    await writeFile(join(workspace, 'file.txt'), 'allowed')
    expect((await carveWindowsReadDenies([home, join(home, 'temp')], [workspace, scratch, toolchain])).sort()).toEqual([
      sibling, join(home, 'secret.txt'), join(home, 'tools', 'credentials'), join(home, 'temp', 'other.txt'),
    ].sort())
    expect(await carveWindowsReadDenies([sibling], [workspace])).toEqual([sibling])
    await expect(carveWindowsReadDenies([join(home, 'missing')], [join(home, 'missing', 'workspace')])).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})
