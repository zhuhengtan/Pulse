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

/** Only protocol choices are persisted. Keys, endpoints and live adapters stay host-owned. */
export function captureProviderApiModes(options: ModeOptions) {
  const profiles = { ...options.providerProfiles }
  if (options.provider) profiles[options.activeProviderCode ?? options.provider.provider] = options.provider
  return { schemaVersion: 1, modes: Object.fromEntries(Object.entries(profiles).filter(([, profile]) => compatible(profile)).map(([code, profile]) => [code, profile.apiMode ?? 'chat-completions'])) }
}

/** Old inputs always keep Chat Completions, even after today's config selects Responses. */
export function restoreProviderApiModes<T extends ModeOptions>(options: T, saved: unknown): T {
  let modes: Record<string, unknown> = {}
  if (saved !== undefined) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('PROVIDER_API_MODE_SNAPSHOT_INVALID')
    const snapshot = saved as Record<string, unknown>
    if (snapshot.schemaVersion !== 1 || !snapshot.modes || typeof snapshot.modes !== 'object' || Array.isArray(snapshot.modes)) throw new Error('PROVIDER_API_MODE_SNAPSHOT_INVALID')
    modes = snapshot.modes as Record<string, unknown>
    for (const value of Object.values(modes)) mode(value)
  }
  const apply = (code: string, profile: ProviderPresetConfig): ProviderPresetConfig => compatible(profile)
    ? { ...profile, apiMode: Object.hasOwn(modes, code) ? mode(modes[code]) : 'chat-completions', continuationNamespace: code }
    : profile
  return {
    ...options,
    ...(options.provider ? { provider: apply(options.activeProviderCode ?? options.provider.provider, options.provider) } : {}),
    ...(options.providerProfiles ? { providerProfiles: Object.fromEntries(Object.entries(options.providerProfiles).map(([code, profile]) => [code, apply(code, profile)])) } : {}),
  }
}
