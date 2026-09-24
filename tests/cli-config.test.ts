import { access, readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPulseConfig, defaultPulseConfigPath, ensurePulseUserConfig, expandHome, sanitizeWorkspaceConfig } from '../packages/cli/src/config.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { runSetup } from '../packages/cli/src/commands/setup.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ensurePulseUserConfig', () => {
  it('uses PULSE_HOME for the user configuration root', () => {
    const previous = process.env.PULSE_HOME
    try {
      process.env.PULSE_HOME = join(tmpdir(), 'pulse-config-home-test')
      expect(defaultPulseConfigPath()).toBe(resolve(join(tmpdir(), 'pulse-config-home-test', 'config.json')))
    } finally {
      if (previous === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previous
    }
  })

  it('expands a home-relative path using the current platform separator', () => {
    const separator = sep === '\\' ? '\\' : '/'
    expect(expandHome(`~${separator}Documents${separator}Pulse`)).toBe(join(homedir(), 'Documents', 'Pulse'))
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

  it('treats --config as a file path and writes the runtime config schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-setup-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'nested', 'config.json')

    await expect(runSetup(false, path)).resolves.toBe(0)

    await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(defaultPulseConfig, null, 2)}\n`)
    await expect(stat(join(directory, 'nested'))).resolves.toMatchObject({ mode: expect.any(Number) })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(access(`${path}/config.json`)).rejects.toThrow()
  })

  it('resolves a unique Pulse model name to its provider and wire model code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-model-map-'))
    temporaryDirectories.push(directory)
    const previousHome = process.env.PULSE_HOME
    process.env.PULSE_HOME = directory
    const path = join(directory, 'config.json')
    await writeFile(path, `${JSON.stringify({
      providers: {
        deepseek: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      },
      models: {
        'gpt5.6-b': { displayName: 'gpt5.6-b', provider: 'deepseek', modelCode: 'deepseek-chat' },
      },
      activeModel: 'gpt5.6-b',
      executionMode: 'parallel-read',
      taskRouting: { plan: ['gpt5.6-b'], verify: ['gpt5.6-b'] },
    })}\n`)
    try {
      const options = await hostOptions(parse(['--config', path]))
      expect(options.activeModel).toBe('gpt5.6-b')
      expect(options.activeProviderCode).toBe('deepseek')
      expect(options.provider).toMatchObject({ provider: 'deepseek', defaultModel: 'deepseek-chat' })
      expect(options.providerModels).toEqual({ 'gpt5.6-b': { provider: 'deepseek', model: 'deepseek-chat' } })
      expect(options.taskRouting).toEqual({ plan: ['gpt5.6-b'], verify: ['gpt5.6-b'] })
      expect(options.executionMode).toBe('parallel-read')
      await expect(hostOptions(parse(['--config', path, '--execution-mode', 'serial']))).resolves.toMatchObject({ executionMode: 'serial' })
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })

  it('rejects duplicate model display names across providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-model-duplicate-'))
    temporaryDirectories.push(directory)
    const previousHome = process.env.PULSE_HOME
    process.env.PULSE_HOME = directory
    const path = join(directory, 'config.json')
    await writeFile(path, `${JSON.stringify({
      providers: { a: { provider: 'a' }, b: { provider: 'b' } },
      models: {
        one: { displayName: 'same', provider: 'a', modelCode: 'one' },
        two: { displayName: 'same', provider: 'b', modelCode: 'two' },
      },
    })}\n`)
    try {
      await expect(hostOptions(parse(['--config', path, '--model', 'same']))).rejects.toThrow('DUPLICATE_MODEL_DISPLAY_NAME:same')
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })

  it('does not allow workspace files to launch MCP processes or enable host capabilities', () => {
    const sanitized = sanitizeWorkspaceConfig({
      capabilities: { enabled: ['browser'], skills: ['untrusted'], mcpServers: { browser: { command: 'malicious-command' } } },
      taskRouting: { plan: ['cloud-model'] },
      allowNetwork: true,
    })
    expect(sanitized).not.toHaveProperty('capabilities')
    expect(sanitized).not.toHaveProperty('taskRouting')
    expect(sanitized).not.toHaveProperty('allowNetwork')
  })

  it('builds explicit user-configured document, skill, and MCP capability packs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-capability-config-'))
    temporaryDirectories.push(directory)
    const previousHome = process.env.PULSE_HOME
    process.env.PULSE_HOME = directory
    const path = join(directory, 'config.json')
    await writeFile(path, `${JSON.stringify({
      providers: { mock: { provider: 'mock' } },
      models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } },
      activeModel: 'mock',
      capabilities: { enabled: ['pdf', 'skills', 'browser'], skills: ['review'], mcpServers: { browser: { command: 'node', args: ['browser-server.js'] } } },
    })}\n`)
    try {
      const options = await hostOptions(parse(['--config', path]))
      expect(options.enabledCapabilityPacks).toEqual(['pdf', 'skills', 'browser'])
      expect(options.capabilityConfig).toEqual({ skills: ['review'] })
      expect(options.capabilityPacks?.map((pack) => pack.manifest.id)).toEqual(['pdf', 'spreadsheet', 'skills', 'browser'])
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })
})
