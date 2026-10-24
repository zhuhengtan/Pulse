import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runShell } from '../packages/adapters/src/tools/shell.js'

it('runs a real pnpm exec with prepared dependencies without an implicit install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-pnpm-exec-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'owned-fixture', private: true, dependencies: { 'pulse-missing-fixture-package': '0.0.0' } }))
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\nverifyDepsBeforeRun: install\n')
    await mkdir(join(root, 'node_modules'))
    const marker = join(root, 'node_modules', 'retained.txt')
    await writeFile(marker, 'preserve prepared dependencies')
    await writeFile(join(root, 'probe.cjs'), "process.stdout.write('LOCAL_EXEC_OK')\n")
    const result = await runShell('pnpm', ['exec', 'node', 'probe.cjs'], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 30_000 })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('LOCAL_EXEC_OK')
    expect(result.stderr).not.toMatch(/installing dependencies|registry\.npmjs|REMOVE_MODULES/)
    expect(await readFile(marker, 'utf8')).toBe('preserve prepared dependencies')
  } finally { await rm(root, { recursive: true, force: true }) }
// Retain the command's 30-second deadline; Windows setup/cleanup is additional.
}, process.platform === 'win32' ? 240_000 : 45_000)
