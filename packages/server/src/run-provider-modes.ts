import type { ProviderApiMode, ProviderPresetConfig } from '@hunterzhu/pulse-adapters'

interface ModeOptions {
  provider?: ProviderPresetConfig
  activeProviderCode?: string
  providerProfiles?: Record<string, ProviderPresetConfig>
}
const compatible = (profile: ProviderPresetConfig) => ['openai', 'openai-compatible'].includes(profile.provider)
const mode = (value: unknown): ProviderApiMode => {
  if (value === 'responses' || value === 'chat-completions') return value
  throw new Error('PROVIDER_API_MODE_SNAPSHOT_INVALID')
}
const transport = (value: unknown): 'http' | 'websocket' => {
  if (value === 'http' || value === 'websocket') return value
  throw new Error('PROVIDER_TRANSPORT_SNAPSHOT_INVALID')
}

/** Only protocol choices, never endpoints or credentials, enter the run snapshot. */
export function captureProviderApiModes(options: ModeOptions) {
  const profiles = { ...options.providerProfiles }
  if (options.provider) profiles[options.activeProviderCode ?? options.provider.provider] = options.provider
  const entries = Object.entries(profiles).filter(([, profile]) => compatible(profile))
  const transports = Object.fromEntries(entries.filter(([, profile]) => profile.apiMode === 'responses' && profile.responsesTransport === 'websocket').map(([id]) => [id, 'websocket']))
  return {
    schemaVersion: 1,
    modes: Object.fromEntries(entries.map(([id, profile]) => [id, profile.apiMode ?? 'chat-completions'])),
    ...(Object.keys(transports).length ? { transports } : {}),
  }
}

/** Absent saved transport always means HTTP, never today's global WebSocket choice. */
export function restoreProviderApiModes<T extends ModeOptions>(options: T, saved: unknown): T {
  let modes: Record<string, unknown> = {}, transports: Record<string, unknown> = {}
  if (saved !== undefined) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('PROVIDER_API_MODE_SNAPSHOT_INVALID')
    const snapshot = saved as Record<string, unknown>
    if (snapshot.schemaVersion !== 1 || !snapshot.modes || typeof snapshot.modes !== 'object' || Array.isArray(snapshot.modes)) throw new Error('PROVIDER_API_MODE_SNAPSHOT_INVALID')
    modes = snapshot.modes as Record<string, unknown>
    for (const value of Object.values(modes)) mode(value)
    if (snapshot.transports !== undefined) {
      if (!snapshot.transports || typeof snapshot.transports !== 'object' || Array.isArray(snapshot.transports)) throw new Error('PROVIDER_TRANSPORT_SNAPSHOT_INVALID')
      transports = snapshot.transports as Record<string, unknown>
      for (const [id, value] of Object.entries(transports)) {
        transport(value)
        if (modes[id] !== 'responses') throw new Error('PROVIDER_TRANSPORT_SNAPSHOT_INVALID')
      }
    }
  }
  const apply = (id: string, profile: ProviderPresetConfig): ProviderPresetConfig => {
    if (!compatible(profile)) return profile
    const apiMode = Object.hasOwn(modes, id) ? mode(modes[id]) : 'chat-completions'
    const responsesTransport = Object.hasOwn(transports, id) ? transport(transports[id]) : 'http'
    const { responsesTransport: _ignored, ...rest } = profile
    return { ...rest, apiMode, ...(apiMode === 'responses' ? { responsesTransport } : {}), continuationNamespace: id }
  }
  return {
    ...options,
    ...(options.provider ? { provider: apply(options.activeProviderCode ?? options.provider.provider, options.provider) } : {}),
    ...(options.providerProfiles ? { providerProfiles: Object.fromEntries(Object.entries(options.providerProfiles).map(([id, profile]) => [id, apply(id, profile)])) } : {}),
  }
}
