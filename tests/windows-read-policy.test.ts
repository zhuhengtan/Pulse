import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

it('keeps the bridge and its required protocol file readable without opening their directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-pty-protocol-read-')))
  try {
    const tools = join(root, 'install', 'tools')
    const bridge = join(tools, 'windows-pty-bridge.cjs')
    const protocol = join(tools, 'windows-pty-protocol.cjs')
    await mkdir(tools, { recursive: true })
    await writeFile(bridge, 'bridge')
    await writeFile(protocol, 'protocol')
    await writeFile(join(tools, 'secret.txt'), 'secret')
    const denies = await carveWindowsReadDenies([join(root, 'install')], [bridge, protocol])
    expect(denies).toContain(join(tools, 'secret.txt'))
    expect(denies).not.toContain(bridge)
    expect(denies).not.toContain(protocol)
    expect(denies).not.toContain(tools)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('denies writes to shared read-only toolchains while retaining workspace and scratch writes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-toolchain-write-')))
  try {
    const toolchain = join(root, 'installed'), workspace = join(toolchain, 'workspace'), deps = join(toolchain, 'node_modules'), scratch = join(root, 'scratch')
    for (const path of [workspace, deps, scratch]) await mkdir(path, { recursive: true })
    await writeFile(join(toolchain, 'node.exe'), 'fixture')
    expect((await windowsToolchainWriteDenies([toolchain, deps, deps, scratch], [workspace, scratch])).sort()).toEqual([toolchain, deps, join(toolchain, 'node.exe')].sort())
    expect(await windowsToolchainWriteDenies([deps], [workspace, scratch])).toEqual([deps])
    if (process.platform === 'win32') expect(await windowsToolchainWriteDenies([deps, deps.toUpperCase()], [workspace, scratch])).toEqual([deps])
    expect(await windowsToolchainWriteDenies([workspace], [workspace, scratch])).toEqual([])
    // A read-only workspace needs an explicit deny even when Windows grants
    // Users inherited write rights; scratch remains the only writable tree.
    expect(await windowsToolchainWriteDenies([workspace, deps], [scratch])).toEqual([workspace, deps])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('carves aliases by their targets without granting outside siblings or removing readonly writes', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pulse-policy-alias-')))
  try {
    const primary = join(base, 'primary'), container = join(base, 'other'), secondary = join(container, 'secondary')
    const outside = join(container, 'outside'), nested = join(secondary, 'nested'), scratch = join(base, 'scratch')
    for (const path of [primary, secondary, outside, nested, scratch]) await mkdir(path, { recursive: true })
    const link = (target: string, name: string) => symlink(target, join(base, name), process.platform === 'win32' ? 'junction' : 'dir')
    await link(secondary, 'alias')
    await link(secondary, 'duplicate')
    await link(nested, 'nested-alias')
    await link(container, 'ancestor-alias')
    await link(outside, 'outside-alias')
    // Both a direct alias and an alias to its ancestor must preserve the same
    // authorized target, while the sibling is still denied exactly once.
    expect(await carveWindowsReadDenies([base, container], [primary, secondary, scratch])).toEqual([outside])
    expect((await windowsToolchainWriteDenies([base, secondary, join(base, 'alias')], [primary, scratch])).sort()).toEqual([base, container, outside, secondary, nested].sort())
    expect((await windowsToolchainWriteDenies([base, secondary], [scratch])).sort()).toEqual([base, primary, container, outside, secondary, nested].sort())
  } finally { await rm(base, { recursive: true, force: true }) }
})

it('fails closed when a discovered alias target cannot be resolved', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pulse-policy-broken-alias-')))
  try {
    const workspace = join(base, 'workspace'), alias = join(base, 'alias')
    await mkdir(workspace)
    await symlink(join(base, 'missing'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(carveWindowsReadDenies([base], [workspace])).rejects.toThrow()
    await rm(alias)
    await symlink(alias, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(carveWindowsReadDenies([base], [workspace])).rejects.toThrow()
  } finally { await rm(base, { recursive: true, force: true }) }
})

it('seals readonly ancestors themselves, including empty ancestors and deep writable carve-outs', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pulse-write-ancestor-')))
  try {
    const primary = join(base, 'middle', 'primary'), scratch = join(base, 'scratch')
    await mkdir(primary, { recursive: true })
    await mkdir(scratch)
    // Both ancestor objects need inherited write protection, not a snapshot of
    // their existing children. The writable roots receive explicit SDK grants.
    expect(await windowsToolchainWriteDenies([base, primary], [primary, scratch])).toEqual([base, join(base, 'middle')])
    await writeFile(join(base, 'later.txt'), 'outside')
    await mkdir(join(base, 'later-dir'))
    expect((await windowsToolchainWriteDenies([base, primary], [primary, scratch])).sort()).toEqual([base, join(base, 'middle'), join(base, 'later.txt'), join(base, 'later-dir')].sort())
    expect(await windowsToolchainWriteDenies([primary], [primary])).toEqual([])
    expect((await windowsToolchainWriteDenies([base, primary], [scratch])).sort()).toEqual([base, join(base, 'middle'), join(base, 'later.txt'), join(base, 'later-dir')].sort())
  } finally { await rm(base, { recursive: true, force: true }) }
})
