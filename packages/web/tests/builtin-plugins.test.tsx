import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { BuiltinPlugins } from '../src/BuiltinPlugins.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => { Element.prototype.scrollTo = vi.fn(); Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }), configurable: true }); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(cleanup)
const transport: PulseWebTransport = { request: vi.fn(async () => new Response('{"jobs":[]}')), subscribe: () => () => {} }
function Fixture({ value = {} }: { value?: Record<string, unknown> }) {
  const [config, setConfig] = useState(value)
  return <><BuiltinPlugins config={config} onChange={setConfig} transport={transport} dirty={true} /><output data-testid="draft">{JSON.stringify(config)}</output></>
}
it('starts generation plugins disabled and exposes configuration only after enabling', async () => {
  render(<PulseDesignSystem><Fixture value={{ allowNetwork: true }} /></PulseDesignSystem>)
  expect(screen.queryByLabelText('图片服务地址')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '启用图片生成' }))
  expect(screen.getByLabelText('图片服务地址')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('图片模型代码'), { target: { value: 'fixture-image' } })
  expect(screen.getByTestId('draft').textContent).toContain('fixture-image')
  expect((screen.getByRole('button', { name: '试生成图片' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('图片默认参数'), { target: { value: '{broken' } })
  expect(screen.getByRole('alert').textContent).toContain('修正后才能保存')
  expect(screen.getByTestId('draft').textContent).toContain('{broken')
  fireEvent.click(screen.getByRole('switch', { name: '启用图片生成' }))
  expect(screen.queryByLabelText('图片服务地址')).toBeNull()
})
it('selects an existing custom provider as OpenAI-compatible instead of the JSON protocol', async () => {
  render(<PulseDesignSystem><Fixture value={{ allowNetwork: true, providers: { local: { presetId: 'custom', provider: 'openai-compatible', name: '本地兼容', baseURL: 'http://127.0.0.1:8000/v1', models: { tts: { modelCode: 'local-tts', displayName: '本地语音', purposes: ['speech'] } } }, official: { provider: 'openai', name: '官方语音', models: { tts: { modelCode: 'tts-1', displayName: 'Speech', purposes: ['speech'] } } } } }} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('switch', { name: '启用音频生成' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '配置语音' }))
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '语音配置方式' }))
  fireEvent.click(await screen.findByText('引用已有服务商与模型'))
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '语音服务商模型' }))
  fireEvent.click(await screen.findByText('本地兼容 / 本地语音'))
  let draft = screen.getByTestId('draft').textContent ?? ''
  expect(draft).toContain('"adapter":"openai-compatible"')
  expect(draft).not.toContain('"adapter":"custom"')
  expect(screen.queryByLabelText('OpenAI 语音通道')).toBeNull()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '语音服务商模型' }))
  fireEvent.click(await screen.findByText('官方语音 / Speech'))
  draft = screen.getByTestId('draft').textContent ?? ''
  expect(draft).toContain('"adapter":"openai"')
  expect(draft).toContain('"modelRef":"official/tts"')
  expect(screen.getByLabelText('OpenAI 语音通道')).toBeTruthy()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '语音协议' }))
  fireEvent.click(await screen.findByText('自定义 JSON 服务（本地或远程）'))
  draft = screen.getByTestId('draft').textContent ?? ''
  expect(draft).toContain('"adapter":"custom"')
  expect(draft).toContain('"modelRef":"official/tts"')
  expect(screen.queryByLabelText('OpenAI 语音通道')).toBeNull()
})
it('shows a forced-on network override instead of a closed-network state', () => {
  render(<PulseDesignSystem><BuiltinPlugins config={{ allowNetwork: false, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'openai', model: 'fixture' } } } }} onChange={() => {}} transport={transport} dirty={false} networkOverride={true} /></PulseDesignSystem>)
  expect(screen.getByText(/强制开启网络访问/)).toBeTruthy()
  expect(screen.queryByText(/请到“网络”设置开启/)).toBeNull()
  expect(screen.getByText(/图片生成/).parentElement?.textContent).toContain('已开启')
})
it('shows an inherited plugin as enabled and a saved disable keeps that connection without touching another plugin', async () => {
  const writes: Array<Record<string, any>> = []
  const host = { allowNetwork: true, allowNetworkSource: 'inherited', builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'inherited-model' } }, video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:10', model: 'inherited-video' } }, web_search: { enabled: true } }, pluginSources: { image_gen: 'inherited', video_gen: 'inherited', web_search: 'inherited' }, webSearchSource: 'default' }
  const transport: PulseWebTransport = { request: async (path, init) => {
    if (path === '/api/config' && init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return Response.json({ ok: true, path: '/cfg', version: 'next', applied: true, restartRequired: [], config: JSON.parse(String(init.body)).config, host: { ...host, pluginSources: { image_gen: 'explicit' }, builtinPlugins: { image_gen: { enabled: false } } } }) }
    if (path === '/api/config/validate') return Response.json({ valid: true, restartRequired: [] })
    if (path === '/api/builtin-plugins/jobs') return Response.json({ jobs: [] })
    if (path === '/api/config') return Response.json({ path: '/cfg', version: 'now', config: { providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock' }, host, sources: {}, environment: {}, backupAvailable: false, launchNetwork: { override: null } })
    return Response.json({ jobs: [] })
  }, subscribe: () => () => {} }
  function Page() { const [category, setCategory] = useState('network'); return <SettingsPage transport={transport} canEditConfig category={category} onCategoryChange={setCategory} onClose={() => {}} /> }
  render(<PulseDesignSystem><Page /></PulseDesignSystem>)
  expect(await screen.findByRole('switch', { name: /允许网络访问/ })).toHaveProperty('ariaChecked', 'true')
  expect(screen.getByText(/继承自更早的主机配置/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '内置插件' }))
  expect(await screen.findByRole('switch', { name: '启用图片生成' })).toHaveProperty('ariaChecked', 'true')
  expect(screen.getByText(/图片生成/).parentElement?.textContent).toContain('已开启')
  expect(screen.getByText(/图片生成/).parentElement?.textContent).toContain('继承自更早的主机配置')
  fireEvent.click(screen.getByRole('switch', { name: '启用图片生成' }))
  fireEvent.click(screen.getByRole('button', { name: '保存全部' }))
  await screen.findByText('所有修改已保存')
  expect(writes[0]?.config.builtinPlugins.image_gen).toMatchObject({ enabled: false, connection: { baseURL: 'http://127.0.0.1:9', model: 'inherited-model', adapter: 'custom' } })
  expect(writes[0]?.config.builtinPlugins.video_gen).toBeUndefined()
})
it('keeps an explicit image connection and audio modes through disable, reload and re-enable', async () => {
  const initial = { allowNetwork: true, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-image', credentialRef: 'credential-11111111-1111-4111-8111-111111111111' } }, audio_gen: { enabled: true, modes: { speech: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-speech', defaults: { voice: 'alloy' } } } }, video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'openai', baseURL: 'https://api.openai.com/v1', model: 'kept-video' } } } }
  const { unmount } = render(<PulseDesignSystem><Fixture value={initial} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('switch', { name: '启用图片生成' }))
  fireEvent.click(screen.getByRole('switch', { name: '启用音频生成' }))
  const disabled = JSON.parse(screen.getByTestId('draft').textContent ?? '{}')
  expect(disabled.builtinPlugins.image_gen).toMatchObject({ enabled: false, connection: initial.builtinPlugins.image_gen.connection })
  expect(disabled.builtinPlugins.audio_gen).toMatchObject({ enabled: false, modes: initial.builtinPlugins.audio_gen.modes })
  expect(disabled.builtinPlugins.video_gen.enabled).toBe(true)
  unmount()
  render(<PulseDesignSystem><Fixture value={disabled} /></PulseDesignSystem>)
  expect(screen.getByRole('switch', { name: '启用图片生成' })).toHaveProperty('ariaChecked', 'false')
  fireEvent.click(screen.getByRole('switch', { name: '启用图片生成' }))
  fireEvent.click(screen.getByRole('switch', { name: '启用音频生成' }))
  expect(screen.getByLabelText('图片服务地址')).toHaveProperty('value', 'http://127.0.0.1:9')
  expect(screen.getByLabelText('图片模型代码')).toHaveProperty('value', 'kept-image')
  expect(screen.getByLabelText('语音服务地址')).toHaveProperty('value', 'http://127.0.0.1:9')
  expect(screen.getByLabelText('语音模型代码')).toHaveProperty('value', 'kept-speech')
  const reopened = JSON.parse(screen.getByTestId('draft').textContent ?? '{}')
  expect(reopened.builtinPlugins.image_gen.connection.credentialRef).toBe('credential-11111111-1111-4111-8111-111111111111')
  expect(reopened.builtinPlugins.audio_gen.modes.speech.defaults.voice).toBe('alloy')
  expect(reopened.builtinPlugins.video_gen.connection.model).toBe('kept-video')
})
it('keeps an unchecked audio mode and a cleared credential from being merged back, without disabling another plugin', () => {
  const hostPlugins = { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-image', credentialRef: 'credential-11111111-1111-4111-8111-111111111111', apiKeyEnv: 'IMAGE_KEY' } }, audio_gen: { enabled: true, modes: { speech: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-speech' }, music: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-music', apiKeyEnv: 'MUSIC_KEY' } } }, video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:10', model: 'kept-video' } } }
  const host = { allowNetwork: true, builtinPlugins: hostPlugins, pluginSources: { image_gen: 'inherited', audio_gen: 'explicit', video_gen: 'inherited' } }
  function Hosted({ value }: { value: Record<string, unknown> }) {
    const [config, setConfig] = useState(value)
    return <><BuiltinPlugins config={config} host={host} onChange={setConfig} transport={transport} dirty={true} /><output data-testid="draft">{JSON.stringify(config)}</output></>
  }
  const { unmount } = render(<PulseDesignSystem><Hosted value={{ allowNetwork: true, builtinPlugins: { audio_gen: hostPlugins.audio_gen } }} /></PulseDesignSystem>)
  expect(screen.getByRole('checkbox', { name: '配置音乐' })).toHaveProperty('checked', true)
  fireEvent.click(screen.getByRole('checkbox', { name: '配置音乐' }))
  expect(screen.getByRole('checkbox', { name: '配置音乐' })).toHaveProperty('checked', false)
  expect(screen.queryByLabelText('音乐模型代码')).toBeNull()
  expect(screen.getByLabelText('语音模型代码')).toHaveProperty('value', 'kept-speech')
  expect(screen.getByRole('switch', { name: '启用视频生成' })).toHaveProperty('ariaChecked', 'true')
  expect(screen.getByRole('switch', { name: '启用图片生成' })).toHaveProperty('ariaChecked', 'true')
  fireEvent.click(screen.getByRole('button', { name: '清除图片凭据' }))
  expect(screen.queryByRole('button', { name: '清除图片凭据' })).toBeNull()
  const edited = JSON.parse(screen.getByTestId('draft').textContent ?? '{}')
  expect(edited.builtinPlugins.audio_gen.modes.music).toBeUndefined()
  expect(edited.builtinPlugins.audio_gen.modes.speech.model).toBe('kept-speech')
  expect(edited.builtinPlugins.image_gen.connection.credentialRef).toBeUndefined()
  expect(edited.builtinPlugins.image_gen.connection.apiKeyEnv).toBeUndefined()
  expect(edited.builtinPlugins.image_gen.enabled).toBe(true)
  expect(edited.builtinPlugins.video_gen).toBeUndefined()
  unmount()
  render(<PulseDesignSystem><Hosted value={edited} /></PulseDesignSystem>)
  expect(screen.getByRole('checkbox', { name: '配置音乐' })).toHaveProperty('checked', false)
  expect(screen.queryByLabelText('音乐模型代码')).toBeNull()
  expect(screen.queryByRole('button', { name: '清除图片凭据' })).toBeNull()
  expect(screen.getByRole('switch', { name: '启用视频生成' })).toHaveProperty('ariaChecked', 'true')
  expect(screen.getByLabelText('图片模型代码')).toHaveProperty('value', 'kept-image')
})
it('allows independent speech, music and sound settings under one plugin', () => {
  render(<PulseDesignSystem><Fixture value={{ allowNetwork: true }} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('switch', { name: '启用音频生成' }))
  for (const name of ['语音', '音乐', '音效']) fireEvent.click(screen.getByRole('checkbox', { name: '配置' + name }))
  expect(screen.getByLabelText('语音模型代码')).toBeTruthy()
  expect(screen.getByLabelText('音乐模型代码')).toBeTruthy()
  expect(screen.getByLabelText('音效模型代码')).toBeTruthy()
  expect(screen.getByTestId('draft').textContent).toContain('elevenlabs')
})
