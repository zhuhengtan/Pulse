import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeSandboxCommand } from '../packages/adapters/src/tools/shell.js'

it.runIf(process.platform === 'win32')('applies execution overrides after re-logon without replacing sandbox profile, temp or proxy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-child-env-'))
  try {
    const value = '雪 = ; $(Write-Error injected) "quote"\nnext line'
    const kept = { USERPROFILE: join(root, 'profile'), TEMP: join(root, 'tmp'), HTTPS_PROXY: 'http://sandbox-proxy.invalid:4321' }
    await Promise.all([mkdir(kept.USERPROFILE), mkdir(kept.TEMP)])
    const probe = 'process.stdout.write(JSON.stringify({config:process.env.pnpm_config_verify_deps_before_run,path:process.env.PATH,value:process.env.PULSE_ENV_PROBE,USERPROFILE:process.env.USERPROFILE,TEMP:process.env.TEMP,HTTPS_PROXY:process.env.HTTPS_PROXY}))'
    const command = encodeSandboxCommand(process.execPath, ['-e', probe], 'win32', {
      pnpm_config_verify_deps_before_run: 'false', PATH: 'C:\\trusted tools;C:\\workspace\\node_modules\\.bin', PULSE_ENV_PROBE: value,
    })
    // A fresh profile deliberately lacks the broker's pnpm/PATH overrides.
    const powershell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(powershell, command.split(' ').slice(1), {
      encoding: 'utf8', timeout: 15_000,
      env: { SystemRoot: process.env.SystemRoot, PATH: `${process.env.SystemRoot}\\System32`, ...kept },
    })
    expect(result.status, result.stderr).toBe(0)
    const received = JSON.parse(result.stdout)
    expect(received.config).toBe('false')
    expect(received.path).toBe('C:\\trusted tools;C:\\workspace\\node_modules\\.bin')
    expect(received.value).toBe(value)
    expect(received).toMatchObject(kept)
  } finally { await rm(root, { recursive: true, force: true }) }
})
