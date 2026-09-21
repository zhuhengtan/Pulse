import { access, readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPulseConfig, defaultPulseConfigPath, ensurePulseUserConfig } from '../packages/cli/src/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ensurePulseUserConfig', () => {
  it('uses PULSE_HOME for the user configuration root', () => {
    const previous = process.env.PULSE_HOME
    try {
      process.env.PULSE_HOME = '/tmp/pulse-config-home-test'
      expect(defaultPulseConfigPath()).toBe('/tmp/pulse-config-home-test/config.json')
    } finally {
      if (previous === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previous
    }
  })

  it('creates the parent .pulse directory and default config on first run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-config-'))
    temporaryDirectories.push(directory)
    const path = join(directory, '.pulse', 'config.json')

    await ensurePulseUserConfig(path)

    expect((await stat(join(directory, '.pulse'))).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(defaultPulseConfig)
  })

  it('does not overwrite an existing user configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-config-'))
    temporaryDirectories.push(directory)
    const path = join(directory, '.pulse', 'config.json')
    await ensurePulseUserConfig(path)
    const original = await readFile(path, 'utf8')

    await ensurePulseUserConfig(path)

    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(access(path)).resolves.toBeUndefined()
  })
})
