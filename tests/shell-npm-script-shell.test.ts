import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { runShell } from '../packages/adapters/src/tools/shell.js'

it.runIf(process.platform === 'darwin').each(['default', 'workspace', 'environment'] as const)('runs npm lifecycle scripts across denied PATH shims and retains an explicit shell: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-npm-script-shell-'))
  const cwd = join(root, 'workspace'), denied = join(root, 'other', 'bin')
  try {
    await mkdir(cwd); await mkdir(denied, { recursive: true })
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node test.cjs' } }))
    await writeFile(join(cwd, 'test.cjs'), 'console.log("verified-fixture")\n')
    const hidden = join(denied, 'sh'), configured = join(cwd, 'configured-shell')
    await writeFile(hidden, '#!/bin/sh\necho unexpected-shell\nexit 77\n'); await chmod(hidden, 0o755)
    await writeFile(configured, '#!/bin/sh\necho configured-shell\nexec /bin/sh "$@"\n'); await chmod(configured, 0o755)
    if (mode === 'workspace') await writeFile(join(cwd, '.npmrc'), `script-shell=${configured}\n`)
    const env = { ...process.env, PATH: [denied, process.env.PATH].join(delimiter), ...(mode === 'environment' ? { NPM_CONFIG_SCRIPT_SHELL: configured } : {}) }
    const result = await runShell('npm', ['test'], { cwd, env })
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, timedOut: false, aborted: false })
    expect(result.stdout).toContain('verified-fixture')
    expect(result.stdout).not.toContain('unexpected-shell')
    expect(result.stdout.includes('configured-shell')).toBe(mode !== 'default')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15_000)
