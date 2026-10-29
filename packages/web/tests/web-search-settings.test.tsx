import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { WebSearchSettings } from '../src/WebSearchSettings.js'
import { SettingsPage } from '../src/SettingsPage.js'
import type { PulseWebTransport } from '../src/transport.js'
import { settingsFixture } from './fixtures/settings.js'

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const row = { title: 'Example result', url: 'https://example.com/', snippet: 'Source snippet' }
function fixture(failure?: string) {
  const calls: Array<{ path: string; body: any }> = []
  const transport: PulseWebTransport = { request: async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(failure ? { error: failure } : { query: 'test', results: [row] }), { status: failure ? 400 : 200 })
  }, subscribe: () => () => {} }
  return { calls, transport }
}
function Form({ transport, initial = { allowNetwork: true } }: { transport: PulseWebTransport; initial?: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial)
  return <WebSearchSettings config={config} onChange={setConfig} transport={transport} />
}

describe('web search settings', () => {
  it('tests current custom-service draft with a password field without saving', async () => {
    const f = fixture()
    render(<PulseDesignSystem><Form transport={f.transport} /></PulseDesignSystem>)
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '搜索来源' }))
    fireEvent.click(await screen.findByText('自定义 JSON 服务'))
    fireEvent.change(screen.getByLabelText('搜索服务地址'), { target: { value: 'http://localhost:8080/search' } })
    fireEvent.change(screen.getByLabelText('搜索 Bearer Token'), { target: { value: 'draft-private' } })
    expect((screen.getByLabelText('搜索 Bearer Token') as HTMLInputElement).type).toBe('password')
    fireEvent.change(screen.getByLabelText('测试关键词'), { target: { value: 'test query' } })
    fireEvent.click(screen.getByRole('button', { name: '测试搜索', exact: true }))
    expect(await screen.findByText('搜索成功，返回 1 条结果。')).toBeTruthy()
    expect(screen.getByRole('link', { name: row.title }).getAttribute('href')).toBe(row.url)
    expect(f.calls).toEqual([{ path: '/api/config/web-search/test', body: { config: { allowNetwork: true, webSearch: { provider: 'custom', baseURL: 'http://localhost:8080/search', timeoutMs: 12000, token: 'draft-private' } }, query: 'test query' } }])
  })
  it('explains SearXNG JSON configuration and displays actionable authorization errors', async () => {
    const f = fixture('WEB_SEARCH_AUTH_403')
    render(<PulseDesignSystem><Form transport={f.transport} initial={{ allowNetwork: true, webSearch: { provider: 'searxng', baseURL: 'http://localhost:8080' } }} /></PulseDesignSystem>)
    expect(screen.getByText(/将 json 加入 search.formats/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '测试搜索', exact: true }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '搜索服务拒绝访问，请检查令牌；SearXNG 还需在 search.formats 中启用 json。')
  })
  it('disables testing when network access is off', () => {
    const f = fixture()
    render(<PulseDesignSystem><Form transport={f.transport} initial={{ allowNetwork: false }} /></PulseDesignSystem>)
    expect((screen.getByRole('button', { name: '测试搜索', exact: true }) as HTMLButtonElement).disabled).toBe(true)
    expect(f.calls).toEqual([])
  })
  it('cancels in-flight draft testing', async () => {
    const transport: PulseWebTransport = { request: async (_path, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), subscribe: () => () => {} }
    render(<PulseDesignSystem><Form transport={transport} /></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '测试搜索', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '取消测试', exact: true }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '已取消测试搜索。')
    await waitFor(() => expect((screen.getByRole('button', { name: '测试搜索', exact: true }) as HTMLButtonElement).disabled).toBe(false))
  })
  it('includes the service in network configuration save and clears the token input after saving', async () => {
    const f = settingsFixture(); const writes: any[] = []
    const transport: PulseWebTransport = { ...f.transport, request: async (path, init) => {
      if (path === '/api/config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)); writes.push(body)
        const config = { ...body.config, webSearch: { provider: 'custom', baseURL: body.config.webSearch.baseURL, credentialRef: 'credential-example' } }
        return new Response(JSON.stringify({ ok: true, path: '/example/config.json', version: 'new-version', applied: true, restartRequired: [], config }))
      }
      return f.transport.request(path, init)
    } }
    render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig category="builtin-plugins" onCategoryChange={() => {}} onClose={() => {}} /></PulseDesignSystem>)
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: '搜索来源' }))
    fireEvent.click(await screen.findByText('自定义 JSON 服务'))
    fireEvent.change(screen.getByLabelText('搜索服务地址'), { target: { value: 'http://localhost:8080/search' } })
    fireEvent.change(screen.getByLabelText('搜索 Bearer Token'), { target: { value: 'private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存全部', exact: true }))
    await screen.findByText('所有修改已保存')
    expect(writes[0].config.webSearch).toMatchObject({ provider: 'custom', baseURL: 'http://localhost:8080/search', token: 'private-key' })
    expect((screen.getByLabelText('搜索 Bearer Token') as HTMLInputElement).value).toBe('')
  })
})
