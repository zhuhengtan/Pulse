import type { ReasoningEffort } from '@hunterzhu/pulse-runtime'
import { isReasoningEffort } from '@hunterzhu/pulse-adapters/reasoning-effort'
export { isReasoningEffort, reasoningEfforts, resolveReasoningSupport } from '@hunterzhu/pulse-adapters/reasoning-effort'
export type { ReasoningEffort } from '@hunterzhu/pulse-runtime'

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
export function validateContextSettings(provider: ContextSettings & { models?: Record<string, ContextSettings> }, id: string, mode: 'strict' | 'load' = 'strict'): void {
  const integer = (value: unknown, path: string) => { if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new Error(`MODEL_TOKEN_LIMIT_INVALID:${path}`) }
  integer(provider.maxContextTokens, id + '.maxContextTokens')
  integer(provider.maxOutputTokens, id + '.maxOutputTokens')
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    integer(model.maxContextTokens, `${id}/${key}.maxContextTokens`)
    integer(model.maxOutputTokens, `${id}/${key}.maxOutputTokens`)
    if (model.maxContextTokensSource !== undefined && !['manual', 'discovery'].includes(model.maxContextTokensSource)) throw new Error(`MODEL_CONTEXT_SOURCE_INVALID:${id}/${key}`)
  }
  if (mode === 'load') return
  if (provider.maxContextTokens !== undefined && (provider.maxOutputTokens ?? 4096) >= provider.maxContextTokens) throw new Error(`MODEL_CONTEXT_OUTPUT_CONFLICT:${id}`)
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    if ((manualContextTokens(model) !== undefined || provider.maxContextTokens !== undefined) && (model.maxOutputTokens ?? provider.maxOutputTokens ?? 4096) >= resolveContextTokens(model, provider)) throw new Error(`MODEL_CONTEXT_OUTPUT_CONFLICT:${id}/${key}`)
  }
}

function contextLimit(context: number): number {
  return Number.isSafeInteger(context) && context > 0 ? context : 32_000
}

/** Keep a requested completion inside the context window without rewriting the stored setting. */
export function fitOutputTokens(output: number | undefined, context: number): number {
  const requested = Number.isSafeInteger(output) && (output as number) > 0 ? output as number : 4096
  const window = contextLimit(context)
  if (requested >= window) return Math.min(requested, Math.floor(window / 2))
  return Math.max(1, Math.min(requested, window - 1))
}

/** A fitted output of 0 cannot be stored on a candidate; the router requires a present value to be positive. */
export function candidateOutputTokens(output: number | undefined, context: number): number | undefined {
  const fitted = fitOutputTokens(output, context)
  return fitted > 0 ? fitted : undefined
}

/** History plus output stays inside the context window. Common 32k/4k budgets keep their previous split. */
export function runtimeTokenWindow(context: number, output: number | undefined): { maxOutputTokens: number; historyHardTokens: number; historySoftTokens: number } {
  const window = contextLimit(context)
  const maxOutputTokens = fitOutputTokens(output, window)
  const remaining = Math.max(1, window - maxOutputTokens)
  const preferredHard = Math.max(2_000, Math.floor(Math.max(2_000, remaining) / 2))
  const historyHardTokens = Math.max(1, Math.min(remaining, preferredHard))
  const historySoftTokens = Math.max(1, Math.min(historyHardTokens, Math.max(1_000, Math.floor(historyHardTokens / 2))))
  return { maxOutputTokens, historyHardTokens, historySoftTokens }
}

/** Use the real context, including a 1-token window. Missing context still defaults inside runtimeTokenWindow. */
export function historyBudget(capabilities: { maxContextTokens?: number; maxOutputTokens?: number }): { historySoftTokens: number; historyHardTokens: number } {
  const fitted = runtimeTokenWindow(capabilities.maxContextTokens ?? 0, capabilities.maxOutputTokens)
  return { historyHardTokens: fitted.historyHardTokens, historySoftTokens: fitted.historySoftTokens }
}

export type ModelRouteEntry = string | { model: string; reasoningEffort?: ReasoningEffort }
export function routeModelId(entry: ModelRouteEntry): string { return typeof entry === 'string' ? entry : typeof entry?.model === 'string' ? entry.model : '' }
export function routeEntry(entry: unknown, resolve: (model: string) => string): ModelRouteEntry {
  if (typeof entry === 'string' && entry.trim()) return resolve(entry)
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('MODEL_ROUTE_ENTRY_INVALID')
  const { model, reasoningEffort } = entry as Record<string, unknown>
  if (typeof model !== 'string' || !model.trim()) throw new Error('MODEL_ROUTE_ENTRY_INVALID')
  if (reasoningEffort === undefined) return resolve(model)
  if (!isReasoningEffort(reasoningEffort)) throw new Error('MODEL_REASONING_EFFORT_INVALID')
  return { model: resolve(model), reasoningEffort }
}
