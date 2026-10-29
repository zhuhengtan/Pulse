import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { resolveModelSelection, type ModelConfig } from '../model-config.js'
import { pulseHomePath } from '../paths.js'
import { resolveProviderApiKey } from '../providers/credentials.js'

export const pluginIds = ['web_search', 'image_gen', 'video_gen', 'audio_gen'] as const
export type PluginId = typeof pluginIds[number]
export const mediaKinds = ['image', 'video', 'speech', 'music', 'sound'] as const
export type MediaKind = typeof mediaKinds[number]
export const adapters = ['openai', 'openai-compatible', 'google', 'bailian', 'volcengine', 'minimax', 'elevenlabs', 'comfyui', 'custom'] as const
export const adapterKinds: Record<typeof adapters[number], readonly MediaKind[]> = {
  openai: ['image', 'video', 'speech'], 'openai-compatible': ['image', 'speech'],
  google: ['image', 'video', 'speech', 'music'], bailian: ['image', 'video', 'speech'],
  volcengine: ['image', 'video'], minimax: ['image', 'video', 'speech', 'music'],
  elevenlabs: ['speech', 'music', 'sound'], comfyui: mediaKinds, custom: mediaKinds,
}
const mapping = z.object({ node: z.string().min(1), input: z.string().min(1) }).strict()
const connectionSchema = z.object({
  source: z.enum(['model', 'standalone']).default('standalone'),
  adapter: z.enum(adapters),
  modelRef: z.string().max(500).optional(),
  model: z.string().max(500).optional(),
  baseURL: z.string().max(2000).optional(),
  credentialRef: z.string().regex(/^credential-[a-f0-9-]{36}$/).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  /** Official OpenAI speech only. speech is POST /audio/speech; realtime is the WebSocket. */
  speechTransport: z.enum(['speech', 'realtime']).optional(),
  defaults: z.record(z.unknown()).optional(),
  workflow: z.record(z.unknown()).optional(),
  mappings: z.object({ prompt: mapping, model: mapping.optional(), image: mapping.optional(), outputNode: z.string().min(1) }).strict().optional(),
}).strict()
const entrySchema = z.object({ enabled: z.boolean().default(false), connection: connectionSchema.optional() }).strict()
const schema = z.object({
  web_search: z.object({ enabled: z.boolean() }).strict().optional(),
  image_gen: entrySchema.optional(), video_gen: entrySchema.optional(),
  audio_gen: z.object({ enabled: z.boolean().default(false), modes: z.object({ speech: connectionSchema.optional(), music: connectionSchema.optional(), sound: connectionSchema.optional() }).strict().optional() }).strict().optional(),
}).strict()
export type MediaConnection = z.infer<typeof connectionSchema>
export type BuiltinPluginsConfig = z.infer<typeof schema>
export type PluginHostConfig = ModelConfig & { builtinPlugins?: BuiltinPluginsConfig | undefined; allowNetwork?: boolean | undefined }
export type ResolvedConnection = MediaConnection & { model: string; baseURL: string; apiKey?: string | undefined; credentialProvider?: string | undefined }

const MAX_HOST_CONFIG_BYTES = 4_000_000

function expandHome(path: string): string {
  return path === '~' || path === `~${sep}` ? homedir() : path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\')) ? join(homedir(), path.slice(2)) : path
}

/** Home, then PULSE_CONFIG, then the explicit file. A workspace config is never included. */
export function hostOwnedConfigPaths(explicitPath?: string): string[] {
  const paths = [join(pulseHomePath(), 'config.json')]
  if (process.env.PULSE_CONFIG) paths.push(resolve(expandHome(process.env.PULSE_CONFIG)))
  if (explicitPath) paths.push(resolve(expandHome(explicitPath)))
  return [...new Set(paths)]
}

export function mergeHostRecords(layers: Array<Record<string, any>>): Record<string, any> {
  let merged: Record<string, any> = {}
  for (const value of layers) {
    const providers = { ...(merged.providers ?? {}) }
    for (const [providerId, profile] of Object.entries(value.providers ?? {}) as Array<[string, any]>) {
      const previous = providers[providerId]
      providers[providerId] = { ...previous, ...profile, ...(previous?.models === undefined && profile?.models === undefined ? {} : { models: { ...previous?.models, ...profile?.models } }) }
    }
    const builtinPlugins = overlayPlugins(merged.builtinPlugins, value.builtinPlugins)
    const webSearch = merged.webSearch || value.webSearch ? { ...(merged.webSearch ?? {}), ...(value.webSearch ?? {}) } : undefined
    merged = { ...merged, ...value, ...(merged.providers === undefined && value.providers === undefined ? {} : { providers }), ...(merged.models === undefined && value.models === undefined ? {} : { models: { ...merged.models, ...value.models } }), ...(builtinPlugins ? { builtinPlugins } : {}), ...(webSearch ? { webSearch } : {}) }
  }
  return merged
}
/** Per-plugin overlay. A later layer replaces only the plugin ids it names. An omitted connection or modes object stays; a present one replaces it. */
export function overlayBuiltinPlugins(previous: unknown, next: unknown): any {
  return overlayPlugins(previous, next)
}
function overlayPlugins(previous: any, next: any): any {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return previous
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next
  const merged: Record<string, any> = { ...previous }
  for (const [id, entry] of Object.entries(next)) merged[id] = overlayPluginEntry(previous[id], entry)
  return merged
}
function overlayPluginEntry(previous: any, next: any): any {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next
  return { ...previous, ...next }
}

export interface HostConfigRead { config: Record<string, any>; source?: string; explicitInvalid: boolean; explicitMissing: boolean; layerCount: number }

function readConfigObject(path: string): Record<string, any> | 'missing' | 'invalid' {
  try {
    const text = readFileSync(path, 'utf8')
    if (Buffer.byteLength(text) > MAX_HOST_CONFIG_BYTES) return 'invalid'
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
    return value as Record<string, any>
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' }
}

/** Live host-owned layers. explicitContents replaces the explicit file before it is committed. Invalid files are skipped. */
export function readMergedHostConfig(explicitPath?: string, explicitContents?: Record<string, unknown>): HostConfigRead {
  const explicit = explicitPath ? resolve(expandHome(explicitPath)) : undefined
  const layers: Array<Record<string, any>> = []
  let source: string | undefined, explicitInvalid = false, explicitMissing = false
  for (const path of hostOwnedConfigPaths(explicitPath)) {
    if (explicit && path === explicit && explicitContents) {
      if (typeof explicitContents !== 'object' || Array.isArray(explicitContents)) { explicitInvalid = true; continue }
      layers.push(explicitContents); source = path; continue
    }
    const parsed = readConfigObject(path)
    if (parsed === 'missing') { if (path === explicit) explicitMissing = true; continue }
    if (parsed === 'invalid') { if (path === explicit) explicitInvalid = true; continue }
    layers.push(parsed); source = path
  }
  return { config: mergeHostRecords(layers), ...(source ? { source } : {}), explicitInvalid, explicitMissing, layerCount: layers.length }
}

export type HostFieldSource = 'explicit' | 'inherited' | 'default' | 'launch'
export interface HostSurface {
  allowNetwork: boolean
  allowNetworkSource: HostFieldSource
  builtinPlugins: BuiltinPluginsConfig
  pluginSources: Partial<Record<PluginId, HostFieldSource>>
  webSearch?: Record<string, unknown>
  webSearchSource: HostFieldSource
}
/** Effective host-only plugin, search and network values, with the layer that currently owns each one. */
export function readHostSurface(explicitPath?: string, launchOverride?: boolean): HostSurface {
  const read = readMergedHostConfig(explicitPath)
  if (read.explicitInvalid) return { allowNetwork: false, allowNetworkSource: 'explicit', builtinPlugins: {}, pluginSources: {}, webSearchSource: 'default' }
  const explicit = explicitPath ? resolve(expandHome(explicitPath)) : undefined
  const layers = hostOwnedConfigPaths(explicitPath).map(path => ({ path, value: readConfigObject(path) })).filter((layer): layer is { path: string; value: Record<string, any> } => layer.value !== 'missing' && layer.value !== 'invalid')
  const role = (path: string): HostFieldSource => path === explicit ? 'explicit' : 'inherited'
  const sourceOf = (has: (value: Record<string, any>) => boolean): HostFieldSource => {
    const found = [...layers].reverse().find(layer => has(layer.value))
    return found ? role(found.path) : 'default'
  }
  const config = read.config
  const webSearch = config.webSearch && typeof config.webSearch === 'object' && !Array.isArray(config.webSearch) ? { ...config.webSearch } : undefined
  if (webSearch) { delete webSearch.token; delete webSearch.apiKey }
  return {
    allowNetwork: launchOverride ?? config.allowNetwork === true,
    allowNetworkSource: launchOverride === undefined ? sourceOf(value => Object.hasOwn(value, 'allowNetwork')) : 'launch',
    builtinPlugins: (config.builtinPlugins ?? {}) as BuiltinPluginsConfig,
    pluginSources: Object.fromEntries(pluginIds.map(id => [id, sourceOf(value => Boolean(value.builtinPlugins) && typeof value.builtinPlugins === 'object' && Object.hasOwn(value.builtinPlugins, id))])),
    ...(webSearch ? { webSearch } : {}),
    webSearchSource: sourceOf(value => Object.hasOwn(value, 'webSearch')),
  }
}

/** Provider preset `custom` is an OpenAI-compatible chat endpoint, not the media JSON protocol. */
export function mediaAdapterForProvider(provider: { provider?: string | undefined; presetId?: string | undefined } | undefined, fallback: MediaConnection['adapter']): MediaConnection['adapter'] {
  const protocol = provider?.provider
  if (protocol === 'gemini') return 'google'
  if (protocol === 'openai') return 'openai'
  if (protocol === 'openai-compatible' || provider?.presetId === 'custom') return 'openai-compatible'
  if (protocol && (adapters as readonly string[]).includes(protocol) && protocol !== 'custom') return protocol as MediaConnection['adapter']
  if (protocol && protocol !== 'custom') return 'openai-compatible'
  return fallback
}

export function pluginFor(kind: MediaKind): PluginId { return kind === 'image' ? 'image_gen' : kind === 'video' ? 'video_gen' : 'audio_gen' }
export function pluginEnabled(config: PluginHostConfig, id: PluginId): boolean {
  return config.allowNetwork === true && (id === 'web_search' ? config.builtinPlugins?.web_search?.enabled !== false : config.builtinPlugins?.[id]?.enabled === true)
}
export function serviceURL(raw: string): URL {
  try { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(); return u }
  catch { throw new Error('PLUGIN_URL_INVALID') }
}
export function connections(config: BuiltinPluginsConfig): Array<{ kind: MediaKind; connection: MediaConnection }> {
  return [
    ...(config.image_gen?.connection ? [{ kind: 'image' as const, connection: config.image_gen.connection }] : []),
    ...(config.video_gen?.connection ? [{ kind: 'video' as const, connection: config.video_gen.connection }] : []),
    ...(['speech', 'music', 'sound'] as const).flatMap(kind => config.audio_gen?.modes?.[kind] ? [{ kind, connection: config.audio_gen.modes[kind]! }] : []),
  ]
}
export function parseBuiltinPlugins(value: unknown, models: ModelConfig = {}): BuiltinPluginsConfig | undefined {
  if (value === undefined) return undefined
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error('PLUGIN_CONFIG_INVALID')
  const config = parsed.data
  for (const { kind, connection: c } of connections(config)) {
    if (c.baseURL) serviceURL(c.baseURL)
    if (!adapterKinds[c.adapter].includes(kind)) throw new Error('PLUGIN_CAPABILITY_UNSUPPORTED')
    if (c.source === 'model' && c.modelRef) {
      const selected = resolveModelSelection(models, c.modelRef)
      if (!selected) throw new Error('PLUGIN_MODEL_REFERENCE_INVALID')
      if (!selected.model.purposes?.includes(kind)) throw new Error('PLUGIN_MODEL_PURPOSE_REQUIRED')
      if (/coding|plan/.test(selected.provider.connectionVariant ?? '')) throw new Error('PLUGIN_BILLING_VARIANT_UNSUPPORTED')
    }
    const enabled = config[pluginFor(kind)]?.enabled
    if (enabled && (c.source === 'model' ? !c.modelRef : !c.baseURL || !c.model)) throw new Error('PLUGIN_CONNECTION_REQUIRED')
    if (enabled && c.adapter === 'comfyui' && (!c.workflow || !c.mappings)) throw new Error('PLUGIN_WORKFLOW_REQUIRED')
  }
  if (config.image_gen?.enabled && !config.image_gen.connection || config.video_gen?.enabled && !config.video_gen.connection || config.audio_gen?.enabled && !Object.keys(config.audio_gen.modes ?? {}).length) throw new Error('PLUGIN_CONNECTION_REQUIRED')
  return config
}

/** Strip transient draft secrets before any config, backup, or validation file is written. */
export function pluginDraft(value: unknown): { config?: BuiltinPluginsConfig; tokens: Map<MediaKind, string> } {
  if (value === undefined) return { tokens: new Map() }
  const copy = structuredClone(value) as any, tokens = new Map<MediaKind, string>()
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('PLUGIN_CONFIG_INVALID')
  for (const [kind, c] of [['image', copy.image_gen?.connection], ['video', copy.video_gen?.connection], ...Object.entries(copy.audio_gen?.modes ?? {})] as Array<[MediaKind, any]>) {
    if (!c || typeof c !== 'object') continue
    if ('token' in c) {
      if (typeof c.token !== 'string' || c.token.length > 16384 || /[\r\n\0]/.test(c.token)) throw new Error('PLUGIN_TOKEN_INVALID')
      tokens.set(kind, c.token.trim()); delete c.token; delete c.credentialRef; delete c.apiKeyEnv
    }
  }
  return { config: copy, tokens }
}

function nativeBase(adapter: MediaConnection['adapter'], base: string): string {
  const u = serviceURL(base)
  if (adapter === 'google' && u.hostname === 'generativelanguage.googleapis.com') u.pathname = '/v1beta'
  if (adapter === 'bailian' && /(?:dashscope(?:-intl)?\.aliyuncs\.com|\.maas\.aliyuncs\.com)$/.test(u.hostname)) u.pathname = '/api/v1'
  if (adapter === 'minimax' && /(?:api\.minimax\.(?:io|cn)|api\.minimaxi\.com)$/.test(u.hostname)) u.pathname = '/v1'
  return u.href.replace(/\/$/, '')
}
export async function resolveConnection(config: PluginHostConfig, kind: MediaKind, configPath: string): Promise<ResolvedConnection> {
  const plugins = parseBuiltinPlugins(config.builtinPlugins, config)
  const found = connections(plugins ?? {}).find(item => item.kind === kind)?.connection
  if (!found) throw new Error('PLUGIN_MODE_NOT_CONFIGURED')
  let c = found
  let baseURL = c.baseURL, model = c.model
  let credentials: { provider?: string | undefined; credentialRef?: string | undefined; apiKeyEnv?: string | undefined } = c
  let credentialProvider: string | undefined
  if (c.source === 'model') {
    const selected = resolveModelSelection(config, c.modelRef ?? '')
    if (!selected) throw new Error('PLUGIN_MODEL_REFERENCE_INVALID')
    // The saved adapter is the protocol. Selecting a model only recommends one in the UI.
    baseURL ||= selected.provider.baseURL
    model = selected.model.modelCode
    credentials = selected.provider
    if (!credentials.credentialRef && !credentials.apiKeyEnv && credentials.provider && !['mock', 'ollama', 'ollama-remote'].includes(credentials.provider)) credentialProvider = credentials.provider
  }
  const nativeDefaults: Partial<Record<MediaConnection['adapter'], string>> = {
    openai: 'https://api.openai.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta',
    bailian: 'https://dashscope.aliyuncs.com/api/v1', volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
    minimax: 'https://api.minimax.io/v1', elevenlabs: 'https://api.elevenlabs.io/v1',
  }
  const providerDefaults: Partial<Record<string, string>> = { openai: nativeDefaults.openai, gemini: nativeDefaults.google, google: nativeDefaults.google, bailian: nativeDefaults.bailian, volcengine: nativeDefaults.volcengine, minimax: nativeDefaults.minimax, elevenlabs: nativeDefaults.elevenlabs }
  if (c.source === 'model') baseURL ||= nativeDefaults[c.adapter] ?? providerDefaults[credentials.provider ?? '']
  if (!baseURL || !model) throw new Error('PLUGIN_CONNECTION_REQUIRED')
  const keySource = { provider: credentialProvider ?? credentials.provider ?? 'builtin-plugin', ...(credentials.credentialRef ? { credentialRef: credentials.credentialRef } : {}), ...(credentials.apiKeyEnv ? { apiKeyEnv: credentials.apiKeyEnv } : {}) }
  const apiKey = credentials.credentialRef || credentials.apiKeyEnv || credentialProvider ? await resolveProviderApiKey(keySource, configPath) : undefined
  return { ...c, credentialRef: credentials.credentialRef, apiKeyEnv: credentials.apiKeyEnv, ...(credentialProvider ? { credentialProvider } : {}), baseURL: nativeBase(c.adapter, baseURL), model, ...(apiKey ? { apiKey } : {}) }
}
