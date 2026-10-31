import { access, readFile, writeFile, mkdtemp, rm, stat, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPulseConfig, defaultPulseConfigPath, ensurePulseUserConfig, expandHome, loadPulseConfig, mergePulseConfigs, sanitizeWorkspaceConfig } from '../packages/cli/src/config.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { runSetup } from '../packages/cli/src/commands/setup.js'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ensurePulseUserConfig', () => {
  it('does not inherit workspace provider addresses or credentials into host plugin references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-plugin-host-'))
    temporaryDirectories.push(directory)
    const previousHome = process.env.PULSE_HOME
    process.env.PULSE_HOME = directory
    try {
      const workspace = join(directory, 'project'), path = join(directory, 'config.json')
      await mkdir(join(workspace, '.pulse'), { recursive: true })
      await writeFile(join(workspace, '.pulse/config.json'), JSON.stringify({ providers: { cloud: { provider: 'openai', baseURL: 'http://localhost:8999/untrusted', apiKeyEnv: 'UNTRUSTED_PLUGIN_KEY' } } }))
      await writeFile(path, JSON.stringify({
        providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } }, cloud: { provider: 'openai', models: { image: { modelCode: 'fixture-image', purposes: ['image'] } } } },
        activeModel: 'mock/mock', allowNetwork: true,
        builtinPlugins: { image_gen: { enabled: true, connection: { source: 'model', adapter: 'openai', modelRef: 'cloud/image' } } },
      }))
      const options = await hostOptions(parse(['--config', path, '--cwd', workspace, '--trust-workspace']))
      expect(options.builtinPluginConfig?.providers.cloud).not.toHaveProperty('baseURL')
      expect(options.builtinPluginConfig?.providers.cloud).not.toHaveProperty('apiKeyEnv')
      expect(options.builtinPluginConfigPath).toBe(path)
    } finally { if (previousHome === undefined) delete process.env.PULSE_HOME; else process.env.PULSE_HOME = previousHome }
  })
  it('applies explicit cost limits to the routed active model without changing other catalog entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-cost-limits-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify({ providers: { local: { provider: 'mock', models: {
      active: { modelCode: 'wire-active', maxContextTokens: 100000, maxOutputTokens: 64000, reasoningEffort: 'high' },
      other: { modelCode: 'wire-other', maxOutputTokens: 32000, reasoningEffort: 'high' },
    } } }, activeModel: 'local/active' }))
    const options = await hostOptions(parse(['--config', path, '--context-tokens', '32000', '--max-output-tokens', '4096', '--reasoning-effort', 'low']))
    const routing = createHostModelRouting({ activeModel: options.activeModel!, activeProviderCode: options.activeProviderCode!, activeProvider: options.provider!, providerProfiles: options.providerProfiles!, providerModels: options.providerModels! })
    expect(routing.candidates.find((c) => c.id === 'local/active')?.capabilities).toMatchObject({ maxContextTokens: 32000, maxOutputTokens: 4096, reasoning: 'low' })
    expect(routing.candidates.find((c) => c.id === 'local/other')?.capabilities).toMatchObject({ maxOutputTokens: 32000, reasoning: 'high' })
  })
  it('overlays one explicit plugin without disabling another inherited plugin', () => {
    const merged = mergePulseConfigs([
      { trust: 'user', value: { builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'inherited-model', credentialRef: 'credential-11111111-1111-4111-8111-111111111111', apiKeyEnv: 'IMAGE_KEY' } }, video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:10', model: 'inherited-video' } }, audio_gen: { enabled: true, modes: { speech: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:11', model: 'inherited-speech' }, music: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:11', model: 'inherited-music', apiKeyEnv: 'MUSIC_KEY' } } } } } },
      { trust: 'user', value: { builtinPlugins: { image_gen: { enabled: false } } } },
    ])
    expect(merged.builtinPlugins?.image_gen).toMatchObject({ enabled: false, connection: { baseURL: 'http://127.0.0.1:9', model: 'inherited-model', credentialRef: 'credential-11111111-1111-4111-8111-111111111111', apiKeyEnv: 'IMAGE_KEY' } })
    expect(merged.builtinPlugins?.video_gen).toMatchObject({ enabled: true, connection: { model: 'inherited-video' } })
    expect(merged.builtinPlugins?.audio_gen).toMatchObject({ enabled: true, modes: { speech: { model: 'inherited-speech' }, music: { model: 'inherited-music', apiKeyEnv: 'MUSIC_KEY' } } })
    const replaced = mergePulseConfigs([
      { trust: 'user', value: merged },
      { trust: 'user', value: { builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'cleared-image' } }, audio_gen: { enabled: true, modes: { speech: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:11', model: 'kept-speech' } } } } } },
    ])
    expect(replaced.builtinPlugins?.image_gen?.connection).not.toHaveProperty('credentialRef')
    expect(replaced.builtinPlugins?.image_gen?.connection).toMatchObject({ model: 'cleared-image' })
    expect(replaced.builtinPlugins?.audio_gen?.modes).not.toHaveProperty('music')
    expect(replaced.builtinPlugins?.audio_gen?.modes?.speech).toMatchObject({ model: 'kept-speech' })
    expect(replaced.builtinPlugins?.video_gen).toMatchObject({ enabled: true, connection: { model: 'inherited-video' } })
  })
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
      taskRouting: { plan: ['gpt5.6-b'], verify: ['gpt5.6-b'] },
    })}\n`)
    try {
      const options = await hostOptions(parse(['--config', path, '--max-model-calls', '48']))
      expect(options.activeModel).toBe('deepseek/gpt5.6-b')
      expect(options.activeProviderCode).toBe('deepseek')
      expect(options.provider).toMatchObject({ provider: 'deepseek', defaultModel: 'deepseek-chat' })
      expect(options.providerModels).toEqual({ 'deepseek/gpt5.6-b': { provider: 'deepseek', model: 'deepseek-chat' } })
      expect(options.taskRouting).toEqual({ plan: ['deepseek/gpt5.6-b'], verify: ['deepseek/gpt5.6-b'] })
      expect(options.maxModelCalls).toBe(48)
      expect(options).not.toHaveProperty('executionMode')
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })

  it('allows duplicate model names across providers and requires a qualified selection when ambiguous', async () => {
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
      await expect(hostOptions(parse(['--config', path, '--model', 'same']))).rejects.toThrow('AMBIGUOUS_MODEL_REFERENCE:same:a/one,b/two')
      const options = await hostOptions(parse(['--config', path, '--model', 'b/two']))
      expect(options.activeModel).toBe('b/two')
      expect(options.providerModels).toMatchObject({ 'a/one': { provider: 'a', model: 'one' }, 'b/two': { provider: 'b', model: 'two' } })
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })

  it('resolves explicitly configured local and DeepSeek approval models from the provider catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-feature-models-'))
    temporaryDirectories.push(directory)
    const previousHome = process.env.PULSE_HOME
    process.env.PULSE_HOME = directory
    const path = join(directory, 'config.json')
    await writeFile(path, `${JSON.stringify({
      providers: {
        ollama: { provider: 'ollama', baseURL: 'http://127.0.0.1:11434', models: { 'qwen3.5:4b': { modelCode: 'qwen3.5:4b' } } },
        cloud: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', models: { reviewer: { modelCode: 'deepseek-chat' } } },
      },
      activeModel: 'cloud/reviewer',
      frontModel: { enabled: true, model: 'ollama/qwen3.5:4b' },
      approvalReview: { model: 'ollama/qwen3.5:4b' },
    })}\n`)
    try {
      const options = await hostOptions(parse(['--config', path]))
      expect(options.frontModel).toMatchObject({ enabled: true, provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434' })
      expect(options.approvalReview).toMatchObject({ provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30_000 })

      await writeFile(path, `${JSON.stringify({
        providers: { cloud: { provider: 'deepseek', models: { reviewer: { modelCode: 'deepseek-chat' } } } },
        activeModel: 'cloud/reviewer',
        approvalReview: { model: 'cloud/reviewer' },
      })}\n`)
      expect((await hostOptions(parse(['--config', path]))).approvalReview).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' })
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })

  it('rejects invalid model references instead of silently routing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-invalid-model-ref-'))
    temporaryDirectories.push(directory)
    const previousHome = process.env.PULSE_HOME
    process.env.PULSE_HOME = directory
    const path = join(directory, 'config.json')
    await writeFile(path, `${JSON.stringify({
      providers: { local: { provider: 'mock', models: { quick: { modelCode: 'mock' } } } },
      activeModel: 'local/quick',
      taskRouting: { plan: ['local/missing'] },
    })}\n`)
    try {
      await expect(hostOptions(parse(['--config', path]))).rejects.toThrow('UNKNOWN_MODEL_REFERENCE:local/missing')
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
      expect(options.enabledCapabilityPacks).toEqual(['builtin-skills', 'pdf', 'skills', 'browser'])
      expect(options.capabilityConfig).toEqual({ skills: ['review'] })
      expect(options.capabilityPacks?.map((pack) => pack.manifest.id)).toEqual(['builtin-skills', 'pdf', 'spreadsheet', 'docx', 'pptx', 'skills', 'browser'])
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
    }
  })

  it('strips workspace apiMode with and without trust while host Responses remains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-cli-api-mode-'))
    temporaryDirectories.push(root)
    const workspace = join(root, 'workspace'), hostPath = join(root, 'host.json'), home = join(root, 'home')
    await mkdir(join(workspace, '.pulse'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(workspace, '.pulse/config.json'), JSON.stringify({ hooks: { enabled: true, hash: 'workspace', directory: '/outside' }, lsp: { enabled: 'false', servers: { evil: { command: 'workspace-lsp', languages: { '.ts': 'typescript' }, root: '/etc' } } }, providers: {
      only: { provider: 'openai-compatible', apiMode: 'responses', responsesTransport: 'websocket', baseURL: 'http://127.0.0.1:9/v1', models: { m: { modelCode: 'only-model' } } },
      shared: { provider: 'openai-compatible', apiMode: 'responses', responsesTransport: 'websocket', baseURL: 'http://127.0.0.1:8/v1' },
    } }))
    await writeFile(hostPath, JSON.stringify({
      providers: {
        shared: { provider: 'openai-compatible', baseURL: 'http://127.0.0.1:8/v1', models: { model: { modelCode: 'shared-model' } } },
        explicit: { provider: 'openai-compatible', apiMode: 'responses', responsesTransport: 'websocket', baseURL: 'http://127.0.0.1:7/v1', models: { model: { modelCode: 'explicit-model' } } },
      },
      hooks: { enabled: false, hash: 'trusted', directory: '/trusted' },
      lsp: { enabled: true, servers: { mock: { command: 'trusted-lsp', languages: { '.ts': 'typescript' } } } },
      activeModel: 'shared/model', jarvis: { enabled: false },
    }))
    const keys = ['PULSE_HOME', 'PULSE_CONFIG', 'PULSE_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    process.env.PULSE_HOME = home
    delete process.env.PULSE_CONFIG
    process.env.PULSE_DATA_DIR = join(home, 'data')
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.APPDATA = join(home, 'AppData')
    process.env.LOCALAPPDATA = join(home, 'LocalAppData')
    process.env.XDG_CONFIG_HOME = join(home, 'xdg-config')
    process.env.XDG_DATA_HOME = join(home, 'xdg-data')
    try {
      for (const trust of [false, true]) {
        const loaded = await loadPulseConfig(workspace, hostPath, trust)
        expect(loaded.value.providers?.only).toMatchObject({ provider: 'openai-compatible' })
        expect(loaded.value.providers?.only?.apiMode).toBeUndefined()
        expect(loaded.value.providers?.only?.responsesTransport).toBeUndefined()
        expect(loaded.value.providers?.shared?.responsesTransport).toBeUndefined()
        expect(loaded.value.providers?.explicit?.responsesTransport).toBe('websocket')
        expect(loaded.value.providers?.shared?.apiMode).toBeUndefined()
        expect(loaded.value.providers?.explicit?.apiMode).toBe('responses')
        if (trust) expect(loaded.value.providers?.only?.baseURL).toBe('http://127.0.0.1:9/v1')
        else expect(loaded.value.providers?.only).not.toHaveProperty('baseURL')
        const args = ['--config', hostPath, '--cwd', workspace, ...(trust ? ['--trust-workspace'] : [])]
        const explicit = await hostOptions(parse([...args, '--model', 'explicit/model']))
        expect(explicit.hooks).toEqual({ enabled: false, hash: 'trusted', directory: '/trusted' })
        expect(loaded.value.hooks).toEqual(explicit.hooks)
        expect(explicit.lsp?.servers?.mock?.command).toBe('trusted-lsp')
        expect(explicit.lsp?.servers?.evil).toBeUndefined()
        expect(loaded.value.lsp?.servers?.mock?.command).toBe('trusted-lsp')
        expect(JSON.stringify(loaded.value.lsp ?? {})).not.toContain('workspace-lsp')
        expect(explicit.provider?.apiMode).toBe('responses')
        expect(explicit.provider?.responsesTransport).toBe('websocket')
        expect(explicit.providerProfiles?.only?.apiMode).toBeUndefined()
        expect(explicit.providerProfiles?.shared?.apiMode).toBeUndefined()
        expect(explicit.providerProfiles?.explicit?.apiMode).toBe('responses')
        expect((await hostOptions(parse([...args, '--model', 'shared/model']))).provider?.apiMode).toBeUndefined()
        const only = await hostOptions(parse([...args, '--model', 'only/m']))
        expect(only.provider?.apiMode).toBeUndefined()
        expect(only.provider?.provider).toBe('openai-compatible')
      }
    } finally {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('strips a workspace transport by itself, including invalid and non-Responses values, while host HTTP and WebSocket stay explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-cli-transport-only-'))
    temporaryDirectories.push(root)
    const workspace = join(root, 'workspace'), hostPath = join(root, 'host.json'), home = join(root, 'home')
    await mkdir(join(workspace, '.pulse'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(workspace, '.pulse/config.json'), JSON.stringify({ providers: {
      transportOnly: { provider: 'openai-compatible', responsesTransport: 'websocket', models: { m: { modelCode: 'transport-only' } } },
      invalid: { provider: 'openai-compatible', responsesTransport: 'not-a-transport', models: { m: { modelCode: 'invalid-model' } } },
      anthropic: { provider: 'anthropic', apiMode: 'responses', responsesTransport: 'websocket', models: { m: { modelCode: 'anthropic-model' } } },
      httpHost: { provider: 'openai-compatible', apiMode: 'responses', responsesTransport: 'websocket', baseURL: 'http://127.0.0.1:8/v1' },
      wsHost: { provider: 'openai-compatible', apiMode: 'chat-completions', responsesTransport: 'http', baseURL: 'http://127.0.0.1:7/v1' },
    } }))
    await writeFile(hostPath, JSON.stringify({
      providers: {
        httpHost: { provider: 'openai-compatible', apiMode: 'responses', responsesTransport: 'http', baseURL: 'http://127.0.0.1:8/v1', models: { model: { modelCode: 'http-model' } } },
        wsHost: { provider: 'openai-compatible', apiMode: 'responses', responsesTransport: 'websocket', baseURL: 'http://127.0.0.1:7/v1', models: { model: { modelCode: 'ws-model' } } },
      },
      activeModel: 'httpHost/model', jarvis: { enabled: false },
    }))
    const keys = ['PULSE_HOME', 'PULSE_CONFIG', 'PULSE_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    process.env.PULSE_HOME = home
    delete process.env.PULSE_CONFIG
    process.env.PULSE_DATA_DIR = join(home, 'data')
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.APPDATA = join(home, 'AppData')
    process.env.LOCALAPPDATA = join(home, 'LocalAppData')
    process.env.XDG_CONFIG_HOME = join(home, 'xdg-config')
    process.env.XDG_DATA_HOME = join(home, 'xdg-data')
    try {
      for (const trust of [false, true]) {
        const loaded = await loadPulseConfig(workspace, hostPath, trust)
        for (const id of ['transportOnly', 'invalid', 'anthropic'] as const) {
          expect(loaded.value.providers?.[id]?.apiMode).toBeUndefined()
          expect(loaded.value.providers?.[id]?.responsesTransport).toBeUndefined()
        }
        expect(loaded.value.providers?.httpHost?.responsesTransport).toBe('http')
        expect(loaded.value.providers?.httpHost?.apiMode).toBe('responses')
        expect(loaded.value.providers?.wsHost?.responsesTransport).toBe('websocket')
        expect(loaded.value.providers?.wsHost?.apiMode).toBe('responses')
        const args = ['--config', hostPath, '--cwd', workspace, ...(trust ? ['--trust-workspace'] : [])]
        expect((await hostOptions(parse([...args, '--model', 'httpHost/model']))).provider?.responsesTransport).toBe('http')
        expect((await hostOptions(parse([...args, '--model', 'wsHost/model']))).provider?.responsesTransport).toBe('websocket')
        const transportOnly = await hostOptions(parse([...args, '--model', 'transportOnly/m']))
        expect(transportOnly.provider?.apiMode).toBeUndefined()
        expect(transportOnly.provider?.responsesTransport).toBeUndefined()
        const invalid = await hostOptions(parse([...args, '--model', 'invalid/m']))
        expect(invalid.provider?.responsesTransport).toBeUndefined()
        const anthropic = await hostOptions(parse([...args, '--model', 'anthropic/m']))
        expect(anthropic.provider?.provider).toBe('anthropic')
        expect(anthropic.provider?.apiMode).toBeUndefined()
        expect(anthropic.provider?.responsesTransport).toBeUndefined()
      }
    } finally {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('rejects a non-boolean or root-overriding host lsp config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-cli-lsp-strict-'))
    temporaryDirectories.push(root)
    const previousHome = process.env.PULSE_HOME
    const previousConfig = process.env.PULSE_CONFIG
    process.env.PULSE_HOME = root
    delete process.env.PULSE_CONFIG
    const hostPath = join(root, 'host.json')
    try {
      await writeFile(hostPath, JSON.stringify({ hooks: { enabled: true, hash: 'workspace', directory: '/outside' }, lsp: { enabled: 'false', servers: { mock: { command: 'trusted-lsp', languages: { '.ts': 'typescript' } } } } }))
      await expect(loadPulseConfig(root, hostPath, true)).rejects.toThrow('LSP_CONFIG_INVALID')
      await writeFile(hostPath, JSON.stringify({ hooks: { enabled: false, hash: 'trusted', directory: '/trusted' },
      lsp: { enabled: true, servers: { mock: { command: 'trusted-lsp', languages: { '.ts': 'typescript' }, root: '/etc' } } } }))
      await expect(loadPulseConfig(root, hostPath, true)).rejects.toThrow('LSP_CONFIG_INVALID')
    } finally {
      if (previousHome === undefined) delete process.env.PULSE_HOME
      else process.env.PULSE_HOME = previousHome
      if (previousConfig === undefined) delete process.env.PULSE_CONFIG
      else process.env.PULSE_CONFIG = previousConfig
    }
  })
})
