import { expect, it } from 'vitest'
import { contextSource, resolveContextTokens, validateContextSettings } from '../packages/server/src/model-settings.js'
import { mergeDiscoveredModels } from '../packages/server/src/providers/onboarding.js'
import { normalizeModelConfig } from '../packages/server/src/model-config.js'
const discovered = { modelCode: 'model', displayName: 'model', maxContextTokens: 128000, imageInput: 'unknown' as const, tools: 'unknown' as const, structuredOutput: 'unknown' as const }
it('resolves manual model, provider, discovery and system context in that order', () => {
  const model = { maxContextTokens: 128000, discovery: discovered }
  expect(contextSource(model)).toBe('discovery')
  expect(resolveContextTokens(model, { maxContextTokens: 64000 })).toBe(64000)
  expect(resolveContextTokens({ ...model, maxContextTokensSource: 'manual' }, { maxContextTokens: 64000 })).toBe(128000)
  expect(resolveContextTokens({ discovery: discovered })).toBe(128000)
  expect(resolveContextTokens({})).toBe(32000)
  expect(resolveContextTokens({}, { maxContextTokens: 256000 })).toBe(256000)
})
it('preserves explicit overrides even when equal to the old discovered value and restores discovery after clearing', () => {
  const old = { ...discovered, discovery: discovered, maxContextTokensSource: 'manual' as const }
  const refresh = { ...discovered, maxContextTokens: 256000 }
  const result = mergeDiscoveredModels({ model: old }, [refresh]).model!
  expect(result.maxContextTokens).toBe(128000)
  expect(resolveContextTokens(result)).toBe(128000)
  const cleared = { ...result, maxContextTokens: undefined, maxContextTokensSource: 'discovery' as const }
  expect(resolveContextTokens(cleared)).toBe(256000)
  expect(resolveContextTokens(cleared, { maxContextTokens: 64000 })).toBe(64000)
  expect(mergeDiscoveredModels({ model: cleared }, [discovered]).model?.maxContextTokens).toBe(128000)
})
it('migrates legacy discovery values without losing old custom context', () => {
  expect(resolveContextTokens({ maxContextTokens: 128000, discovery: discovered }, { maxContextTokens: 64000 })).toBe(64000)
  expect(resolveContextTokens({ maxContextTokens: 200000, discovery: discovered }, { maxContextTokens: 64000 })).toBe(200000)
  const config = normalizeModelConfig({ providers: { p: { provider: 'mock', maxContextTokens: 64000, models: { model: { modelCode: 'model', maxContextTokens: 128000, maxContextTokensSource: 'manual' } } } } })
  expect(config.providers.p.models.model.maxContextTokensSource).toBe('manual')
})
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])('rejects invalid token count %s on server configuration', value => {
  expect(() => normalizeModelConfig({ providers: { p: { provider: 'mock', maxContextTokens: value } } })).toThrow('MODEL_TOKEN_LIMIT_INVALID')
})
it('rejects output budgets that consume the whole context, and validates each model override', () => {
  expect(() => validateContextSettings({ maxContextTokens: 8192, models: { one: { maxOutputTokens: 8192 } } }, 'p')).toThrow('MODEL_CONTEXT_OUTPUT_CONFLICT:p/one')
  expect(() => validateContextSettings({ models: { one: { maxContextTokens: 200000, maxOutputTokens: 200000 } } }, 'p')).toThrow('MODEL_CONTEXT_OUTPUT_CONFLICT:p/one')
})
