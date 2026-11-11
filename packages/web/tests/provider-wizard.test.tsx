import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { ProviderWizard } from '../src/ProviderWizard.js'
import { SettingsPage } from '../src/SettingsPage.js'
import type { PulseWebTransport } from '../src/transport.js'
import { providerPresets, savedProviderPreset } from '../../server/src/providers/catalog.js'
import { settingsFixture } from './fixtures/settings.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function fixture(saved?: Parameters<typeof savedProviderPreset>[0]) {
  const requests: Array<{ path: string; body: any }> = []
  let failure = false
  const transport: PulseWebTransport = { request: vi.fn(async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path.startsWith('/api/provider-presets')) return response(saved ? { presets: [savedProviderPreset(saved)], selection: { presetId: 'saved', connectionVariant: 'current' } } : { presets: providerPresets })
    if (failure) return response({ error: 'PROVIDER_HTTP_401' }, 400)
    if (path.endsWith('/discover')) return response({ source: 'remote', authenticated: true, sourceURL: 'https://openrouter.ai/docs', catalogVersion: '2026-10-28', models: Array.from({ length: 41 }, (_, index) => ({ modelCode: `vendor/model-${index}`, displayName: `模型 ${index}`, imageInput: 'unknown', tools: index % 2 ? 'supported' : 'unknown', structuredOutput: 'unknown' })) })
    if (path.endsWith('/probe')) return response({ modelCode: body.modelCode, chat: { status: 'passed' }, tools: { status: 'passed' }, structuredOutput: { status: 'passed' } })
    if (path.endsWith('/connect')) return response({ ok: true })
    return response({}, 404)
  }), subscribe: () => () => {} }
  return { transport, requests, fail: () => { failure = true } }
}
async function selectProvider(name = 'OpenRouter') { fireEvent.click(await screen.findByRole('button', { name, exact: true })); fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-only-key' } }) }
function show(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  const onClose = vi.fn(), onConnected = vi.fn()
  render(<PulseDesignSystem><ProviderWizard transport={f.transport} version="version-1" config={{ activeModel: 'existing/model' }} onClose={onClose} onConnected={onConnected} {...extra}/></PulseDesignSystem>)
  return { onClose, onConnected }
}

it('keeps model discovery in the modal footer before selection and after the form grows', async () => {
  const f = fixture(); show(f)
  const discover = screen.getByRole('button', { name: '获取全部模型' })
  expect(discover.closest('.ant-modal-footer')).toBeTruthy()
  expect(discover.closest('.ant-modal-body')).toBeNull()
  expect(discover.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('请先选择服务商')).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'OpenRouter', exact: true }))
  expect(screen.getByText('请填写 API Key 后获取模型')).toBeTruthy()
  expect(discover.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-only-key' } })
  expect(discover.hasAttribute('disabled')).toBe(false)
  expect(discover.closest('.ant-modal-footer')).toBeTruthy()
  expect(f.requests.some(item => item.path.endsWith('/discover'))).toBe(false)
})

it('groups vendors and imports every conversation model despite list pagination and search', async () => {
  const f = fixture(), callbacks = show(f)
  await selectProvider()
  expect(screen.getByRole('heading', { name: '官方厂商' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '中间商' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '获取全部模型' }))
  await screen.findByText('将导入 41 个模型')
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(15)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  expect(within(screen.getByRole('list')).getByText('模型 15')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('搜索接入模型'), { target: { value: 'model-40' } })
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '验证所选模型' }))
  await screen.findByText('工具往返')
  fireEvent.click(screen.getByRole('button', { name: '完成接入' }))
  await waitFor(() => expect(callbacks.onConnected).toHaveBeenCalledOnce())
  const connect = f.requests.find(item => item.path.endsWith('/connect'))!.body
  expect(connect.models).toHaveLength(41); expect(connect.setDefault).toBe(false); expect(connect.version).toBe('version-1')
  expect(connect.apiKey).toBe('test-only-key'); expect(localStorage.length).toBe(0)
})
it('reports an invalid Key without showing success or allowing an empty import', async () => {
  const f = fixture(); show(f); await selectProvider(); f.fail()
  fireEvent.click(screen.getByRole('button', { name: '获取全部模型' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Key 无效'))
  expect(screen.getByRole('button', { name: '保存为未验证配置' }).hasAttribute('disabled')).toBe(true)
  expect(f.requests.some(item => item.path.endsWith('/connect'))).toBe(false)
})
it('clears temporary data on cancel and makes no configuration or credential writes', async () => {
  const f = fixture(), callbacks = show(f); await selectProvider('DeepSeek')
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
  expect(callbacks.onClose).toHaveBeenCalledOnce()
  expect(f.requests.map(item => item.path)).toEqual(['/api/provider-presets'])
  expect(localStorage.length).toBe(0)
})
it('refreshes a saved account without sending a blank replacement Key', async () => {
  const f = fixture(); show(f, { providerId: 'account', config: { activeModel: 'existing/model', providers: { account: { presetId: 'openrouter', connectionVariant: 'api', name: 'My account', credentialRef: 'credential-placeholder', models: { one: { modelCode: 'one' } } } } } })
  await screen.findByDisplayValue('My account')
  await waitFor(() => expect(screen.getByRole('button', { name: '获取全部模型' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '获取全部模型' }))
  await screen.findByText('将导入 41 个模型')
  const discover = f.requests.find(item => item.path.endsWith('/discover'))!.body
  expect(discover.providerId).toBe('account'); expect(discover).not.toHaveProperty('apiKey')
})
it('opens the full editor for a manually configured provider, discovers and verifies with its saved credential, then saves the same account', async () => {
  const settings = settingsFixture(), f = fixture(settings.config.providers.sample)
  const transport: PulseWebTransport = { ...settings.transport, request: (path, init) => path.startsWith('/api/provider') ? f.transport.request(path, init) : settings.transport.request(path, init) }
  render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig category="models" onClose={() => {}} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button', { name: '模型与服务商', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '编辑服务商 示例服务商' }))
  expect(await screen.findByDisplayValue('示例服务商')).toBeTruthy()
  const discover = screen.getByRole('button', { name: '获取全部模型' })
  await waitFor(() => expect(discover.hasAttribute('disabled')).toBe(false))
  expect(discover.closest('.ant-drawer-footer')).toBeTruthy()
  expect(screen.getByLabelText('服务地址')).toHaveProperty('value', 'https://example.com/v1')
  expect(screen.getByLabelText('API Key')).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: '验证所选模型' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(discover)
  await screen.findByText('将导入 41 个模型')
  fireEvent.click(screen.getByRole('button', { name: '验证所选模型' }))
  await screen.findByText('工具往返')
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(screen.queryByLabelText('API Key')).toBeNull())
  const saved = f.requests.find(item => item.path.endsWith('/connect'))!.body
  expect(saved).toMatchObject({ providerId: 'sample', presetId: 'saved', connectionVariant: 'current', version: 'fixture', baseURL: 'https://example.com/v1', setDefault: false })
  expect(saved).not.toHaveProperty('apiKey')
  expect(saved.models).toHaveLength(41)
  expect(settings.writes).toEqual([])
})
it('cancels edits to a legacy local Ollama without credentials or configuration writes', async () => {
  const provider = { provider: 'ollama', name: '旧本机模型', baseURL: 'http://127.0.0.1:11434', models: { review: { modelCode: 'qwen-local' } } }
  const f = fixture(provider), callbacks = show(f, { providerId: 'legacy-local', config: { activeModel: 'other/model', providers: { 'legacy-local': provider } } })
  const discover = screen.getByRole('button', { name: '获取全部模型' })
  await waitFor(() => expect(discover.hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('接入名称'), { target: { value: '未保存名称' } })
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
  expect(callbacks.onClose).toHaveBeenCalledOnce()
  expect(f.requests.map(item => item.path)).toEqual(['/api/provider-presets?providerId=legacy-local'])
  expect(provider.name).toBe('旧本机模型')
})
it('permits explicit manual model entry while keeping it unverified', async () => {
  const f = fixture(); show(f); await selectProvider('DeepSeek')
  fireEvent.change(screen.getByLabelText('手动模型代码'), { target: { value: 'private-model' } })
  fireEvent.click(screen.getByRole('button', { name: '添加模型', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '保存为未验证配置' }))
  await waitFor(() => expect(f.requests.some(item => item.path.endsWith('/connect'))).toBe(true))
  expect(f.requests.find(item => item.path.endsWith('/connect'))!.body.models[0]).toMatchObject({ modelCode: 'private-model', tools: 'unknown' })
  expect(f.requests.some(item => item.path.endsWith('/probe'))).toBe(false)
})
it('blocks opening onboarding while settings contain an unsaved draft', async () => {
  const f = settingsFixture()
  render(<PulseDesignSystem><SettingsPage transport={f.transport} canEditConfig category="models" onCategoryChange={() => {}} onClose={() => {}} /></PulseDesignSystem>)
  fireEvent.click(await screen.findByRole('button', { name: '高级编辑服务商 示例服务商' }))
  fireEvent.change(await screen.findByDisplayValue('示例服务商'), { target: { value: 'edited' } })
  expect(screen.getByRole('button', { name: '＋ 添加服务商', exact: true }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('请先保存或取消未保存修改，再打开接入向导。')).toBeTruthy()
})
it('does not expose provider management on paired-device settings', async () => {
  const f = settingsFixture()
  render(<PulseDesignSystem><SettingsPage transport={f.transport} canEditConfig={false} category="models" onCategoryChange={() => {}} onClose={() => {}} /></PulseDesignSystem>)
  expect(screen.queryByRole('button', { name: '＋ 添加服务商', exact: true })).toBeNull()
  expect(f.writes).toEqual([])
})

it('offers configured chat models from custom providers for approval review and excludes media models', async () => {
  const f = settingsFixture()
  Object.assign(f.config.providers.sample.models, { image: { modelCode: 'image-only', displayName: '图片模型', purposes: ['image'] } })
  f.config.approvalReview.model = 'sample/chat'
  render(<PulseDesignSystem><SettingsPage transport={f.transport} canEditConfig onClose={() => {}} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button', { name: '审批与代审', exact: true }))
  await screen.findByRole('heading', { name: '审批复核模型' })
  expect(screen.getByRole('combobox', { name: /^服务商/ }).closest('.ant-select')?.textContent).toContain('示例服务商')
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /^模型/ }))
  expect(await screen.findByText('示例模型 · chat', { selector: '.ant-select-item-option-content' })).toBeTruthy()
  expect(screen.queryByText('图片模型 · image', { selector: '.ant-select-item-option-content' })).toBeNull()
  expect(f.writes).toEqual([])
})

it('connects local Ollama without a Key and makes its default loopback address editable', async () => {
  const f = fixture(); show(f)
  fireEvent.click(await screen.findByRole('button', { name: 'Ollama', exact: true }))
  expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('http://127.0.0.1:11434/v1')
  expect(screen.getByRole('button', { name: '获取全部模型' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '获取全部模型' }))
  await screen.findByText('将导入 41 个模型')
  fireEvent.click(screen.getByRole('button', { name: '保存为未验证配置' }))
  await waitFor(() => expect(f.requests.some(item => item.path.endsWith('/connect'))).toBe(true))
  const connect = f.requests.find(item => item.path.endsWith('/connect'))!.body
  expect(connect).toMatchObject({ presetId: 'ollama', connectionVariant: 'local', baseURL: 'http://127.0.0.1:11434/v1' })
  expect(connect).not.toHaveProperty('apiKey')
})

it('requires a Key for official Ollama Cloud and restores no-Key behavior after switching back to local', async () => {
  const f = fixture(); show(f)
  fireEvent.click(await screen.findByRole('button', { name: 'Ollama', exact: true }))
  fireEvent.mouseDown(screen.getByLabelText('站点与套餐'))
  fireEvent.click(await screen.findByText('Ollama Cloud · 官方云端'))
  expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('https://ollama.com/v1')
  expect(screen.getByRole('button', { name: '获取全部模型' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'cloud-secret' } })
  expect(screen.getByRole('button', { name: '获取全部模型' }).hasAttribute('disabled')).toBe(false)
  fireEvent.mouseDown(screen.getByLabelText('站点与套餐'))
  fireEvent.click(await screen.findByText('本机 Ollama · 无需 Key'))
  fireEvent.click(screen.getByRole('button', { name: '获取全部模型' }))
  await screen.findByText('将导入 41 个模型')
  expect(f.requests.find(item => item.path.endsWith('/discover'))!.body).not.toHaveProperty('apiKey')
})
it('saves provider defaults and a per-model context override without probing the provider', async () => {
  const f = fixture(); show(f); await selectProvider('DeepSeek')
  fireEvent.click(screen.getByRole('button', { name: '默认上下文长度设为200000' }))
  fireEvent.change(screen.getByLabelText('手动模型代码'), { target: { value: 'private-model' } })
  fireEvent.click(screen.getByRole('button', { name: '添加模型', exact: true }))
  fireEvent.click(screen.getByText('上下文设置'))
  fireEvent.click(screen.getByRole('button', { name: '上下文长度 · private-model设为128000' }))
  fireEvent.click(screen.getByRole('button', { name: '保存为未验证配置' }))
  await waitFor(() => expect(f.requests.some(item => item.path.endsWith('/connect'))).toBe(true))
  expect(f.requests.find(item => item.path.endsWith('/connect'))!.body).toMatchObject({ maxContextTokens: 200000, modelOverrides: { 'private-model': { maxContextTokens: 128000 } } })
  expect(f.requests.some(item => item.path.endsWith('/probe'))).toBe(false)
})
const storedVendor = { activeModel: 'vendor/chat', providers: { vendor: { presetId: 'openrouter', connectionVariant: 'api', credentialRef: 'credential-11111111-1111-1111-1111-111111111111', models: { chat: { modelCode: 'gpt-4o', displayName: 'GPT-4o' }, whisper: { modelCode: 'whisper-1', displayName: 'Whisper', purposes: ['speech'], tools: 'unsupported' } } } } }
it('initializes and saves a stored non-chat model with the existing provider', async () => {
  const f = fixture(), callbacks = show(f, { providerId: 'vendor', config: storedVendor })
  expect(await screen.findByText('Whisper')).toBeTruthy()
  const save = await screen.findByRole('button', { name: '保存修改' })
  await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
  fireEvent.click(save)
  await waitFor(() => expect(callbacks.onConnected).toHaveBeenCalledOnce())
  expect(f.requests.find(item => item.path.endsWith('/connect'))!.body.models.map((item: { modelCode: string }) => item.modelCode)).toEqual(expect.arrayContaining(['gpt-4o', 'whisper-1']))
})
it('keeps the stored non-chat model after discovery refreshes the chat catalog', async () => {
  const f = fixture(), callbacks = show(f, { providerId: 'vendor', config: storedVendor })
  const discover = await screen.findByRole('button', { name: '获取全部模型' })
  await waitFor(() => expect(discover.hasAttribute('disabled')).toBe(false))
  fireEvent.click(discover)
  await screen.findByText('将导入 42 个模型')
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(callbacks.onConnected).toHaveBeenCalledOnce())
  const models = f.requests.find(item => item.path.endsWith('/connect'))!.body.models as Array<{ modelCode: string }>
  expect(models).toHaveLength(42)
  expect(models.some(item => item.modelCode === 'whisper-1')).toBe(true)
})
