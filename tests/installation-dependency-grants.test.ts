import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { workspaceUsesInstallationDependencies } from '../packages/adapters/src/tools/installation-dependencies.js'

it('retains host and linked dependency grants while skipping unrelated scripts', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pulse-dependency-grants-')))
  try {
    const workspace = join(directory, 'workspace'), installed = join(directory, 'host', 'node_modules')
    await mkdir(workspace); await mkdir(installed, { recursive: true })
    expect(await workspaceUsesInstallationDependencies(join(directory, 'host', 'src'), [installed])).toBe(true)
    expect(await workspaceUsesInstallationDependencies(workspace, [installed])).toBe(false)
    await mkdir(join(workspace, 'node_modules'))
    expect(await workspaceUsesInstallationDependencies(workspace, [installed])).toBe(false)
    await rm(join(workspace, 'node_modules'), { recursive: true })
    await symlink(installed, join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await workspaceUsesInstallationDependencies(workspace, [installed])).toBe(true)
    expect(await workspaceUsesInstallationDependencies(workspace, [join(directory, 'other', 'node_modules')])).toBe(false)
    await rm(join(workspace, 'node_modules'), { recursive: true, force: true })
    await mkdir(join(workspace, 'node_modules', '@fixture'), { recursive: true })
    await symlink(installed, join(workspace, 'node_modules', '@fixture', 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await workspaceUsesInstallationDependencies(workspace, [installed])).toBe(true)
    await rm(join(workspace, 'node_modules'), { recursive: true, force: true })
    await mkdir(join(workspace, 'node_modules'))
    await symlink(installed, join(workspace, 'node_modules', 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await workspaceUsesInstallationDependencies(workspace, [installed])).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
