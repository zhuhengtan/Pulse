import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { carveWindowsReadDenies, windowsReadDenyRoots, windowsToolchainWriteDenies } from '../packages/adapters/src/tools/windows-read-policy.js'

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

it('opens installed dependency trees while denying adjacent source and configuration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-installation-policy-')))
  try {
    const workspace = join(root, 'jobs', 'workspace'), scratch = join(root, 'jobs', 'scratch')
    const install = join(root, 'install'), nested = join(install, 'packages', 'adapters')
    const deps = [join(install, 'node_modules'), join(nested, 'node_modules')]
    const broker = join(nested, 'dist', 'native')
    for (const path of [workspace, scratch, broker, ...deps, join(nested, 'src')]) await mkdir(path, { recursive: true })
    await writeFile(join(install, '.env'), 'private')
    await writeFile(join(root, 'jobs', 'private.json'), 'private')
    await writeFile(join(nested, 'dist', 'private-source.js'), 'private')
    const denies = await carveWindowsReadDenies(windowsReadDenyRoots(workspace, deps), [workspace, scratch, broker, ...deps])
    expect(denies.sort()).toEqual([join(root, 'jobs', 'private.json'), join(install, '.env'), join(nested, 'src'), join(nested, 'dist', 'private-source.js')].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('denies writes to shared read-only toolchains while retaining workspace and scratch writes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-toolchain-write-')))
  try {
    const toolchain = join(root, 'installed'), workspace = join(toolchain, 'workspace'), deps = join(toolchain, 'node_modules'), scratch = join(root, 'scratch')
    for (const path of [workspace, deps, scratch]) await mkdir(path, { recursive: true })
    await writeFile(join(toolchain, 'node.exe'), 'fixture')
    expect((await windowsToolchainWriteDenies([toolchain, deps, deps, scratch], [workspace, scratch])).sort()).toEqual([deps, join(toolchain, 'node.exe')].sort())
    expect(await windowsToolchainWriteDenies([deps], [workspace, scratch])).toEqual([deps])
    if (process.platform === 'win32') expect(await windowsToolchainWriteDenies([deps, deps.toUpperCase()], [workspace, scratch])).toEqual([deps])
    expect(await windowsToolchainWriteDenies([workspace], [workspace, scratch])).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
