import { useEffect, useRef, useState } from 'react'
import { Input, InputNumber } from 'antd'
import { PulseButton, PulseSelect } from './PulseControls.js'
import { apiJson, ApiError, jsonRequest, type PulseWebTransport } from './transport.js'

type Config = Record<string, unknown>
type SearchResult = { query: string; results: Array<{ title: string; url: string; snippet: string }> }

export function webSearchError(code?: string): string {
  if (code === 'WEB_SEARCH_NETWORK_DISABLED') return '请先开启“允许网络访问”。'
  if (code === 'WEB_SEARCH_URL_REQUIRED' || code === 'WEB_SEARCH_URL_INVALID') return '请填写有效的 HTTP(S) 服务地址，不要在地址中填写账号、密码或片段。'
  if (code === 'WEB_SEARCH_CONFIG_INVALID') return '请检查搜索来源、服务地址和超时时间。'
  if (code === 'WEB_SEARCH_TOKEN_INVALID') return '访问令牌格式无效，不能包含换行。'
  if (code === 'WEB_SEARCH_AUTH_401') return '搜索服务认证失败，请检查 Bearer Token。'
  if (code === 'WEB_SEARCH_AUTH_403') return '搜索服务拒绝访问，请检查令牌；SearXNG 还需在 search.formats 中启用 json。'
  if (code === 'WEB_SEARCH_PROTOCOL_ERROR') return '返回格式无效，请检查 JSON 协议；SearXNG 需启用 JSON 输出。'
  if (code === 'WEB_SEARCH_TIMEOUT') return '搜索超时，请检查服务或增加超时时间。'
  if (code === 'WEB_SEARCH_CANCELLED') return '已取消测试搜索。'
  if (code === 'WEB_SEARCH_REDIRECT_BLOCKED') return '搜索服务返回了重定向，请直接填写最终接口地址。'
  if (code === 'WEB_SEARCH_RESPONSE_TOO_LARGE') return '搜索结果超过大小限制。'
  if (code === 'SEARCH_PROVIDER_CHALLENGE') return '搜索服务要求验证码，请更换来源或稍后再试。'
  if (code === 'WEB_SEARCH_CREDENTIAL_MISSING' || code?.startsWith('PROVIDER_CREDENTIAL_')) return '搜索凭据不可用，请重新设置令牌或检查环境变量。'
  if (code?.startsWith('WEB_SEARCH_HTTP_')) return `搜索服务返回 HTTP ${code.slice('WEB_SEARCH_HTTP_'.length)}。`
  return '无法连接搜索服务，请检查地址和服务运行状态。'
}

export function WebSearchSettings({ config, onChange, transport }: { config: Config; onChange: (next: Config) => void; transport: PulseWebTransport }) {
  const search = config.webSearch && typeof config.webSearch === 'object' && !Array.isArray(config.webSearch) ? config.webSearch as Config : undefined
  const [query, setQuery] = useState('Pulse')
  const [result, setResult] = useState<SearchResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | undefined>(undefined)
  const generation = useRef(0)
  useEffect(() => { generation.current++; request.current?.abort(); setBusy(false); setResult(undefined); setError('') }, [config.webSearch, config.allowNetwork])
  useEffect(() => () => { generation.current++; request.current?.abort() }, [])
  const patch = (key: string, value: unknown) => onChange({ ...config, webSearch: { provider: 'duckduckgo', ...search, [key]: value } })
  const test = async () => {
    const current = ++generation.current
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setResult(undefined)
    try {
      const value = await apiJson<SearchResult>(transport, '/api/config/web-search/test', { ...jsonRequest('POST', { config: { allowNetwork: config.allowNetwork, ...(search ? { webSearch: search } : {}) }, query }), signal: controller.signal })
      if (generation.current === current) setResult(value)
    } catch (failure) {
      if (generation.current === current) setError(controller.signal.aborted ? '已取消测试搜索。' : webSearchError(failure instanceof ApiError ? failure.detail : undefined))
    } finally { if (generation.current === current) setBusy(false) }
  }
  return <section className="editor-section">
    <h2>网页搜索</h2>
    <p>供助理和任务中的网页搜索工具使用。测试使用当前草稿，不保存配置。</p>
    <label className="field-control"><span>搜索来源</span><PulseSelect aria-label="搜索来源" value={typeof search?.provider === 'string' ? search.provider : 'legacy'} onChange={provider => {
      if (provider === 'legacy') { const next = { ...config }; delete next.webSearch; onChange(next) }
      else onChange({ ...config, webSearch: { ...search, provider, baseURL: provider === 'duckduckgo' ? 'https://html.duckduckgo.com/html/' : '', timeoutMs: search?.timeoutMs ?? 12000 } })
    }}><option value="legacy">默认搜索（兼容现有环境变量）</option><option value="duckduckgo">DuckDuckGo</option><option value="searxng">SearXNG</option><option value="custom">自定义 JSON 服务</option></PulseSelect></label>
    {search && <>
      <label className="field-control"><span>搜索服务地址</span><Input aria-label="搜索服务地址" value={typeof search.baseURL === 'string' ? search.baseURL : ''} placeholder={search.provider === 'searxng' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8080/search'} onChange={event => patch('baseURL', event.target.value)} /></label>
      <p className="field-note">支持本机、局域网和公网地址。SearXNG 填实例地址或 /search 地址；自定义服务填完整 POST 接口地址。</p>
      {search.provider === 'searxng' && <p className="field-note">请在 SearXNG 的 settings.yml 中将 json 加入 search.formats。自托管搜索仍需连接上游搜索引擎。</p>}
      {search.provider === 'custom' && <p className="field-note">POST JSON：{`{ "query": "关键词", "limit": 5 }`}；返回 {`{ "results": [{ "title": "标题", "url": "https://…", "snippet": "摘要" }] }`}。</p>}
      <label className="field-control"><span>Bearer Token<small>{search.credentialRef && search.token === undefined ? '已保存至本机独立凭据存储；留空保留' : '可选，保存时写入独立凭据存储'}</small></span><div className="secret-input"><Input.Password aria-label="搜索 Bearer Token" autoComplete="new-password" value={typeof search.token === 'string' ? search.token : ''} placeholder={search.credentialRef ? '已保存，输入新令牌可替换' : '无需认证时留空'} onChange={event => patch('token', event.target.value)} /></div></label>
      {(search.credentialRef || search.apiKeyEnv || search.token) && <PulseButton type="button" onClick={() => patch('token', '')}>清除搜索令牌</PulseButton>}
      <label className="field-control"><span>搜索超时时间（毫秒）</span><InputNumber aria-label="搜索超时时间（毫秒）" min={100} max={120000} value={typeof search.timeoutMs === 'number' ? search.timeoutMs : 12000} onChange={value => value !== null && patch('timeoutMs', Number(value))} /></label>
    </>}
    <label className="field-control"><span>测试关键词</span><Input aria-label="测试关键词" maxLength={500} value={query} onChange={event => { generation.current++; request.current?.abort(); setBusy(false); setError(''); setQuery(event.target.value); setResult(undefined) }} /></label>
    <div className="json-actions"><PulseButton type="button" disabled={!config.allowNetwork || busy || !query.trim()} onClick={() => void test()}>测试搜索</PulseButton>{busy && <PulseButton type="button" onClick={() => request.current?.abort()}>取消测试</PulseButton>}</div>
    {!config.allowNetwork && <p className="field-note">开启“允许网络访问”后可使用搜索，包括本地搜索服务。</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {result && <div role="status"><p>{result.results.length ? `搜索成功，返回 ${result.results.length} 条结果。` : '搜索成功，没有找到结果。'}</p>{result.results.map((item, index) => <p key={`${index}-${item.url}`}><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a><br />{item.snippet}</p>)}</div>}
  </section>
}
