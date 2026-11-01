import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemTool, runShell } from '@hunterzhu/pulse-adapters'
describe('native filesystem and shell contracts', () => {
it('runs the installed development toolchain inside the sandbox by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse toolchain 雪-'))
    try {
      if (process.env.CI && process.platform === 'win32') expect(process.env.PNPM_HOME, 'CI must expose the pnpm setup shim directory').toBeTruthy()
      for (const [command, args] of [['node', ['--version']], ['pnpm', ['--version']], ['git', ['init', '--quiet']], ['git', ['status', '--porcelain']]] as const) {
        if (process.env.CI) console.info(`[sandbox toolchain] starting ${command} ${args.join(' ')}`)
        const result = await runShell(command, [...args], { cwd: root, timeoutMs: 30_000 })
        if (process.env.CI) console.info(`[sandbox toolchain] ${command} exited ${result.code}`)
        expect(result.code, `${command}; PNPM_HOME=${process.env.PNPM_HOME ?? '(unset)'}: ${result.stderr}`).toBe(0)
        if (command === 'pnpm' && process.env.PULSE_EXPECTED_PNPM_VERSION) expect(result.stdout.trim()).toBe(process.env.PULSE_EXPECTED_PNPM_VERSION)
        expect(result.stderr).not.toContain('Operation not permitted')
      }
      const child = await runShell('node', ['-e', 'const c=require("node:child_process").spawnSync("node",["--version"],{encoding:"utf8"});process.stdout.write(c.stdout||"");process.exit(c.status??1)'], { cwd: root })
      expect(child.code, child.stderr).toBe(0)
      expect(child.stdout).toMatch(/^v\d+/)
    } finally { await rm(root, { recursive: true, force: true }) }
  // Each Windows command provisions its own isolated ACL policy before the
  // child timeout starts. Five cold launches include policy restoration as well as child execution.
  // Hosted Windows runners measured 105–146 seconds per complete launch; keep
  // the five-command test bounded without cutting off its final initialization.
  }, process.platform === 'win32' ? 900_000 : 60_000)
})
