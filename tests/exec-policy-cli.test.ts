import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, parse } from '@hunterzhu/pulse-cli'

const directories: string[] = []
const originalArgv = process.argv
afterEach(async () => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function isolated(): Promise<{ home: string; cwd: string }> {
  const home = await mkdtemp(join(tmpdir(), 'pulse-policy-cli-'))
  directories.push(home)
  const cwd = join(home, 'workspace')
  await mkdir(cwd)
  for (const key of ['PULSE_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PULSE_DATA_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    const path = join(home, key.toLowerCase())
    await mkdir(path)
    vi.stubEnv(key, path)
  }
  vi.stubEnv('PULSE_CONFIG', join(home, 'missing-config.json'))
  return { home, cwd }
}

describe.sequential('execpolicy command', () => {
  it('parses execpolicy as a command instead of a task', () => {
    expect(parse(['execpolicy', 'check', '--', 'node', '--version'])).toMatchObject({ command: 'execpolicy', positionals: ['check', 'node', '--version'] })
    expect(parse(['execpolicy']).command).toBe('execpolicy')
  })

  it('prints a forbidden diagnosis and does not create a run or user config', async () => {
    const { cwd } = await isolated()
    const config = join(cwd, 'host.json')
    await writeFile(config, JSON.stringify({ execPolicy: { rules: [{ pattern: ['node'], decision: 'forbidden' }] } }))
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true })
    process.argv = [process.execPath, 'pulse', 'execpolicy', 'check', '--cwd', cwd, '--config', config, '--', 'node', '--version']
    expect(await main()).toBe(0)
    expect(JSON.parse(chunks.join('')).decision).toBe('forbidden')
    expect(await readdir(cwd)).toEqual(['host.json'])
    expect(await readdir(process.env.PULSE_HOME!)).toEqual([])
  })

  it.each([
    [['execpolicy']],
    [['execpolicy', 'check']],
    [['execpolicy', 'check', '--']],
    [['execpolicy', 'check', 'node', '--version']],
  ])('exits with usage when execpolicy argv is incomplete: %j', async (args: string[]) => {
    const argv = [process.execPath, 'pulse', ...args]
    process.argv = argv
    await isolated()
    process.argv = argv
    await expect(main()).rejects.toThrow('Usage: pulse execpolicy check')
  })

  it('rejects an illegal policy without writing the workspace', async () => {
    const { cwd } = await isolated()
    const config = join(cwd, 'host.json')
    await writeFile(config, '{"execPolicy":{"rules":[{"pattern":["node"],"decision":"allow","notMatch":[["node"]]}]}}')
    process.argv = [process.execPath, 'pulse', 'execpolicy', 'check', '--cwd', cwd, '--config', config, '--', 'node', '--version']
    await expect(main()).rejects.toThrow('EXEC_POLICY_NOT_MATCH_EXAMPLE_HIT')
    expect(await readdir(cwd)).toEqual(['host.json'])
  })
})
