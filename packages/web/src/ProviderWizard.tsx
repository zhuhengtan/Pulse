import { ContextLengthControl } from './ContextLengthControl.js'
import { manualContextTokens, resolveContextTokens } from '@hunterzhu/pulse-server/model-settings'
import { Drawer, InputNumber } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { Modal } from 'antd'
import type { DiscoveredModel, ProviderDiscovery, ProviderPreset, ProviderProbe } from '@hunterzhu/pulse-server/protocol'
import { PulseButton, PulseCheckbox, PulseInput, PulseSelect } from './PulseControls.js'
import { ApiError, apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import './providers.css'

type Obj = Record<string, any>
type ModelPurpose = NonNullable<DiscoveredModel['purposes']>[number]
const modelPurposes = new Set<ModelPurpose>(['chat', 'image', 'video', 'speech', 'music', 'sound'])
const capability = (value: unknown, fallback: DiscoveredModel['tools']): DiscoveredModel['tools'] => value === 'supported' || value === 'unsupported' || value === 'unknown' ? value : fallback
function storedDiscoveredModel(raw: Obj): DiscoveredModel {
  const purposes = Array.isArray(raw.purposes) ? raw.purposes.filter((item): item is ModelPurpose => modelPurposes.has(item)) : []
  return {
    modelCode: String(raw.modelCode),
    displayName: typeof raw.displayName === 'string' ? raw.displayName : String(raw.modelCode),
    imageInput: capability(raw.imageInput, 'unknown'),
    tools: capability(raw.tools, 'unsupported'),
    structuredOutput: capability(raw.structuredOutput, 'unknown'),
    ...(purposes.length ? { purposes } : {}),
    ...(typeof raw.remote === 'boolean' ? { remote: raw.remote } : {}),
  }
}
const statusLabels = { passed: '通过', failed: '失败', skipped: '未验证', unsupported: '不支持' }
export function providerFailure(error: unknown): string {
  const code = error instanceof ApiError ? String(error.detail ?? '') : ''
  if (error instanceof ApiError && error.status === 409) return '配置已被其他操作修改，请关闭向导并重新加载设置。'
  if (/MODEL_(?:TOKEN_LIMIT_INVALID|CONTEXT_OUTPUT_CONFLICT)/.test(code)) return '上下文长度和输出上限必须为正整数，且上下文长度必须大于输出上限。'
  if (code.includes('401')) return 'Key 无效，请检查站点、套餐和密钥是否匹配。'
  if (code.includes('403')) return '当前 Key 没有访问权限，请检查账号和套餐。'
  if (code.includes('429')) return '服务商限流或额度不足，请稍后重试。'
  if (/404|405/.test(code)) return '此地址没有提供模型目录，请确认地址，或手动填写模型代码。'
  if (code.includes('CREDENTIAL')) return '本机凭据不可用，请重新填写 Key。'
  if (code.includes('CONNECTION_MISMATCH')) return '服务商接入配置已变化，请关闭编辑窗口后重新打开。'
  if (code.includes('ENDPOINT')) return '请填写有效的 HTTPS 服务地址；本机服务和内网自托管 Ollama 可使用 HTTP。'
  if (code.includes('AGENT_MODEL')) return '默认执行模型需要支持工具调用，请选择其他模型。'
  return '操作未完成，请检查服务连接、Key 和接入类型后重试。'
}

export function ProviderWizard({ transport, version, config, providerId, onClose, onConnected }: { transport: PulseWebTransport; version: string; config: Obj; providerId?: string; onClose: () => void; onConnected: () => Promise<void> | void }) {
  const existing: Obj | undefined = providerId ? config.providers?.[providerId] : undefined
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetId, setPresetId] = useState<string>(existing?.presetId ?? '')
  const [variantId, setVariantId] = useState<string>(existing?.connectionVariant ?? '')
  const [name, setName] = useState<string>(existing?.name ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState<string>(existing?.baseURL ?? '')
  const [models, setModels] = useState<DiscoveredModel[]>(() => Object.values(existing?.models ?? {}).map((raw: any) => ({ modelCode: raw.modelCode, displayName: raw.displayName ?? raw.modelCode, imageInput: raw.imageInput ?? 'unknown', tools: raw.tools ?? 'unknown', structuredOutput: raw.structuredOutput ?? 'unknown', ...raw })))
  const [defaultContext, setDefaultContext] = useState<number | undefined>(existing?.maxContextTokens)
  const [defaultOutput, setDefaultOutput] = useState<number | undefined>(existing?.maxOutputTokens)
  const [modelOverrides, setModelOverrides] = useState<Record<string, { maxContextTokens?: number | null; maxOutputTokens?: number | null }>>({})
  const [discovery, setDiscovery] = useState<ProviderDiscovery>()
  const [modelCode, setModelCode] = useState<string>(() => {
    const active = typeof config.activeModel === 'string' && config.activeModel.startsWith(`${providerId}/`) ? existing?.models?.[config.activeModel.slice(providerId!.length + 1)] : undefined
    return active?.modelCode ?? (Object.values(existing?.models ?? {}) as Obj[]).find(item => !item.purposes?.length || item.purposes.includes('chat'))?.modelCode ?? ''
  })
  const [probe, setProbe] = useState<ProviderProbe>()
  const [manualModel, setManualModel] = useState('')
  const [search, setSearch] = useState('')
  const [capability, setCapability] = useState('all')
  const [page, setPage] = useState(0)
  const [setDefault, setSetDefault] = useState(!config.activeModel || config.activeModel === 'mock/mock')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    void apiJson<{ presets: ProviderPreset[]; selection?: { presetId: string; connectionVariant: string } }>(transport, `/api/provider-presets${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ''}`).then(value => { if (active) { setPresets(value.presets); if (value.selection) { setPresetId(value.selection.presetId); setVariantId(value.selection.connectionVariant); if (!existing?.baseURL) setBaseURL(value.presets.find(item => item.id === value.selection!.presetId)?.variants.find(item => item.id === value.selection!.connectionVariant)?.baseURL ?? '') }; setError('') } }).catch(() => { if (active) setError('厂商列表加载失败，请重试。') })
    return () => { active = false }
  }, [transport, providerId, reload])
  const preset = presets.find(item => item.id === presetId)
  const variant = preset?.variants.find(item => item.id === variantId)
  const auth = variant?.auth ?? 'required'
  const keyMissing = auth === 'required' && !apiKey.trim() && !existing?.credentialRef && !existing?.apiKeyEnv
  const editableEndpoint = presetId === 'custom' || variant?.editableBaseURL === true
  const endpointMissing = editableEndpoint && !baseURL.trim()
  const eligible = models.filter(item => item.tools !== 'unsupported' && (!item.purposes?.length || item.purposes.includes('chat')))
  const selectedMedia = models.find(item => item.modelCode === modelCode)?.purposes?.some(p => p !== 'chat') && !models.find(item => item.modelCode === modelCode)?.purposes?.includes('chat')
  const filtered = useMemo(() => models.filter(item => `${item.displayName} ${item.modelCode}`.toLowerCase().includes(search.toLowerCase()) && (capability === 'all' || capability === 'tools' && item.tools === 'supported' || capability === 'vision' && item.imageInput === 'supported' || capability === 'unknown' && item.tools === 'unknown')), [models, search, capability])
  const maxPage = Math.max(0, Math.ceil(filtered.length / 15) - 1)
  const currentPage = Math.min(page, maxPage)
  const input = () => ({ presetId, connectionVariant: variantId, ...(models.some(item => item.modelCode === modelCode && item.remote) ? { remote: true } : {}), ...(models.some(item => item.modelCode === modelCode && item.structuredOutput === 'unsupported') ? { structuredOutput: 'unsupported' } : {}), ...(providerId ? { providerId } : {}), ...(name.trim() ? { name: name.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(editableEndpoint ? { baseURL } : {}), ...(modelCode ? { modelCode } : {}) })
  const existingModel = (item: DiscoveredModel) => (Object.values(existing?.models ?? {}) as Obj[]).find(raw => raw.modelCode === item.modelCode)
  const modelContextValue = (item: DiscoveredModel) => {
    const override = modelOverrides[item.modelCode]?.maxContextTokens
    return override === undefined ? manualContextTokens(existingModel(item) ?? {}) : override ?? undefined
  }
  const modelOutputValue = (item: DiscoveredModel) => {
    const override = modelOverrides[item.modelCode]?.maxOutputTokens
    return override === undefined ? existingModel(item)?.maxOutputTokens ?? item.maxOutputTokens : override ?? undefined
  }
  const resetConnection = () => { setModels([]); setDiscovery(undefined); setProbe(undefined); setModelCode(''); setError(''); setPage(0); setModelOverrides({}) }
  const run = async (action: string, operation: () => Promise<void>) => { setBusy(action); setError(''); try { await operation() } catch (error) { setError(providerFailure(error)) } finally { setBusy('') } }
  const discover = () => run('discover', async () => {
    const result = await apiJson<ProviderDiscovery>(transport, '/api/providers/discover', jsonRequest('POST', input()))
    const retained = (Object.values(existing?.models ?? {}) as Obj[]).filter(raw => {
      const code = typeof raw.modelCode === 'string' ? raw.modelCode : ''
      const purposes = Array.isArray(raw.purposes) ? raw.purposes : []
      return code && !result.models.some(item => item.modelCode === code) && (/embed|rerank|whisper/i.test(code) || purposes.length > 0 && !purposes.includes('chat'))
    }).map(storedDiscoveredModel)
    const next = [...retained, ...result.models]
    setModels(next); setDiscovery(result); setProbe(undefined); setPage(0)
    setModelCode(current => next.some(item => item.modelCode === current && (item.tools !== 'unsupported' && (!item.purposes?.length || item.purposes.includes('chat')))) ? current : next.find(item => item.tools !== 'unsupported' && (!item.purposes?.length || item.purposes.includes('chat')))?.modelCode ?? '')
  })
  const verify = () => run('probe', async () => { setProbe(undefined); setProbe(await apiJson<ProviderProbe>(transport, '/api/providers/probe', jsonRequest('POST', input()))) })
  const connect = () => run('connect', async () => {
    const result = await apiJson<{ applied?: boolean; restartRequired?: string[] }>(transport, '/api/providers/connect', jsonRequest('POST', { ...input(), version, models, setDefault, maxContextTokens: defaultContext ?? null, maxOutputTokens: defaultOutput ?? null, modelOverrides: Object.fromEntries(Object.entries(modelOverrides).filter(([code]) => models.some(item => item.modelCode === code))) }))
    setApiKey(''); await onConnected(); onClose()
    window.dispatchEvent(new CustomEvent('pulse-toast', { detail: result.applied ? '服务商已接入，新任务可以使用。' : '接入配置已保存，重启后台后生效。' }))
  })
  const discoveryHint = !preset ? '请先选择服务商' : !variant || variant.available === false ? '请选择可用的站点与套餐' : keyMissing ? '请填写 API Key 后获取模型' : endpointMissing ? '请填写服务地址后获取模型' : '点击“获取全部模型”拉取模型列表'
  const actions = <div className="provider-wizard-actions"><span>{models.length ? `将导入 ${models.length} 个模型` : discoveryHint}</span><PulseButton type="button" className="settings-primary" title={discoveryHint} disabled={!preset || !variant || variant.available === false || Boolean(busy) || keyMissing || endpointMissing} onClick={() => void discover()}>{busy === 'discover' ? '正在获取模型…' : '获取全部模型'}</PulseButton><PulseButton type="button" disabled={busy === 'connect'} onClick={() => { setApiKey(''); onClose() }}>取消</PulseButton><PulseButton type="button" className="settings-primary" disabled={!models.length || Boolean(busy) || !preset || variant?.available === false || keyMissing || endpointMissing || setDefault && !modelCode} onClick={() => void connect()}>{busy === 'connect' ? '正在保存…' : providerId ? '保存修改' : probe?.chat.status === 'passed' ? '完成接入' : '保存为未验证配置'}</PulseButton></div>
  const close = () => { if (busy !== 'connect') { setApiKey(''); onClose() } }
  const content = <>
    <p>{providerId ? '管理服务商连接、拉取模型列表并验证模型。保存后生效；取消不写入配置。' : '选择服务商，自动配置服务地址和模型。本机 Ollama 无需 Key。'}</p>
    {error && <div className="settings-alert" role="alert">{error}{!presets.length && <PulseButton onClick={() => setReload(value => value + 1)}>重新加载厂商</PulseButton>}</div>}
    <fieldset disabled={Boolean(busy)}>
      {!providerId && <div className="provider-preset-grid">{(['official', 'aggregator', 'custom'] as const).map(category => <section key={category}><h3>{category === 'official' ? '官方厂商' : category === 'aggregator' ? '中间商' : '自定义'}</h3><div>{presets.filter(item => item.category === category).map(item => <PulseButton type="button" key={item.id} aria-pressed={item.id === presetId} className={item.id === presetId ? 'selected' : ''} onClick={() => { setPresetId(item.id); setVariantId(item.variants.find(value => value.available !== false)?.id ?? ''); setName(item.name); setDefaultContext(undefined); setDefaultOutput(undefined); setModelOverrides({}); setApiKey(''); setBaseURL(item.variants.find(value => value.available !== false)?.baseURL ?? ''); resetConnection() }}>{item.name}</PulseButton>)}</div></section>)}</div>}
      {preset && <>
        <div className="field-grid">
          <label className="field-control"><span>接入名称</span><PulseInput aria-label="接入名称" value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
          <label className="field-control"><span>站点与套餐</span><PulseSelect aria-label="站点与套餐" value={variantId} disabled={Boolean(providerId) || Boolean(busy)} onChange={value => { setVariantId(value); setBaseURL(preset.variants.find(item => item.id === value)?.baseURL ?? ''); setApiKey(''); resetConnection() }}>{preset.variants.map(value => <option key={value.id} value={value.id} disabled={value.available === false}>{value.name}</option>)}</PulseSelect></label>
          <label className="field-control" hidden={auth === 'none'}><span>API Key{auth === 'optional' && '（可选）'} {preset.keyURL && <a href={preset.keyURL} target="_blank" rel="noreferrer">获取 Key ↗</a>}</span><PulseInput aria-label="API Key" type="password" autoComplete="off" value={apiKey} placeholder={existing?.credentialRef || existing?.apiKeyEnv ? '留空继续使用已保存凭据' : auth === 'optional' ? '网关要求鉴权时填写' : '粘贴 API Key'} onChange={event => { setApiKey(event.target.value); setProbe(undefined); setDiscovery(undefined) }} /></label>
          <label className="field-control"><span>服务地址</span><PulseInput aria-label="服务地址" placeholder="https://ollama.example.com/v1" value={editableEndpoint ? baseURL : variant?.baseURL ?? ''} disabled={!editableEndpoint} onChange={event => { setBaseURL(event.target.value); resetConnection() }} /></label>
        </div>
        <ContextLengthControl label="默认上下文长度" value={defaultContext} disabled={Boolean(busy)} onChange={setDefaultContext}/>
        <label className="field-control"><span>默认输出上限</span><InputNumber<number> aria-label="默认输出上限" value={defaultOutput ?? null} placeholder="自动（4096）" min={1} precision={0} onChange={value => setDefaultOutput(value ?? undefined)}/></label>
        {preset.variants.some(item => item.available === false) && <p className="field-note">{preset.variants.filter(item => item.available === false).map(item => item.unavailableReason).join(' ')}</p>}
        <p className="field-note">{auth === 'none' ? '连接本机已运行的 Ollama，无需 Key。只读取已有模型，不自动下载模型。' : auth === 'optional' ? '填写远程 Ollama 地址；网关需要鉴权时再填写 Key。远程服务按云端模型处理。' : 'Key 保存在本机独立凭据文件，不写入配置 JSON。套餐验证失败时不会切换到按量计费接口。'}</p>
        {discovery && models.length === 0 && presetId === 'ollama' && <p className="field-note">没有发现对话模型。请先在 Ollama 安装模型，或检查所选服务地址。</p>}{discovery && <p role="status">{discovery.source === 'catalog' ? `官方预设清单 · ${discovery.catalogVersion}（尚未验证 Key）` : '已获取远程目录，具体模型权限仍需调用验证'} · {models.length} 个模型 {discovery.sourceURL && <a href={discovery.sourceURL} target="_blank" rel="noreferrer">来源 ↗</a>}</p>}
        <div className="provider-manual"><PulseInput aria-label="手动模型代码" value={manualModel} placeholder="需要时手动补充模型代码" onChange={event => setManualModel(event.target.value)} maxLength={250} /><PulseButton type="button" disabled={!manualModel.trim() || Boolean(busy)} onClick={() => { const code = manualModel.trim(); if (!models.some(item => item.modelCode === code)) setModels(items => [...items, { modelCode: code, displayName: code, tools: 'unknown', structuredOutput: 'unknown', imageInput: 'unknown' }]); setModelCode(code); setManualModel('') }}>添加模型</PulseButton></div>
        {models.length > 0 && <>
          <div className="provider-model-toolbar"><PulseInput aria-label="搜索接入模型" placeholder="搜索模型名称或代码" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} /><PulseSelect aria-label="筛选模型能力" value={capability} onChange={value => { setCapability(value); setPage(0) }}><option value="all">全部模型</option><option value="tools">支持工具</option><option value="vision">支持图像输入</option><option value="unknown">工具待验证</option></PulseSelect></div>
          <ul className="provider-model-list">{filtered.slice(currentPage * 15, (currentPage + 1) * 15).map(item => <li key={item.modelCode}><strong>{item.displayName}</strong><code>{item.modelCode}</code><small>{item.purposes?.some(p => p !== 'chat') && !item.purposes.includes('chat') ? item.purposes.join(' / ') : item.tools === 'supported' ? '支持工具' : item.tools === 'unsupported' ? '仅聊天' : '工具待验证'} · {probe?.modelCode === item.modelCode ? '已检测，见下方结果' : '未验证'}</small><details className="provider-model-context"><summary>上下文设置</summary><ContextLengthControl label={`上下文长度 · ${item.displayName}`} disabled={Boolean(busy)} value={modelContextValue(item)} automatic={resolveContextTokens({ discovery: (item as DiscoveredModel & { discovery?: DiscoveredModel }).discovery ?? item }, { maxContextTokens: defaultContext })} onChange={value => setModelOverrides(current => ({ ...current, [item.modelCode]: { ...current[item.modelCode], maxContextTokens: value ?? null } }))}/><label className="field-control"><span>输出上限</span><InputNumber<number> aria-label={`输出上限 · ${item.displayName}`} value={modelOutputValue(item) ?? null} placeholder="自动" min={1} precision={0} onChange={value => setModelOverrides(current => ({ ...current, [item.modelCode]: { ...current[item.modelCode], maxOutputTokens: value } }))}/></label></details></li>)}</ul>
          <div className="provider-pagination"><span>共 {filtered.length} 个 · 第 {currentPage + 1}/{maxPage + 1} 页</span><PulseButton type="button" disabled={currentPage === 0 || Boolean(busy)} onClick={() => setPage(currentPage - 1)}>上一页</PulseButton><PulseButton type="button" disabled={currentPage >= maxPage || Boolean(busy)} onClick={() => setPage(currentPage + 1)}>下一页</PulseButton></div>
          <label className="field-control"><span>测试模型{setDefault && ' / 默认模型'}</span><PulseSelect aria-label="测试模型" showSearch optionFilterProp="label" value={modelCode} disabled={Boolean(busy)} onChange={value => { setModelCode(value); setProbe(undefined) }}>{(setDefault ? eligible : models).map(item => <option key={item.modelCode} value={item.modelCode}>{item.displayName} · {item.modelCode}</option>)}</PulseSelect></label>
          <p className="field-note">{selectedMedia ? '媒体模型请保存后到“内置插件”试生成；此处只验证聊天模型。' : '只对所选模型执行最多三次低 Token 调用，可能产生少量费用；其他模型保持未验证。'}</p>
          <PulseButton type="button" disabled={!modelCode || selectedMedia || Boolean(busy)} onClick={() => void verify()}>{busy === 'probe' ? '正在验证聊天和工具往返…' : '验证所选模型'}</PulseButton>
          {probe && <div className="provider-probe" role="status">{(['chat', 'tools', 'structuredOutput'] as const).map(key => <p key={key} data-status={probe[key].status}><strong>{key === 'chat' ? '聊天与流式' : key === 'tools' ? '工具往返' : '结构化输出'}</strong><span>{statusLabels[probe[key].status]}{probe[key].code ? ` · ${probe[key].code}` : ''}</span></p>)}</div>}
          <PulseCheckbox checked={setDefault} onChange={event => { setSetDefault(event.target.checked); if (event.target.checked && !eligible.some(item => item.modelCode === modelCode)) setModelCode(eligible[0]?.modelCode ?? '') }}>将所选模型设为默认执行模型</PulseCheckbox>
        </>}
      </>}
    </fieldset>
  </>
  return providerId
    ? <Drawer open title="编辑服务商" onClose={close} footer={actions} size={780} rootClassName="provider-wizard provider-wizard-drawer" mask={{ closable: false }} closable={busy !== 'connect'}>{content}</Drawer>
    : <Modal open centered title="添加服务商" onCancel={close} footer={actions} width={780} className="provider-wizard" styles={{ body: { maxHeight: 'calc(100dvh - 240px)', overflowY: 'auto', paddingRight: 4 } }} mask={{ closable: false }} closable={busy !== 'connect'}>{content}</Modal>
}
