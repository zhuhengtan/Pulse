import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export interface PulseCliProviderProfile {
  /** Adapter/protocol id. The map key is the user-facing provider code. */
  provider: string
  name?: string
  baseURL?: string
  apiKeyEnv?: string
  maxContextTokens?: number
  maxOutputTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
}

export interface PulseCliModel {
  /** Provider map key, not the adapter id. */
  provider: string
  /** Exact model identifier sent to the provider. */
  modelCode: string
  /** Globally unique name shown by the CLI and accepted by `/model`. */
  displayName: string
  maxContextTokens?: number
  maxOutputTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  pricing?: { currency: string; inputPerMillion: number; outputPerMillion: number; version: string }
}

export type PulseModelTask = 'reason' | 'plan' | 'merge' | 'verify'

export interface PulseCliMcpServer {
  command: string
  args?: string[]
  cwd?: string
  /** Explicit environment overrides; secret values should be sourced through provider-specific env mechanisms where possible. */
  env?: Record<string, string>
  /** Map child environment names to names of variables in Pulse's launch environment. */
  envFrom?: Record<string, string>
  timeoutMs?: number
  /** Explicit trust decision for each remote tool; all unspecified tools remain external. */
  toolPolicies?: Record<string, 'read' | 'write' | 'external'>
}

export interface PulseCliCapabilities {
  /** IDs must be explicitly enabled; workspace config cannot enable host extensions. */
  enabled?: string[]
  /** Names of host-installed skills to load as untrusted instructions. */
  skills?: string[]
  /** Additional absolute roots explicitly trusted by the user for installed skills. */
  trustedSkillRoots?: string[]
  /** Host-level MCP processes; these are executable trusted configuration. */
  mcpServers?: Record<string, PulseCliMcpServer>
}

export interface PulseCliConfig {
  cwd?: string
  dataDir?: string
  systemPrompt?: string
  systemPromptFile?: string
  /** Named provider profiles. The map key is a stable provider code. */
  providers?: Record<string, PulseCliProviderProfile>
  /** Globally unique Pulse model names mapped to provider/model codes. */
  models?: Record<string, PulseCliModel>
  /** Active Pulse model display name. */
  activeModel?: string
  /** Ordered model display names per task; later entries act as fallbacks. */
  taskRouting?: Partial<Record<PulseModelTask, string[]>>
  capabilities?: PulseCliCapabilities
  approvalMode?: 'read-only' | 'ask' | 'auto'
  /** Parallelism is opt-in and only exposes tools explicitly classified read-only. */
  executionMode?: 'serial' | 'parallel-read'
  maxTurns?: number
  /** Percent of maxContextTokens that triggers automatic history compaction. Clamped to 1–90. */
  autoCompactPercent?: number
  allowNetwork?: boolean
}

export const defaultPulseConfig: PulseCliConfig = {
  providers: {
    mock: { provider: 'mock', name: 'Mock' },
    openai: {
      provider: 'openai-compatible',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    },
    deepseek: {
      provider: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
  models: {
    mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock', maxContextTokens: 32_000, maxOutputTokens: 4_096, reasoningEffort: 'medium' },
    'gpt5.6-a': { displayName: 'gpt5.6-a', provider: 'openai', modelCode: 'gpt-5.6' },
    'deepseek-chat': { displayName: 'deepseek-chat', provider: 'deepseek', modelCode: 'deepseek-chat' },
  },
  activeModel: 'mock',
  approvalMode: 'ask',
  executionMode: 'serial',
  maxTurns: 32,
  autoCompactPercent: 90,
  allowNetwork: false,
}

export function defaultPulseConfigPath(): string {
  return join(defaultPulseHomePath(), 'config.json')
}

export function defaultPulseHomePath(): string {
  return resolve(process.env.PULSE_HOME ?? join(homedir(), '.pulse'))
}

/** Create the user config on first run without replacing an existing file. */
export async function ensurePulseUserConfig(path = defaultPulseConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await access(path)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await writeFile(path, `${JSON.stringify(defaultPulseConfig, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // Another process may have initialized the config between access and write.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await chmod(path, 0o600)
}

export function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return path === '~' || path === `~${sep}`
    ? homedir()
    : path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\'))
      ? join(homedir(), path.slice(2))
      : path
}

function asConfig(value: unknown): PulseCliConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as PulseCliConfig
}

/** Workspace files must not escalate approval, network, provider credentials, or the system prompt. */
export function sanitizeWorkspaceConfig(value: PulseCliConfig): PulseCliConfig {
  const providers = value.providers === undefined ? undefined : Object.fromEntries(Object.entries(value.providers).flatMap(([name, profile]) => {
    const safe = {
      provider: profile.provider,
      ...(profile.name === undefined ? {} : { name: profile.name }),
    }
    return Object.keys(safe).length ? [[name, safe]] : []
  }))
  return {
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.dataDir === undefined ? {} : { dataDir: value.dataDir }),
    // Workspace configs cannot launch processes, select host skills, or enable installed capabilities.
    ...(providers === undefined || Object.keys(providers).length === 0 ? {} : { providers }),
    ...(value.activeModel === undefined ? {} : { activeModel: value.activeModel }),
    // Workspace configs may select a model, but routing affects provider and
    // data-sharing choices and therefore remains user-config-only.
    ...(value.models === undefined ? {} : {
      models: Object.fromEntries(Object.entries(value.models).flatMap(([name, model]) => {
        if (!model.provider || !model.modelCode) return []
        return [[name, {
          provider: model.provider,
          modelCode: model.modelCode,
          displayName: model.displayName,
          ...(model.maxContextTokens === undefined ? {} : { maxContextTokens: model.maxContextTokens }),
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        }]]
      })),
    }),
  }
}

export function mergePulseConfigs(layers: Array<{ value: PulseCliConfig; trust: 'workspace' | 'user' }>): PulseCliConfig {
  let merged: PulseCliConfig = {}
  for (const layer of layers) {
    const value = layer.trust === 'workspace' ? sanitizeWorkspaceConfig(layer.value) : layer.value
    merged = {
      ...merged,
      ...value,
      ...(merged.providers === undefined && value.providers === undefined ? {} : { providers: { ...merged.providers, ...value.providers } }),
      ...(merged.models === undefined && value.models === undefined ? {} : { models: { ...merged.models, ...value.models } }),
    }
  }
  return merged
}

export async function loadPulseConfig(cwd: string, explicitPath?: string, trustWorkspace = false): Promise<{ value: PulseCliConfig; source?: string }> {
  const workspacePath = join(cwd, '.pulse', 'config.json')
  const homePath = defaultPulseConfigPath()
  const envPath = expandHome(process.env.PULSE_CONFIG)
  const layers: Array<{ value: PulseCliConfig; trust: 'workspace' | 'user'; source: string }> = []
  for (const [path, trust] of [
    [workspacePath, trustWorkspace ? 'user' : 'workspace'],
    [homePath, 'user'],
    [envPath, 'user'],
    [explicitPath, 'user'],
  ] as const) {
    if (!path) continue
    try {
      const parsed = asConfig(JSON.parse(await readFile(path, 'utf8')))
      if (parsed) layers.push({ value: parsed, trust, source: path })
    } catch { /* absent or invalid config is reported by doctor */ }
  }
  return { value: mergePulseConfigs(layers), ...(layers.at(-1) === undefined ? {} : { source: layers.at(-1)!.source }) }
}
