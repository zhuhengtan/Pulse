import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { ProviderWizard } from '../src/ProviderWizard.js'
import { SettingsPage } from '../src/SettingsPage.js'
import type { PulseWebTransport } from '../src/transport.js'
import { providerPresets } from '../../server/src/providers/catalog.js'
import { settingsFixture } from './fixtures/settings.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function fixture() {
  const requests: Array<{ path: string; body: any }> = []
  let failure = false
  const transport: PulseWebTransport = { request: vi.fn(async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path === '/api/provider-presets') return response({ presets: providerPresets })
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

it('groups vendors and imports every conversation model despite list pagination and search', async () => {
  const f = fixture(), callbacks = show(f)
  await selectProvider()
  expect(screen.getByRole('heading', { name: '官方厂商' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '中间商' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '获取全部对话模型' }))
  await screen.findByText('将导入 41 个对话模型')
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
  fireEvent.click(screen.getByRole('button', { name: '获取全部对话模型' }))
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
  await waitFor(() => expect(screen.getByRole('button', { name: '获取全部对话模型' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '获取全部对话模型' }))
  await screen.findByText('将导入 41 个对话模型')
  const discover = f.requests.find(item => item.path.endsWith('/discover'))!.body
  expect(discover.providerId).toBe('account'); expect(discover).not.toHaveProperty('apiKey')
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

it('connects local Ollama without a Key and makes its default loopback address editable', async () => {
  const f = fixture(); show(f)
  fireEvent.click(await screen.findByRole('button', { name: 'Ollama', exact: true }))
  expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('http://127.0.0.1:11434/v1')
  expect(screen.getByRole('button', { name: '获取全部对话模型' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '获取全部对话模型' }))
  await screen.findByText('将导入 41 个对话模型')
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
  expect(screen.getByRole('button', { name: '获取全部对话模型' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'cloud-secret' } })
  expect(screen.getByRole('button', { name: '获取全部对话模型' }).hasAttribute('disabled')).toBe(false)
  fireEvent.mouseDown(screen.getByLabelText('站点与套餐'))
  fireEvent.click(await screen.findByText('本机 Ollama · 无需 Key'))
  fireEvent.click(screen.getByRole('button', { name: '获取全部对话模型' }))
  await screen.findByText('将导入 41 个对话模型')
  expect(f.requests.find(item => item.path.endsWith('/discover'))!.body).not.toHaveProperty('apiKey')
})
