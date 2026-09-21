import { access, readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPulseConfig, ensurePulseUserConfig } from '../packages/cli/src/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ensurePulseUserConfig', () => {
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
