import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeSandboxCommand } from '../packages/adapters/src/tools/shell.js'
import { windowsShellEnvironment } from '../packages/adapters/src/tools/windows-shell-environment.js'

function environment(argv: string[]): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (let index = 0; index < argv.indexOf('--'); index++) {
    if (argv[index] !== '--env') continue
    const entry = argv[++index]!, equals = entry.indexOf('=')
    entries.push([entry.slice(0, equals).toUpperCase(), entry.slice(equals + 1)])
  }
  return Object.fromEntries(entries)
}

it('replaces case-insensitive duplicate overrides while preserving isolation, proxy and literal values', () => {
  const tail = ['--', 'cmd.exe', '/d', '/s', '/c', 'fixed command']
  const argv = ['srt.exe', 'exec', '--quiet', '--env', 'Path=stale', '--env', 'PATH=duplicate', '--env', 'HTTPS_PROXY=kept', '--env', 'TEMP=isolated', '--env', 'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=install', ...tail]
  const original = [...argv], literal = '雪 = ; $(Write-Error injected) "quote"\nnext line'
  const result = windowsShellEnvironment(argv, { PATH: 'first', Path: literal, pnpm_config_verify_deps_before_run: 'false' })
  expect(environment(result)).toEqual({ HTTPS_PROXY: 'kept', TEMP: 'isolated', PATH: literal, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' })
  expect(result.filter(value => /^path=/i.test(value))).toHaveLength(1)
  expect(result.filter(value => /^pnpm_config_verify_deps_before_run=/i.test(value))).toHaveLength(1)
  expect(result.slice(result.indexOf('--'))).toEqual(tail)
  expect(argv).toEqual(original)
})

it('keeps a long PATH out of the cmd.exe text and rejects oversized encoded commands', () => {
  const command = encodeSandboxCommand('node.exe', ['--version'], 'win32')
  const path = Array.from({ length: 240 }, (_, index) => `C:\\fixture\\tools-${index}`).join(';')
  const result = windowsShellEnvironment(['srt.exe', 'exec', '--env', 'PATH=stale', '--', 'cmd.exe', '/c', command], { PATH: path })
  expect(environment(result).PATH).toBe(path)
  expect(result.at(-1)).toBe(command)
  expect(command.length).toBeLessThan(8_000)
  expect(() => encodeSandboxCommand('node.exe', ['-e', 'x'.repeat(5_000)], 'win32')).toThrow('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
})

it('fails closed on malformed descriptors, environment keys, NULs and native argv overflow', () => {
  for (const argv of [['srt.exe', 'exec'], ['srt.exe', 'exec', '--'], ['srt.exe', '--env', '--', 'cmd.exe'], ['srt.exe', '--env', 'missing-equals', '--', 'cmd.exe']]) {
    expect(() => windowsShellEnvironment(argv, {})).toThrow('INVALID_WINDOWS_SANDBOX_COMMAND')
  }
  const argv = ['srt.exe', 'exec', '--', 'cmd.exe', '/c', 'fixed']
  expect(() => windowsShellEnvironment(argv, { 'BAD=KEY': 'value' })).toThrow('INVALID_SHELL_ENVIRONMENT')
  expect(() => windowsShellEnvironment(argv, { PATH: 'bad\0value' })).toThrow('INVALID_SHELL_ENVIRONMENT')
  expect(() => windowsShellEnvironment(argv, { PATH: 'x'.repeat(30_000) })).toThrow('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
})

it.runIf(process.platform === 'win32')('runs the real cmd.exe and PowerShell child with long PATH overrides and an isolated profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-child-env-'))
  try {
    const value = '雪 = ; $(Write-Error injected) "quote"\nnext line'
    const kept = { USERPROFILE: join(root, 'profile'), TEMP: join(root, 'tmp'), HTTPS_PROXY: 'http://sandbox-proxy.invalid:4321' }
    await Promise.all([mkdir(kept.USERPROFILE), mkdir(kept.TEMP)])
    const probe = 'process.stdout.write(JSON.stringify({config:process.env.pnpm_config_verify_deps_before_run,path:process.env.PATH,value:process.env.PULSE_ENV_PROBE,USERPROFILE:process.env.USERPROFILE,TEMP:process.env.TEMP,HTTPS_PROXY:process.env.HTTPS_PROXY}))'
    const command = encodeSandboxCommand(process.execPath, ['-e', probe], 'win32')
    const path = [join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0'), ...Array.from({ length: 240 }, (_, index) => `C:\\fixture\\tools-${index}`)].join(';')
    const cmd = join(process.env.SystemRoot!, 'System32', 'cmd.exe')
    const descriptor = windowsShellEnvironment(['srt.exe', 'exec', '--env', 'Path=stale', '--env', `HTTPS_PROXY=${kept.HTTPS_PROXY}`, '--', cmd, '/d', '/s', '/c', command], {
      pnpm_config_verify_deps_before_run: 'false', PATH: path, PULSE_ENV_PROBE: value,
    })
    // Model SRT's fresh profile and --env overlay, then run its actual inner
    // cmd.exe/PowerShell chain. The real SRT boundary is covered by pnpm exec.
    const result = spawnSync(cmd, ['/d', '/s', '/c', `"${command}"`], {
      encoding: 'utf8', timeout: 15_000, windowsVerbatimArguments: true,
      env: { SystemRoot: process.env.SystemRoot, ...kept, ...environment(descriptor) },
    })
    expect(result.status, result.stderr).toBe(0)
    const received = JSON.parse(result.stdout)
    expect(received.config).toBe('false')
    expect(received.path).toBe(path)
    expect(received.value).toBe(value)
    expect(received).toMatchObject(kept)
  } finally { await rm(root, { recursive: true, force: true }) }
})
