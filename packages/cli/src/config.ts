import type { ModelRouteEntry, ReasoningEffort } from '@hunterzhu/pulse-server/model-settings'
import { mergeExecPolicies, workspaceExecPolicy, sourceExecPolicy, overlayBuiltinPlugins, readMergedHostConfig, parseLspConfig, type ModelDefinition } from '@hunterzhu/pulse-server'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export interface PulseCliProviderProfile {
  presetId?: string
  connectionVariant?: string
  credentialRef?: string
  /** Adapter/protocol id. The map key is the user-facing provider code. */
  provider: string
  /** Explicit OpenAI-family transport; omitted preserves Chat Completions. */
  apiMode?: 'chat-completions' | 'responses'
  responsesTransport?: 'http' | 'websocket'
  name?: string
  baseURL?: string
  apiKeyEnv?: string
  maxContextTokens?: number
  maxOutputTokens?: number
  imageInput?: 'supported' | 'unsupported' | 'unknown'
  reasoningEffort?: ReasoningEffort
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  /** Models served by this provider. The provider plus map key is the model identity. */
  models?: Record<string, Omit<PulseCliModel, 'provider'>>
}

export interface PulseCliModel extends ModelDefinition {
  /** Legacy flat-config field; nested models inherit their provider from the parent. */
  provider?: string
  /** Exact model identifier sent to the provider. */
  modelCode: string
  /** Globally unique name shown by the CLI and accepted by `/model`. */
  displayName?: string
  maxContextTokens?: number
  maxOutputTokens?: number
  imageInput?: 'supported' | 'unsupported' | 'unknown'
  reasoningEffort?: ReasoningEffort
  pricing?: { currency: string; inputPerMillion: number; outputPerMillion: number; version: string }
}

export type PulseModelTask = 'reason' | 'plan' | 'merge' | 'verify' | 'vision'

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
  browser?: import('@hunterzhu/pulse-server').AutomationConfig['browser']
  computer?: import('@hunterzhu/pulse-server').AutomationConfig['computer']
  /** IDs must be explicitly enabled; workspace config cannot enable host extensions. */
  enabled?: string[]
  /** Optional discovery allow-list of skill directory names; omitted discovers all. Bodies load only on invocation. */
  skills?: string[]
  /** Additional absolute roots explicitly trusted by the user for installed skills. */
  trustedSkillRoots?: string[]
  /** Host-level MCP processes; these are executable trusted configuration. */
  mcpServers?: Record<string, PulseCliMcpServer>
}

export interface PulseCliConfig {
  hooks?: import('@hunterzhu/pulse-server').HookConfig
  lsp?: import('@hunterzhu/pulse-server').LspConfig
  cwd?: string
  dataDir?: string
  systemPrompt?: string
  systemPromptFile?: string
  /** Named provider profiles. The map key is a stable provider code. */
  providers?: Record<string, PulseCliProviderProfile>
  /** @deprecated Legacy flat model catalog. New configs nest models under providers. */
  models?: Record<string, PulseCliModel>
  /** Active Pulse model reference, preferably providerId/modelId. */
  activeModel?: string
  /** Dedicated model for the persistent Pulse assistant chat; defaults to activeModel. */
  assistantModel?: string
  /** Ordered providerId/modelId references per task; later entries act as fallbacks. */
  taskRouting?: Partial<Record<PulseModelTask, ModelRouteEntry[]>>
  /** Quality review of new tasks; tool authorization remains independent. */
  qualityReviewEnabled?: boolean
  capabilities?: PulseCliCapabilities
  execPolicy?: import('@hunterzhu/pulse-server').ExecPolicyConfig
  approvalMode?: 'read-only' | 'ask' | 'auto'
  /** Current continuous controller; the old 'legacy' value is accepted as the same policy. */
  taskControllerPolicy?: 'legacy' | 'continuous'
  /** Host-owned, cross-process task admission limits for this OS user. */
  taskAdmission?: { maxRunning?: number; maxQueued?: number }
  maxTurns?: number
  /** Provider attempts allowed across one controlled work task; defaults to 256. */
  maxModelCalls?: number
  modelBudgetPolicy?: import('@hunterzhu/pulse-server').LocalHostOptions['modelBudgetPolicy']
  persistenceBackend?: 'json' | 'sqlite' | 'external-files'
  maxCostByCurrency?: Record<string, number>
  /** Optional wall-clock limit for one run. Unset means no overall deadline. */
  maxRuntimeMs?: number
  /** Percent of maxContextTokens that triggers automatic history compaction. Clamped to 1–90. */
  autoCompactPercent?: number
  /** Explicit network destinations; workspace configuration cannot grant these. */
  networkHosts?: string[]
  /** Host-owned search service; never accepted from workspace config. */
  builtinPlugins?: import('@hunterzhu/pulse-server').BuiltinPluginsConfig
  webSearch?: import('@hunterzhu/pulse-server').WebSearchConfig
  allowNetwork?: boolean
  jarvis?: PulseCliJarvisConfig
  frontModel?: {
    enabled?: boolean
    provider?: string
    model?: string
    baseURL?: string
    timeoutMs?: number
  }
  approvalReview?: {
    provider?: string
    model?: string
    baseURL?: string
    timeoutMs?: number
  }
}

export interface PulseCliJarvisConfig {
  protocol?: 'personal' | 'legacy'
  observationPolicy?: 'important' | 'explicit'
  /** Master switch to enable or disable Jarvis cognitive memory architecture. */
  enabled?: boolean
  /** Base URL of the running Jarvis server. Defaults to http://127.0.0.1:7330 */
  apiUrl?: string
  /** Optional bearer token if Jarvis requires auth. */
  token?: string
  /** Max token budget for dynamic context package built by Jarvis. Defaults to 4000. */
  contextTokenBudget?: number
  /** Whether to automatically record candidate memories upon task completion. Defaults to true. */
  autoCandidate?: boolean
  /** Allow an API URL that is not loopback. Defaults to false. */
  allowRemote?: boolean
}

export const defaultPulseConfig: PulseCliConfig = {
  providers: {
    mock: { provider: 'mock', name: 'Mock', models: { mock: { displayName: 'mock', modelCode: 'mock', maxContextTokens: 32_000, maxOutputTokens: 4_096, reasoningEffort: 'medium' } } },
    openai: {
      provider: 'openai-compatible',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      models: { 'gpt5.6-a': { displayName: 'gpt5.6-a', modelCode: 'gpt-5.6' } },
    },
    deepseek: {
      provider: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: { 'deepseek-chat': { displayName: 'deepseek-chat', modelCode: 'deepseek-chat' } },
    },
  },
  activeModel: 'mock/mock',
  approvalMode: 'ask',
  taskControllerPolicy: 'continuous',
  maxTurns: 32,
  maxModelCalls: 256,
  autoCompactPercent: 90,
  allowNetwork: false,
  jarvis: {
    enabled: false,
    apiUrl: 'http://127.0.0.1:7330',
    contextTokenBudget: 4_000,
    autoCandidate: true,
    allowRemote: false,
  },
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

/** Reject malformed limits rather than silently changing the host's capacity. */
export function parseTaskAdmission(value: unknown): PulseCliConfig['taskAdmission'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_TASK_ADMISSION_CONFIG')
  const input = value as Record<string, unknown>
  const result: NonNullable<PulseCliConfig['taskAdmission']> = {}
  for (const [key, min, max] of [['maxRunning', 1, 16], ['maxQueued', 0, 256]] as const) {
    const limit = input[key]
    if (limit === undefined) continue
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < min || limit > max) throw new Error(`INVALID_TASK_ADMISSION_LIMIT:${key}`)
    result[key] = limit
  }
  return result
}

/** Workspace files must not escalate approval, network, provider credentials, the system prompt, or the Jarvis endpoint. */
export function sanitizeWorkspaceConfig(value: PulseCliConfig): PulseCliConfig {
  const providers = value.providers === undefined ? undefined : Object.fromEntries(Object.entries(value.providers).flatMap(([name, profile]) => {
    const safe = {
      provider: profile.provider,
      ...(profile.name === undefined ? {} : { name: profile.name }),
      ...(profile.models === undefined ? {} : { models: Object.fromEntries(Object.entries(profile.models).flatMap(([modelId, model]) => model.modelCode ? [[modelId, {
        modelCode: model.modelCode,
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        ...(model.maxContextTokens === undefined ? {} : { maxContextTokens: model.maxContextTokens }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      }]] : [])) }),
    }
    return Object.keys(safe).length ? [[name, safe]] : []
  }))
  return {
    ...(value.execPolicy === undefined ? {} : { execPolicy: workspaceExecPolicy(value.execPolicy) }),
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
          ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
          ...(model.maxContextTokens === undefined ? {} : { maxContextTokens: model.maxContextTokens }),
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        }]]
      })),
    }),
  }
}

export function mergePulseConfigs(layers: Array<{ value: PulseCliConfig; trust: 'workspace' | 'user'; source?: string }>): PulseCliConfig {
  let merged: PulseCliConfig = {}
  for (const layer of layers) {
    const value = { ...(layer.trust === 'workspace' ? sanitizeWorkspaceConfig(layer.value) : layer.value) }
    if (value.execPolicy !== undefined) value.execPolicy = sourceExecPolicy(value.execPolicy, layer.source ?? layer.trust)
    const providers = { ...(merged.providers ?? {}) }
    for (const [providerId, profile] of Object.entries(value.providers ?? {})) {
      const previous = providers[providerId]
      providers[providerId] = {
        ...previous,
        ...profile,
        ...(previous?.models === undefined && profile.models === undefined ? {} : { models: { ...previous?.models, ...profile.models } }),
      }
    }
    const execPolicy = merged.execPolicy === undefined && value.execPolicy === undefined ? undefined : mergeExecPolicies(merged.execPolicy, value.execPolicy)
    const builtinPlugins = overlayBuiltinPlugins(merged.builtinPlugins, value.builtinPlugins)
    merged = {
      ...merged,
      ...value,
      ...(merged.providers === undefined && value.providers === undefined ? {} : { providers }),
      ...(merged.models === undefined && value.models === undefined ? {} : { models: { ...merged.models, ...value.models } }),
      ...(builtinPlugins ? { builtinPlugins } : {}),
      ...(execPolicy ? { execPolicy } : {}),
    }
  }
  if (merged.taskAdmission !== undefined) merged.taskAdmission = parseTaskAdmission(merged.taskAdmission)!
  return merged
}

export async function loadPulseConfig(cwd: string, explicitPath?: string, trustWorkspace = false, scope: 'all' | 'host' = 'all'): Promise<{ value: PulseCliConfig; source?: string }> {
  if (scope === 'host') {
    const read = readMergedHostConfig(explicitPath)
    const value = read.config as PulseCliConfig
    if (value.taskAdmission !== undefined) value.taskAdmission = parseTaskAdmission(value.taskAdmission)!
    if (value.lsp !== undefined) value.lsp = parseLspConfig(value.lsp)
    return { value, ...(read.source ? { source: read.source } : {}) }
  }
  const workspacePath = join(cwd, '.pulse', 'config.json')
  const homePath = defaultPulseConfigPath()
  const envPath = expandHome(process.env.PULSE_CONFIG)
  const layers: Array<{ value: PulseCliConfig; trust: 'workspace' | 'user'; source: string }> = []
  const seenPolicySources = new Set<string>()
  for (const [path, trust, workspaceLayer] of [
    [workspacePath, trustWorkspace ? 'user' : 'workspace', true],
    [homePath, 'user', false],
    [envPath, 'user', false],
    [explicitPath, 'user', false],
  ] as const) {
    if (!path) continue
    const sourceKey = `${resolve(path)}:${workspaceLayer ? 'workspace' : 'host'}`
    if (seenPolicySources.has(sourceKey)) continue
    seenPolicySources.add(sourceKey)
    try {
      const parsed = asConfig(JSON.parse(await readFile(path, 'utf8')))
      if (!parsed) throw new Error('CONFIG_OBJECT_REQUIRED')
      if (parsed) {
        // Search endpoints and credentials are host-owned even when other workspace fields are trusted.
        // Provider protocol stays host-owned. Trusted workspace fields may remain, but apiMode and responsesTransport never do.
        if (workspaceLayer) {
          delete parsed.taskAdmission
          delete parsed.hooks
          delete parsed.lsp
          delete parsed.webSearch
          delete parsed.builtinPlugins
          if (parsed.execPolicy !== undefined) parsed.execPolicy = workspaceExecPolicy(parsed.execPolicy)
          if (parsed.providers) parsed.providers = Object.fromEntries(Object.entries(parsed.providers).map(([id, profile]) => {
            const next = { ...profile }
            delete next.apiMode
            delete next.responsesTransport
            return [id, next]
          }))
        } else if (parsed.lsp !== undefined) parsed.lsp = parseLspConfig(parsed.lsp)
        layers.push({ value: parsed, trust, source: path })
      }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
  }
  return { value: mergePulseConfigs(layers), ...(layers.at(-1) === undefined ? {} : { source: layers.at(-1)!.source }) }
}
