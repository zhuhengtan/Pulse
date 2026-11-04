import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { contextSource, historyBudget, resolveContextTokens, runtimeTokenWindow, validateContextSettings } from '../packages/server/src/model-settings.js'
import { estimateProjectionTokens } from '../packages/runtime/src/models/router.js'
import { mergeDiscoveredModels } from '../packages/server/src/providers/onboarding.js'
import { normalizeModelConfig } from '../packages/server/src/model-config.js'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'
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
it('loads an old conflicting context without changing stored values and keeps the runtime window inside it', async () => {
  const stored = { providers: { local: { provider: 'mock', maxContextTokens: 8192, maxOutputTokens: 8192, models: { chat: { modelCode: 'chat', displayName: 'chat', maxContextTokens: 8192, maxOutputTokens: 8192, maxContextTokensSource: 'manual' as const } } } }, activeModel: 'local/chat' }
  const loaded = normalizeModelConfig(stored)
  expect(loaded.providers.local.maxContextTokens).toBe(8192)
  expect(loaded.providers.local.maxOutputTokens).toBe(8192)
  expect(loaded.providers.local.models.chat).toMatchObject({ maxContextTokens: 8192, maxOutputTokens: 8192, maxContextTokensSource: 'manual' })
  expect(() => validateContextSettings(loaded.providers.local, 'local')).toThrow('MODEL_CONTEXT_OUTPUT_CONFLICT:local')
  const directory = await mkdtemp(join(tmpdir(), 'pulse-old-context-'))
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify(stored))
  try {
    const options = await hostOptions(parse(['--config', path, '--cwd', directory]))
    expect(await readFile(path, 'utf8')).toContain('"maxOutputTokens":8192')
    expect(options.provider.maxContextTokens).toBe(8192)
    expect(options.provider.maxOutputTokens).toBe(8192)
    expect(options.providerModels?.['local/chat']).toMatchObject({ maxContextTokens: 8192, maxOutputTokens: 8192 })
    const routing = createHostModelRouting({ activeModel: options.activeModel!, activeProviderCode: options.activeProviderCode, activeProvider: options.provider!, ...(options.providerProfiles ? { providerProfiles: options.providerProfiles } : {}), ...(options.providerModels ? { providerModels: options.providerModels } : {}) })
    const candidate = routing.candidates.find(item => item.id === 'local/chat')!
    expect(candidate.capabilities.maxContextTokens).toBe(8192)
    expect(candidate.capabilities.maxOutputTokens).toBeLessThanOrEqual(4096)
    expect(candidate.capabilities.maxContextTokens - candidate.capabilities.maxOutputTokens).toBeGreaterThanOrEqual(4096)
    const budget = runtimeTokenWindow(32_000, 4096)
    expect(budget).toMatchObject({ maxOutputTokens: 4096, historyHardTokens: 13952, historySoftTokens: 6976 })
    const legacy = runtimeTokenWindow(8192, 8192)
    expect(legacy.maxOutputTokens).toBe(candidate.capabilities.maxOutputTokens)
    expect(legacy.historyHardTokens).toBeGreaterThan(1)
    expect(legacy.historyHardTokens + candidate.capabilities.maxOutputTokens).toBeLessThanOrEqual(candidate.capabilities.maxContextTokens)
    const tiny = runtimeTokenWindow(4, 4)
    expect(tiny.maxOutputTokens).toBeLessThanOrEqual(2)
    expect(tiny.historyHardTokens).toBeGreaterThan(0)
    expect(tiny.maxOutputTokens + tiny.historyHardTokens).toBeLessThanOrEqual(4)
    const single = runtimeTokenWindow(1, 4096)
    expect(single.maxOutputTokens + single.historyHardTokens).toBeLessThanOrEqual(1)
    expect(historyBudget({ maxContextTokens: 32_000, maxOutputTokens: 4096 })).toEqual({ historyHardTokens: 13952, historySoftTokens: 6976 })
    expect(historyBudget({ maxContextTokens: 1, maxOutputTokens: 4096 })).toEqual({ historyHardTokens: 1, historySoftTokens: 1 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('registers a 1-token legacy model and refuses a normal projection before any request', async () => {
  const stored = { providers: { local: { provider: 'mock', maxContextTokens: 1, maxOutputTokens: 4096, models: { 'tiny-legacy': { modelCode: 'tiny', displayName: 'tiny-legacy', maxContextTokens: 1, maxOutputTokens: 4096, maxContextTokensSource: 'manual' as const } } } }, activeModel: 'local/tiny-legacy' }
  const directory = await mkdtemp(join(tmpdir(), 'pulse-tiny-context-'))
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify(stored))
  try {
    const options = await hostOptions(parse(['--config', path, '--cwd', directory]))
    expect(JSON.parse(await readFile(path, 'utf8')).providers.local).toMatchObject({ maxContextTokens: 1, maxOutputTokens: 4096 })
    expect(options.provider.maxContextTokens).toBe(1)
    expect(options.provider.maxOutputTokens).toBe(4096)
    expect(options.providerModels?.['local/tiny-legacy']).toMatchObject({ maxContextTokens: 1, maxOutputTokens: 4096 })
    const routing = createHostModelRouting({ activeModel: options.activeModel!, activeProviderCode: options.activeProviderCode, activeProvider: options.provider!, ...(options.providerProfiles ? { providerProfiles: options.providerProfiles } : {}), ...(options.providerModels ? { providerModels: options.providerModels } : {}) })
    const candidate = routing.models.list().find(item => item.id === 'local/tiny-legacy')!
    expect(candidate.capabilities.maxContextTokens).toBe(1)
    expect(candidate.capabilities.maxOutputTokens).toBeUndefined()
    const projection = { privacy: 'local_only' as const, blocks: [{ kind: 'instruction' as const, content: 'Answer the ordinary user request with one complete sentence.' }] }
    const estimated = estimateProjectionTokens(projection as Parameters<typeof routing.router.routeProjection>[1])
    expect(estimated).toBeGreaterThan(1)
    expect(routing.router.routeProjection('reason', projection as Parameters<typeof routing.router.routeProjection>[1])).toEqual([])
    expect(routing.router.diagnostics('reason', 'local_only', {}, estimated).find(item => item.id === 'local/tiny-legacy')).toMatchObject({ accepted: false, reasons: ['CONTEXT_WINDOW_TOO_SMALL'] })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
