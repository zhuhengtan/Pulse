import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveWindowsPackageManager } from '../packages/adapters/src/tools/windows-package-manager.js'

describe('Windows package manager installation resolution', () => {
  let root: string
  let node: string
  let home: string
  async function file(path: string) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '')
    return realpath(path)
  }
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pulse pnpm 雪-')))
    node = await file(join(root, 'node', 'node.exe'))
    home = join(root, 'setup-pnpm', 'node_modules', '.bin')
    await mkdir(home, { recursive: true })
    // Match hosted runners: Corepack exists, but must lose to configured pnpm.
    await file(join(dirname(node), 'node_modules', 'corepack', 'dist', 'pnpm.js'))
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('prefers pnpm 12 native installation over both its wrapper and Corepack', async () => {
    const native = await file(join(dirname(home), 'pnpm', 'pnpm.exe'))
    await file(join(dirname(home), 'pnpm', 'bin', 'pnpm.mjs'))
    expect(await resolveWindowsPackageManager('pnpm', node, home)).toEqual({ executable: native, prefixArgs: [] })
    expect(await resolveWindowsPackageManager('pnpx', node, home)).toEqual({ executable: native, prefixArgs: ['dlx'] })
  })

  it('supports pnpm 11+ Node wrappers when the native entry is absent', async () => {
    for (const command of ['pnpm', 'pnpx']) {
      const wrapper = await file(join(dirname(home), 'pnpm', 'bin', `${command}.mjs`))
      expect(await resolveWindowsPackageManager(command, node, home)).toEqual({ executable: node, prefixArgs: [wrapper] })
    }
  })

  it('keeps legacy pnpm installations and pnpx dlx working', async () => {
    const wrapper = await file(join(dirname(home), 'pnpm', 'bin', 'pnpm.cjs'))
    expect(await resolveWindowsPackageManager('pnpm', node, home)).toEqual({ executable: node, prefixArgs: [wrapper] })
    expect(await resolveWindowsPackageManager('pnpx', node, home)).toEqual({ executable: node, prefixArgs: [wrapper, 'dlx'] })
  })

  it('supports a standalone pnpm executable in PNPM_HOME', async () => {
    const native = await file(join(home, 'pnpm.exe'))
    expect(await resolveWindowsPackageManager('pnpm', node, home)).toEqual({ executable: native, prefixArgs: [] })
  })

  it('uses the Node installation before Corepack when PNPM_HOME is stale', async () => {
    const native = await file(join(dirname(node), 'node_modules', 'pnpm', 'pnpm.exe'))
    expect(await resolveWindowsPackageManager('pnpm', node, join(root, 'missing'))).toEqual({ executable: native, prefixArgs: [] })
  })

  it('preserves npm/npx resolution and Corepack as the final fallback', async () => {
    for (const command of ['npm', 'npx']) {
      const wrapper = await file(join(dirname(node), 'node_modules', 'npm', 'bin', `${command}-cli.js`))
      expect(await resolveWindowsPackageManager(command, node)).toEqual({ executable: node, prefixArgs: [wrapper] })
    }
    const corepack = join(dirname(node), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    expect(await resolveWindowsPackageManager('pnpm', node)).toEqual({ executable: node, prefixArgs: [corepack] })
    expect(await resolveWindowsPackageManager('git', node, home)).toBeUndefined()
  })
})
