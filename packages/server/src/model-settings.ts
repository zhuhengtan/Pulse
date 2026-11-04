/** Shared, browser-safe model settings. Discovery is evidence, never a user override. */
export interface ContextSettings {
  maxContextTokens?: number | undefined
  maxContextTokensSource?: 'manual' | 'discovery'
  maxOutputTokens?: number
  discovery?: { maxContextTokens?: number | undefined }
}
export function contextSource(model: ContextSettings): 'manual' | 'discovery' {
  return model.maxContextTokensSource ?? (model.discovery?.maxContextTokens !== undefined && model.maxContextTokens === model.discovery.maxContextTokens ? 'discovery' : 'manual')
}
export function manualContextTokens(model: ContextSettings): number | undefined {
  return contextSource(model) === 'manual' ? model.maxContextTokens : undefined
}
export function resolveContextTokens(model: ContextSettings, provider: ContextSettings = {}): number {
  return manualContextTokens(model) ?? provider.maxContextTokens ?? model.discovery?.maxContextTokens ?? (contextSource(model) === 'discovery' ? model.maxContextTokens : undefined) ?? 32_000
}
export function validateContextSettings(provider: ContextSettings & { models?: Record<string, ContextSettings> }, id: string): void {
  const integer = (value: unknown, path: string) => { if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new Error(`MODEL_TOKEN_LIMIT_INVALID:${path}`) }
  integer(provider.maxContextTokens, id + '.maxContextTokens')
  integer(provider.maxOutputTokens, id + '.maxOutputTokens')
  if (provider.maxContextTokens !== undefined && (provider.maxOutputTokens ?? 4096) >= provider.maxContextTokens) throw new Error(`MODEL_CONTEXT_OUTPUT_CONFLICT:${id}`)
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    integer(model.maxContextTokens, `${id}/${key}.maxContextTokens`)
    integer(model.maxOutputTokens, `${id}/${key}.maxOutputTokens`)
    if (model.maxContextTokensSource !== undefined && !['manual', 'discovery'].includes(model.maxContextTokensSource)) throw new Error(`MODEL_CONTEXT_SOURCE_INVALID:${id}/${key}`)
    if ((manualContextTokens(model) !== undefined || provider.maxContextTokens !== undefined) && (model.maxOutputTokens ?? provider.maxOutputTokens ?? 4096) >= resolveContextTokens(model, provider)) throw new Error(`MODEL_CONTEXT_OUTPUT_CONFLICT:${id}/${key}`)
  }
}
