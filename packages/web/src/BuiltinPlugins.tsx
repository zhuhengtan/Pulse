import { useEffect, useRef, useState } from 'react'
import { Input, InputNumber, Switch } from 'antd'
import { PulseButton, PulseSelect, PulseTextArea } from './PulseControls.js'
import { apiJson, ApiError, jsonRequest, type PulseWebTransport } from './transport.js'
import { WebSearchSettings } from './WebSearchSettings.js'

type Obj = Record<string, any>
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
export const pluginTitles: Record<string, string> = { web_search: '网页搜索', image_gen: '图片生成', video_gen: '视频生成', audio_gen: '音频生成' }
const kinds: Record<string, string> = { image: '图片', video: '视频', speech: '语音', music: '音乐', sound: '音效' }
const catalog = [
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', kinds: ['image', 'video', 'speech'] },
  { id: 'google', name: 'Google', url: 'https://generativelanguage.googleapis.com/v1beta', kinds: ['image', 'video', 'speech', 'music'] },
  { id: 'bailian', name: '阿里百炼', url: 'https://dashscope.aliyuncs.com/api/v1', kinds: ['image', 'video', 'speech'] },
  { id: 'volcengine', name: '火山方舟', url: 'https://ark.cn-beijing.volces.com/api/v3', kinds: ['image', 'video'] },
  { id: 'minimax', name: 'MiniMax', url: 'https://api.minimax.io/v1', kinds: ['image', 'video', 'speech', 'music'] },
  { id: 'elevenlabs', name: 'ElevenLabs', url: 'https://api.elevenlabs.io/v1', kinds: ['speech', 'music', 'sound'] },
  { id: 'openai-compatible', name: 'OpenAI 兼容 / 本地 TTS', url: 'http://127.0.0.1:8000/v1', kinds: ['image', 'speech'] },
  { id: 'comfyui', name: 'ComfyUI（本地或远程）', url: 'http://127.0.0.1:8188', kinds: Object.keys(kinds) },
  { id: 'custom', name: '自定义 JSON 服务（本地或远程）', url: 'http://127.0.0.1:8000', kinds: Object.keys(kinds) },
]
export function pluginErrorText(code?: string): string {
  const errors: Record<string, string> = {
    PLUGIN_DISABLED: '插件未开启，或网络访问已关闭。', PLUGIN_CONNECTION_REQUIRED: '请填写服务地址和模型，或选择已有服务商模型。',
    PLUGIN_MODEL_REFERENCE_INVALID: '引用的模型不存在，请重新选择。', PLUGIN_MODEL_PURPOSE_REQUIRED: '请先在模型配置中设置对应的生成用途。',
    PLUGIN_BILLING_VARIANT_UNSUPPORTED: '编程套餐接口不用于媒体生成，请配置普通 API 连接。',
    PLUGIN_URL_INVALID: '请输入不含账号、密码、查询参数和片段的 HTTP(S) 服务地址。', PLUGIN_CONFIG_INVALID: '插件配置格式无效，请检查必填项。',
    PLUGIN_WORKFLOW_REQUIRED: 'ComfyUI 需要 API 工作流和节点映射。', PLUGIN_WORKFLOW_MAPPING_INVALID: '工作流节点映射不存在。',
    PLUGIN_AUTH_FAILED: '认证失败，请检查密钥及服务地区。', PLUGIN_QUOTA_EXHAUSTED: '服务余额或额度不足。',
    PLUGIN_TIMEOUT: '生成超时，可检查服务或增加总时限。', PLUGIN_CANCELLED: '已停止本地生成等待，远端取消状态可在任务列表查看。',
    PLUGIN_NETWORK_DISABLED: '网络访问已关闭，已停止本地等待。', PLUGIN_REDIRECT_BLOCKED: '服务返回了重定向，请填写最终 API 地址。',
    PLUGIN_VOICE_REQUIRED: '此语音服务需要音色，请填写默认 Voice ID。', PLUGIN_TOKEN_INVALID: '令牌格式无效，不能包含换行。',
    PLUGIN_REFERENCE_INVALID: '参考图不存在、超出大小限制，或不属于当前工作区或聊天。', PLUGIN_REFERENCE_UNSUPPORTED: '所选模型或协议不支持这种参考图输入。',
    PLUGIN_MEDIA_TYPE_INVALID: '生成结果不是支持的图片、音频或视频文件。', PLUGIN_EMPTY_RESULT: '服务未返回可用的生成结果。',
    PLUGIN_PARAMETER_FORBIDDEN: '默认参数含有受限制的连接字段，请使用专用配置项。',
    PLUGIN_PROTOCOL_ERROR: '服务返回的数据格式与所选协议不符。', PLUGIN_PROVIDER_REJECTED: '服务商拒绝或未能完成此请求，请检查模型权限和参数。',
    PLUGIN_SUBMISSION_UNKNOWN: '无法确认请求是否已提交，为避免重复计费未再次生成。', PLUGIN_NETWORK_ERROR: '服务连接失败，请检查地址和服务状态。',
    PLUGIN_DOWNLOAD_FAILED: '生成结果下载失败。', PLUGIN_CAPABILITY_UNSUPPORTED: '所选协议不支持这一生成用途。',
    PLUGIN_DOWNLOAD_TARGET_DENIED: '结果下载地址未获授权：本地结果需位于同一服务的 /files/ 路径，跨服务结果只允许公网地址。',
    PLUGIN_MODE_NOT_CONFIGURED: '这一音频模式尚未配置。', PLUGIN_RESPONSE_TOO_LARGE: '结果超过单文件 128 MiB 上限。',
    PLUGIN_SPEECH_CHANNEL_REQUIRED: '请为 OpenAI 语音选择 Speech 或 Realtime。未知模型不会自动改用另一种计费接口。',
    PLUGIN_ACTIVE_JOBS: '插件仍有在途请求，请选择停止或等待完成后再保存。',
  }
  return errors[code ?? ''] ?? (code?.startsWith('PLUGIN_HTTP_') ? '生成服务返回 HTTP ' + code.slice(12) : code?.startsWith('PROVIDER_CREDENTIAL_') ? '凭据不可用，请重新设置密钥。' : '生成失败，请检查配置和服务状态。')
}

function JsonEditor({ label, value, onChange }: { label: string; value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)), [error, setError] = useState('')
  useEffect(() => { setText(typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)) }, [value])
  return <label className="field-control"><span>{label}</span><PulseTextArea aria-label={label} rows={5} value={text} onChange={event => {
    setText(event.target.value)
    try { const next = JSON.parse(event.target.value); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(); onChange(next); setError('') } catch { onChange(event.target.value); setError('请输入有效的 JSON 对象，修正后才能保存。') }
  }} />{error && <small role="alert">{error}</small>}</label>
}
/** Same overlay as the host merge. An omitted connection or modes object stays; a present one replaces it. */
function overlayEntry(inherited: Obj, explicit: Obj | undefined): Obj {
  if (!explicit) return inherited
  return { ...inherited, ...explicit }
}
/** Matches server mediaAdapterForProvider: preset custom is OpenAI-compatible, not the JSON /generate protocol. */
function mediaAdapterForProvider(provider: Obj | undefined): string {
  const protocol = String(provider?.provider ?? '')
  if (protocol === 'gemini') return 'google'
  if (protocol === 'openai') return 'openai'
  if (protocol === 'openai-compatible' || provider?.presetId === 'custom') return 'openai-compatible'
  if (['google', 'bailian', 'volcengine', 'minimax', 'elevenlabs', 'comfyui'].includes(protocol)) return protocol
  if (protocol && protocol !== 'custom') return 'openai-compatible'
  return ''
}
function ConnectionEditor({ kind, value, config, onChange }: { kind: string; value: Obj; config: Obj; onChange: (value: Obj) => void }) {
  const [importError, setImportError] = useState('')
  const patch = (key: string, next: unknown) => onChange({ ...value, [key]: next })
  const choices = catalog.filter(c => c.kinds.includes(kind))
  const providerModels = Object.entries(obj(config.providers)).flatMap(([id, provider]) => Object.entries(obj(obj(provider).models)).filter(([, model]) => obj(model).purposes?.includes(kind)).map(([modelId, model]) => ({ id: id + '/' + modelId, label: (obj(provider).name ?? id) + ' / ' + (obj(model).displayName ?? modelId), provider: obj(provider) })))
  return <section className="config-entity"><h3>{kinds[kind]}连接</h3>
    <label className="field-control"><span>配置方式</span><PulseSelect aria-label={kinds[kind] + '配置方式'} value={value.source ?? 'standalone'} onChange={source => onChange({ source, adapter: choices[0]!.id, ...(source === 'standalone' ? { baseURL: choices[0]!.url } : {}) })}><option value="model">引用已有服务商与模型</option><option value="standalone">独立配置</option></PulseSelect></label>
    {value.source === 'model' && <label className="field-control"><span>服务商 / 模型</span><PulseSelect aria-label={kinds[kind] + '服务商模型'} value={value.modelRef ?? ''} onChange={modelRef => {
      const selected = providerModels.find(m => m.id === modelRef), adapter = mediaAdapterForProvider(selected?.provider)
      onChange({ ...value, modelRef, adapter: choices.some(c => c.id === adapter) ? adapter : choices[0]!.id })
    }}><option value="">选择模型</option>{providerModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</PulseSelect>{!providerModels.length && <small>请在“模型与服务商”中添加模型并设置{ kinds[kind] }用途，或使用独立配置。</small>}</label>}
    <label className="field-control"><span>服务商 / 协议</span><PulseSelect aria-label={kinds[kind] + '协议'} value={value.adapter ?? choices[0]!.id} onChange={adapter => {
      const next: Obj = { ...value, adapter, baseURL: catalog.find(c => c.id === adapter)!.url, ...(adapter === 'comfyui' ? { mappings: { prompt: { node: '6', input: 'text' }, outputNode: '9' } } : {}) }; delete next.token; delete next.credentialRef; delete next.apiKeyEnv; onChange(next)
    }}>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</PulseSelect></label>
    <label className="field-control"><span>服务地址{value.source === 'model' ? '（留空使用所选服务商）' : ''}</span><Input aria-label={kinds[kind] + '服务地址'} value={value.baseURL ?? ''} placeholder={choices.find(c => c.id === value.adapter)?.url} onChange={e => patch('baseURL', e.target.value)} /></label>
    {value.source !== 'model' && <>
      <label className="field-control"><span>模型代码</span><Input aria-label={kinds[kind] + '模型代码'} value={value.model ?? ''} onChange={e => patch('model', e.target.value)} /></label>
      <label className="field-control"><span>API Key / Bearer Token<small>{value.credentialRef ? '已存于独立凭据存储；留空保留' : '无认证的本地服务可留空'}</small></span><div className="secret-input"><Input.Password aria-label={kinds[kind] + '访问令牌'} autoComplete="new-password" value={value.token ?? ''} onChange={e => { const next = { ...value }; if (e.target.value) next.token = e.target.value; else delete next.token; onChange(next) }} /></div></label>
      {(value.credentialRef || value.token || value.apiKeyEnv) && <PulseButton type="button" onClick={() => { const c: Obj = { ...value, token: '' }; delete c.credentialRef; delete c.apiKeyEnv; onChange(c) }}>清除{kinds[kind]}凭据</PulseButton>}
      <label className="field-control"><span>密钥环境变量（可选）</span><Input aria-label={kinds[kind] + '密钥环境变量'} value={value.apiKeyEnv ?? ''} onChange={e => { const c = { ...value }; if (e.target.value) c.apiKeyEnv = e.target.value; else delete c.apiKeyEnv; delete c.credentialRef; delete c.token; onChange(c) }} /></label>
    </>}
    <label className="field-control"><span>生成总时限（秒）</span><InputNumber aria-label={kinds[kind] + '总时限'} min={1} max={3600} value={(value.timeoutMs ?? (kind === 'image' ? 180000 : kind === 'video' ? 1800000 : 600000)) / 1000} onChange={v => v !== null && patch('timeoutMs', Number(v) * 1000)} /></label>
    {kind === 'speech' && (value.adapter ?? choices[0]!.id) === 'openai' && <label className="field-control"><span>OpenAI 语音通道</span><PulseSelect aria-label="OpenAI 语音通道" value={value.speechTransport ?? ''} onChange={speechTransport => { const next = { ...value }; if (speechTransport === 'speech' || speechTransport === 'realtime') next.speechTransport = speechTransport; else delete next.speechTransport; onChange(next) }}><option value="">按模型识别：tts-1、tts-1-hd、gpt-4o-mini-tts 走 Speech，名称含 realtime 走 Realtime</option><option value="speech">Speech API（旧 TTS 模型）</option><option value="realtime">Realtime WebSocket</option></PulseSelect><small>失败后不会自动改用另一种接口。</small></label>}
    {kind === 'speech' && <label className="field-control"><span>默认音色 / Voice ID</span><Input aria-label="默认音色" value={obj(value.defaults).voice ?? ''} onChange={e => patch('defaults', { ...obj(value.defaults), voice: e.target.value })} /></label>}
    <JsonEditor label={kinds[kind] + '默认参数'} value={value.defaults} onChange={v => patch('defaults', v)} />
    {value.adapter === 'comfyui' && <><p className="field-note">导入 ComfyUI 导出的 API 格式工作流，并指定主输出节点。Pulse 不安装节点或模型。</p><label className="field-control"><span>导入 API 工作流</span><input aria-label={kinds[kind] + '导入工作流'} type="file" accept=".json" onChange={e => { const file = e.target.files?.[0]; setImportError(''); if (!file) return; if (file.size > 1000000) { setImportError('工作流超过 1 MB，请精简后导入。'); return }; void file.text().then(text => { const workflow = JSON.parse(text); if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error(); patch('workflow', workflow) }).catch(() => setImportError('工作流文件不是有效的 JSON 对象，请检查 API 导出格式。')) }} /></label>{importError && <p role="alert">{importError}</p>}<JsonEditor label={kinds[kind] + 'API 工作流'} value={value.workflow} onChange={v => patch('workflow', v)} /><JsonEditor label={kinds[kind] + '节点映射'} value={value.mappings ?? { prompt: { node: '6', input: 'text' }, outputNode: '9' }} onChange={v => patch('mappings', v)} /></>}
    {value.adapter === 'custom' && <p className="field-note">自定义 JSON：POST /generate，GET /jobs/任务ID，DELETE /jobs/任务ID。请求包含 kind、model、prompt、parameters、inputs；成功返回 status=succeeded 与 outputs（mediaType、dataBase64 或 url），排队返回 status 与 id。</p>}
    <p className="field-note">支持本机、局域网、远程自托管或云服务。模型、地址与密钥必须属于相同地区和 API 产品；失败不会自动切换来源。</p>
  </section>
}

function GenerationTest({ kind, transport, blocked }: { kind: string; transport: PulseWebTransport; blocked: boolean }) {
  const [prompt, setPrompt] = useState('生成一个简短的测试' + kinds[kind]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<Obj>(), [preview, setPreview] = useState('')
  const abort = useRef<AbortController | undefined>(undefined), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  const test = async () => {
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(''); setResult(undefined); setPreview('')
    try {
      const value = await apiJson<Obj>(transport, '/api/config/builtin-plugins/' + kind + '/test', { ...jsonRequest('POST', { prompt }), signal: controller.signal })
      if (!mounted.current) return
      const response = await transport.request(value.previewURL, { signal: controller.signal })
      if (!response.ok) throw new Error()
      const blob = await response.blob()
      if (mounted.current) { setPreview(URL.createObjectURL(blob)); setResult(value) }
    } catch (e) { setError(controller.signal.aborted ? '已取消本地等待；远端取消状态见在途任务。' : pluginErrorText(e instanceof ApiError ? e.detail : undefined)) }
    finally { setBusy(false) }
  }
  return <section className="config-entity"><h3>{kinds[kind]}试生成</h3><p>使用已保存配置，可能产生服务商费用。生成结果会保留为测试产物。</p><Input.TextArea aria-label={kinds[kind] + '测试提示词'} value={prompt} maxLength={20000} onChange={e => setPrompt(e.target.value)} /><div className="json-actions"><PulseButton disabled={blocked || busy || !prompt.trim()} onClick={() => void test()}>试生成{kinds[kind]}</PulseButton>{busy && <PulseButton onClick={() => abort.current?.abort()}>取消{kinds[kind]}试生成</PulseButton>}</div>{blocked && <small>请先开启插件和网络访问，并保存配置。</small>}{error && <p role="alert">{error}</p>}{result && <div role="status"><p>生成成功 · {result.bytes} 字节</p>{kind === 'image' ? <img src={preview} alt="测试生成图片" style={{ maxWidth: '100%' }} /> : kind === 'video' ? <video controls src={preview} style={{ maxWidth: '100%' }} /> : <audio controls src={preview} />}<a href={preview} download={'test-' + kind}>下载结果</a></div>}</section>
}

export interface HostPluginSurface { allowNetwork?: boolean; allowNetworkSource?: string; builtinPlugins?: Obj; pluginSources?: Record<string, string>; webSearch?: Obj; webSearchSource?: string }
export function BuiltinPlugins({ config, onChange, transport, dirty, networkOverride = null, host = null }: { config: Obj; onChange: (next: Obj) => void; transport: PulseWebTransport; dirty: boolean; networkOverride?: boolean | null; host?: HostPluginSurface | null }) {
  const plugins = obj(config.builtinPlugins), inheritedPlugins = obj(host?.builtinPlugins), [jobs, setJobs] = useState<Obj[]>([]), [check, setCheck] = useState('')
  const update = (id: string, value: Obj) => onChange({ ...config, builtinPlugins: { ...plugins, [id]: value } })
  const refresh = () => { void apiJson<{ jobs: Obj[] }>(transport, '/api/builtin-plugins/jobs').then(v => setJobs(v.jobs)).catch(() => {}) }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer) }, [transport])
  const validate = async () => { try { await apiJson(transport, '/api/config/validate', jsonRequest('POST', { config })); setCheck('配置检查通过；尚未调用生成服务。') } catch(e) { setCheck(pluginErrorText(e instanceof ApiError ? e.detail : undefined)) } }
  const configuredNetwork = typeof config.allowNetwork === 'boolean' ? config.allowNetwork : host?.allowNetwork === true
  const effectiveNetwork = networkOverride === true || networkOverride === false ? networkOverride : configuredNetwork
  const searchConfig = { ...config, allowNetwork: effectiveNetwork, ...(config.webSearch ? {} : host?.webSearch ? { webSearch: host.webSearch } : {}) }
  return <div className="specialized-editor"><div className="json-actions"><PulseButton onClick={()=>void validate()}>检查插件配置（不调用服务）</PulseButton></div>{check && <p role="status">{check}</p>}<p>开启后由 Pulse 按需使用；关闭后禁止后续调用。更改连接后，已提交请求继续使用原配置，新调用使用保存后的配置。直接改配置文件不会让已有请求继续访问网络；只有保存时明确选择等待完成或停止才会留下授权。</p>{networkOverride === true && <p role="status">当前进程被命令行或环境变量强制开启网络访问。配置显示关闭时，插件和新的网页读取仍然可用，直到去掉该强制并重启。</p>}{networkOverride === false && <p role="status">当前进程使用 --no-network，网络访问被强制关闭。配置里的开启不会生效，已有请求也不能继续查询或取消远端任务。</p>}{networkOverride == null && !effectiveNetwork && <p role="status">网络访问已关闭，包括本地生成服务。请到“网络”设置开启。已保存的“等待完成”或“停止”只作用于当时已存在的请求。</p>}{networkOverride == null && host?.allowNetworkSource === 'inherited' && typeof config.allowNetwork !== 'boolean' && <p role="status">网络访问继承自更早的主机配置。在这里关闭并保存会写入当前配置文件。</p>}
    {Object.entries(pluginTitles).map(([id, title]) => {
      const explicit = Object.hasOwn(plugins, id) ? obj(plugins[id]) : undefined
      const entry = overlayEntry(obj(inheritedPlugins[id]), explicit)
      const enabled = id === 'web_search' ? entry.enabled !== false : entry.enabled === true
      const inherited = !explicit && host?.pluginSources?.[id] === 'inherited'
      const modes = id === 'audio_gen' ? Object.keys(kinds).filter(k => ['speech', 'music', 'sound'].includes(k) && obj(entry.modes)[k]) : [id === 'image_gen' ? 'image' : 'video']
      return <section className="editor-section" key={id}><header className="editor-section-head"><div><h2>{title}</h2><small>{id} · {enabled ? !effectiveNetwork ? '网络已关闭' : id !== 'web_search' && (id === 'audio_gen' ? !modes.length : !entry.connection?.model && !entry.connection?.modelRef) ? '配置不完整' : '已开启' : '已关闭'}{inherited ? ' · 继承自更早的主机配置' : ''}</small></div><Switch aria-label={'启用' + title} checked={enabled} onChange={value => { const next: Obj = { ...entry, enabled: value }; if (value && !next.connection && ['image_gen', 'video_gen'].includes(id)) next.connection = { source: 'standalone', adapter: 'openai', baseURL: catalog[0]!.url }; update(id, next) }} /></header>
        {id === 'web_search' ? enabled && <WebSearchSettings embedded config={searchConfig} onChange={next => onChange({ ...config, webSearch: next.webSearch })} transport={transport} /> : enabled && <>
          {id === 'audio_gen' && <div className="json-actions">{['speech', 'music', 'sound'].map(kind => <label key={kind}><input type="checkbox" aria-label={'配置' + kinds[kind]} checked={Boolean(obj(entry.modes)[kind])} onChange={e => { const next = { ...obj(entry.modes) }; if (e.target.checked) next[kind] = { source: 'standalone', adapter: kind === 'sound' ? 'elevenlabs' : 'openai', baseURL: kind === 'sound' ? catalog[5]!.url : catalog[0]!.url }; else delete next[kind]; update(id, { ...entry, modes: next }) }} />{kinds[kind]}</label>)}</div>}
          {modes.map(kind => <div key={kind}><ConnectionEditor kind={kind} value={id === 'audio_gen' ? obj(obj(entry.modes)[kind]) : obj(entry.connection)} config={config} onChange={value => update(id, id === 'audio_gen' ? { ...entry, modes: { ...obj(entry.modes), [kind]: value } } : { ...entry, connection: value })} /><GenerationTest kind={kind} transport={transport} blocked={dirty || !effectiveNetwork} /></div>)}
        </>}
      </section>
    })}
    <section className="editor-section"><h2>生成任务</h2><PulseButton onClick={refresh}>刷新生成任务</PulseButton>{jobs.slice(0, 20).map(job => <p key={job.id}>{pluginTitles[job.pluginId]} · {{ submitting: '正在提交', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已停止', unknown: '提交状态不明' }[job.state as string] ?? job.state}{job.error ? ' · ' + pluginErrorText(job.error) : ''}{job.remoteCancellation ? ' · 远端取消：' + ({ requested: '已请求取消', unsupported: '服务不支持或无法确认', failed: '取消请求失败' }[job.remoteCancellation as string] ?? job.remoteCancellation) : ''}</p>)}{!jobs.length && <p>暂无生成任务。</p>}</section>
  </div>
}
