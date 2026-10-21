import { PulseButton, PulseDisclosure, PulseInput, PulseSelect, PulseTextArea, usePulseDialogs } from './PulseControls.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Input, InputNumber, Select, Switch } from 'antd'
import { ApiError, apiJson, jsonRequest } from './transport.js'
import { Icon } from './Icon.js'
import type { PulseWebTransport } from './transport.js'

type JsonObject = Record<string, unknown>
interface ConfigEnvelope { path: string; version: string; config: JsonObject; sources: Record<string, unknown>; environment: Record<string, boolean>; backupAvailable: boolean; active?: { model?: string; provider?: string } }
interface Category { id: string; label: string; description: string; paths: string[] }

const categories: Category[] = [
  { id: 'appearance', label: '外观', description: '仅保存在此浏览器。', paths: [] },
  { id: 'models', label: '模型与服务商', description: '在各服务商下管理模型，并设置默认模型和助理聊天模型。密钥只读取环境变量状态。', paths: ['providers', 'models', 'activeModel', 'assistantModel'] },
  { id: 'routing', label: '模型路由', description: '按任务配置首选模型和回退顺序。', paths: ['taskRouting'] },
  { id: 'front', label: '即时预回复', description: '选择已登记的服务商和模型作为即时预回复模型。', paths: ['frontModel'] },
  { id: 'approval', label: '审批与代审', description: '工具审批策略和本机 Ollama 复核模型；聊天栏的审核方式全局保存。', paths: ['approvalMode', 'approvalReview'] },
  { id: 'jarvis', label: 'Jarvis', description: '记忆服务、连接地址、上下文预算和候选记忆策略。访问令牌会脱敏。', paths: ['jarvis'] },
  { id: 'tools', label: '工具与技能', description: '已启用能力、技能选择及受信任的技能目录。', paths: ['capabilities.enabled', 'capabilities.skills', 'capabilities.trustedSkillRoots'] },
  { id: 'mcp', label: 'MCP', description: '服务命令和参数会启动本机进程。环境变量值默认保留为脱敏占位。', paths: ['capabilities.mcpServers'] },
  { id: 'network', label: '网络', description: '网络访问开关和允许访问的主机列表。', paths: ['allowNetwork', 'networkHosts'] },
  { id: 'instructions', label: '指令', description: '系统提示词及其文件来源。', paths: ['systemPrompt', 'systemPromptFile'] },
  { id: 'runtime', label: '运行与存储', description: '工作目录、数据目录、运行轮数和自动压缩阈值。数据目录变更需重启后生效。', paths: ['cwd', 'dataDir', 'maxTurns', 'maxRuntimeMs', 'autoCompactPercent'] },
  { id: 'archive', label: '归档对话', description: '搜索、恢复或永久删除已归档对话。', paths: [] },
  { id: 'advanced', label: '高级配置', description: '完整 JSON 草稿、校验、变更预览与备份恢复。', paths: [] },
]

const defaultAppearance = { theme: 'system', interfaceScale: 'standard', codeScale: 'standard' }
const configLabels: Record<string, string> = {
  providers: '服务商配置', models: '模型配置', activeModel: '当前模型', assistantModel: '助理聊天模型', taskRouting: '模型路由',
  frontModel: '即时预回复', enabled: '启用', provider: '服务商', model: '模型', baseURL: '服务地址', timeoutMs: '超时时间（毫秒）',
  approvalMode: '审批模式', approvalReview: '审批复核模型', cwd: '工作目录', dataDir: '数据目录', maxTurns: '最大执行轮数',
  maxRuntimeMs: '单次运行时限（毫秒）', autoCompactPercent: '自动压缩阈值（%）', allowNetwork: '允许网络访问', networkHosts: '允许访问的主机',
  systemPrompt: '系统指令', systemPromptFile: '系统指令文件', jarvis: 'Jarvis 配置', apiUrl: '服务地址', token: '访问令牌',
  contextTokenBudget: '上下文预算（Token）', autoCandidate: '自动记录候选记忆', allowRemote: '允许远程连接',
  capabilities: '能力配置', mcpServers: 'MCP 服务', skills: '可用技能', trustedSkillRoots: '受信任的技能目录', command: '启动命令',
  args: '命令参数', env: '环境变量', envFrom: '环境变量引用', toolPolicies: '工具权限',
  name: '名称', apiKeyEnv: 'API Key 环境变量', maxContextTokens: '上下文上限', maxOutputTokens: '输出上限', reasoningEffort: '推理强度',
  modelCode: '模型代码', displayName: '显示名称', pricing: '价格', currency: '货币', inputPerMillion: '每百万输入 Token 价格',
  outputPerMillion: '每百万输出 Token 价格', version: '价格版本', reason: '推理任务', plan: '规划任务', merge: '汇总任务', verify: '验收任务',
}

function getPath(value: JsonObject, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && !Array.isArray(current) ? (current as JsonObject)[key] : undefined, value)
}

function setPath(source: JsonObject, path: string, next: unknown): JsonObject {
  const keys = path.split('.')
  const root = structuredClone(source)
  let current = root
  for (const key of keys.slice(0, -1)) {
    const existing = current[key]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[key] = {}
    current = current[key] as JsonObject
  }
  current[keys.at(-1)!] = next
  return root
}

function deepEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function describeValidationError(detail?: string): string {
  const route = detail?.match(/^INVALID_TASK_MODEL_ROUTE:(.+)$/)
  if (route) {
    const taskNames: Record<string, string> = { reason: '推理', plan: '规划', merge: '汇总', verify: '验收' }
    const task = route[1] ?? ''
    return `“${taskNames[task] ?? task}”模型路由无效，请选择已登记的模型。`
  }
  const duplicateRoute = detail?.match(/^DUPLICATE_TASK_MODEL_ROUTE_CANDIDATE:(.+)$/)
  if (duplicateRoute) {
    const taskNames: Record<string, string> = { reason: '推理', plan: '规划', merge: '汇总', verify: '验收' }
    const task = duplicateRoute[1] ?? ''
    return `“${taskNames[task] ?? task}”路由中有重复模型，请移除重复项。`
  }
  const mcp = detail?.match(/^INVALID_MCP_SERVER_CONFIG:(.+)$/)
  if (mcp) return `MCP 服务“${mcp[1]}”配置不完整，请检查命令和参数。`
  const policy = detail?.match(/^INVALID_MCP_TOOL_POLICY:(.+)$/)
  if (policy) return `MCP 服务“${policy[1]}”的工具权限无效，请重新选择权限。`
  const env = detail?.match(/^INVALID_MCP_ENV_REFERENCE:(.+)$/)
  if (env) return `MCP 服务“${env[1]}”的环境变量引用格式无效。`
  const requiredEnv = detail?.match(/^MCP_ENVIRONMENT_REQUIRED:([^:]+):(.+)$/)
  if (requiredEnv) return `MCP 服务“${requiredEnv[1]}”需要环境变量“${requiredEnv[2]}”，请设置或移除该引用。`
  if (detail?.startsWith('UNKNOWN_MODEL_DISPLAY_NAME:')) return '默认模型或任务路由引用了未登记的模型，请重新选择。'
  if (detail?.startsWith('AMBIGUOUS_MODEL_REFERENCE:')) return '存在同名模型，请明确选择所属服务商。'
  if (detail?.startsWith('UNKNOWN_MODEL_REFERENCE:')) return '有配置引用了未登记的模型，请重新选择供应商和模型。'
  if (detail === 'APPROVAL_REVIEW_REQUIRES_OLLAMA') return '审批复核只能使用本机 Ollama 模型。'
  if (detail?.startsWith('MODEL_PROVIDER_NOT_FOUND:')) return '有模型引用了不存在的服务商，请为该模型重新选择服务商。'
  if (detail?.startsWith('PROVIDER_PROTOCOL_REQUIRED:')) return '有服务商未选择协议类型。'
  if (detail?.startsWith('DUPLICATE_MODEL_DISPLAY_NAME:')) return '模型显示名称重复，请使用不同名称。'
  if (detail?.startsWith('INVALID_MODEL_PRICING:')) return '模型价格配置无效，请检查货币代码和价格数值。'
  if (detail === 'SKILL_TRUSTED_ROOT_MUST_BE_ABSOLUTE') return '受信任技能目录必须使用绝对路径。'
  if (detail === 'INVALID_ENABLED_CAPABILITY_LIST') return '能力列表包含无效或重复项目。'
  if (detail === 'INVALID_SKILL_SELECTION') return '技能列表格式无效。'
  return '请检查当前分类中的必填项、格式和模型引用。'
}

export function SettingsPage({ transport, canEditConfig, onClose, onOpenArchive, category, onCategoryChange, onDirtyChange }: { transport: PulseWebTransport; canEditConfig: boolean; onClose: () => void; onOpenArchive?: () => void; category?: string | undefined; onCategoryChange?: (category?: string) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const dialogs = usePulseDialogs()
  const [localCategoryId, setCategoryId] = useState('appearance')
  const categoryId = onCategoryChange ? category ?? 'appearance' : localCategoryId
  const [envelope, setEnvelope] = useState<ConfigEnvelope>()
  const [draft, setDraft] = useState<JsonObject>()
  const [advancedText, setAdvancedText] = useState('')
  const [advancedError, setAdvancedError] = useState('')
  const [requestError, setRequestError] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [localMobileDetail, setMobileDetail] = useState(false)
  const mobileDetail = onCategoryChange ? Boolean(category) : localMobileDetail
  useEffect(() => { onDirtyChange?.(dirty || Boolean(advancedError)) }, [dirty, advancedError, onDirtyChange])
  const contentEl = useRef<HTMLElement>(null)
  useEffect(() => { contentEl.current?.scrollTo({ top: 0 }) }, [categoryId, mobileDetail])
  const [appearance, setAppearance] = useState(() => {
    try { return { ...defaultAppearance, ...JSON.parse(localStorage.getItem('pulse-web-appearance') ?? '{}') } }
    catch { return defaultAppearance }
  })
  const selectedCategory = categories.find(item => item.id === categoryId) ?? categories[0]!

  const load = async () => {
    setRequestError('')
    if (!canEditConfig) return
    try {
      const value = await apiJson<ConfigEnvelope>(transport, '/api/config')
      setEnvelope(value); setDraft(value.config); setAdvancedText(JSON.stringify(value.config, null, 2)); setDirty(false)
    } catch (error) { setRequestError(error instanceof ApiError && error.status === 403 ? '只有本机管理会话可以读取完整配置。' : '配置暂时无法加载，请检查本机 Pulse 连接。') }
  }
  useEffect(() => { void load() }, [canEditConfig, transport])
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', listener)
    return () => window.removeEventListener('beforeunload', listener)
  }, [dirty])

  const configChanged = (next: JsonObject) => {
    setDraft(next); setAdvancedText(JSON.stringify(next, null, 2)); setAdvancedError(''); setDirty(true)
  }
  const setField = (path: string, value: unknown) => { if (draft) configChanged(setPath(draft, path, value)) }
  const changedPaths = useMemo(() => {
    if (!envelope || !draft) return []
    return [...new Set([...Object.keys(envelope.config), ...Object.keys(draft)])].filter(key => !deepEqual(envelope.config[key], draft[key]))
  }, [envelope, draft])

  const save = async () => {
    if (!envelope || !draft || saving) return
    setSaving(true); setRequestError('')
    try {
      const validation = await apiJson<{ valid: boolean; restartRequired: string[] }>(transport, '/api/config/validate', jsonRequest('POST', { config: draft }))
      if (!validation.valid) throw new Error('配置校验未通过。')
      const result = await apiJson<{ ok: boolean; path: string; version: string; applied: boolean; restartRequired: string[]; config: JsonObject }>(transport, '/api/config', jsonRequest('PUT', { version: envelope.version, config: draft }))
      setEnvelope(current => current ? { ...current, path: result.path, version: result.version, config: result.config, backupAvailable: true } : current)
      setDraft(result.config); setAdvancedText(JSON.stringify(result.config, null, 2)); setDirty(false)
      const status = result.restartRequired.length ? `已保存；${result.restartRequired.join('、')}将在重启后生效。` : result.applied ? '已保存并应用于新任务。' : '已保存；配置将在服务重启后生效。'
      window.dispatchEvent(new CustomEvent('pulse-toast', { detail: status }))
    } catch (error) {
      const message = error instanceof ApiError && error.status === 409
        ? '配置文件已被外部修改。为避免覆盖新内容，请重新加载后再编辑。'
        : error instanceof ApiError && error.status === 400
          ? `配置校验未通过：${describeValidationError(error.detail)}`
          : error instanceof Error ? error.message : '保存失败；原文件保持不变。'
      setRequestError(message)
    } finally { setSaving(false) }
  }
  const restore = async () => {
    if (!envelope || !await dialogs.confirm('用上一份备份替换当前配置？')) return
    setSaving(true)
    try {
      const result = await apiJson<{ version: string; config: JsonObject }>(transport, '/api/config/restore', jsonRequest('POST', { version: envelope.version }))
      setEnvelope(current => current ? { ...current, version: result.version, config: result.config, backupAvailable: true } : current)
      setDraft(result.config); setAdvancedText(JSON.stringify(result.config, null, 2)); setDirty(false)
      window.dispatchEvent(new CustomEvent('pulse-toast', { detail: '已恢复备份配置。' }))
    } catch (error) { setRequestError(error instanceof ApiError && error.status === 409 ? '配置已被外部修改，请重新加载后再恢复。' : '备份无法恢复；当前配置保持不变。') }
    finally { setSaving(false) }
  }
  const cancelChanges = async () => {
    if (dirty && !await dialogs.confirm('放弃所有未保存修改？')) return
    setRequestError('')
    if (envelope) { setDraft(envelope.config); setAdvancedText(JSON.stringify(envelope.config, null, 2)); setAdvancedError(''); setDirty(false) }
  }

  const selectCategory = (id: string) => { if (onCategoryChange) onCategoryChange(id); else { setCategoryId(id); setMobileDetail(true) } }
  const setAppearanceValue = (key: string, value: string) => {
    const next = { ...appearance, [key]: value }; setAppearance(next); localStorage.setItem('pulse-web-appearance', JSON.stringify(next))
    document.documentElement.dataset.theme = next.theme
    document.documentElement.dataset.interfaceScale = next.interfaceScale
    document.documentElement.dataset.codeScale = next.codeScale
  }
  useEffect(() => {
    document.documentElement.dataset.theme = appearance.theme
    document.documentElement.dataset.interfaceScale = appearance.interfaceScale
    document.documentElement.dataset.codeScale = appearance.codeScale
  }, [appearance])

  return <main className={`settings-shell ${mobileDetail ? 'settings-mobile-detail' : ''}`}>
    <aside className="settings-nav">
      <div className="settings-nav-header"><PulseButton className="icon-button" onClick={async () => { if (!onDirtyChange && dirty && !await dialogs.confirm('放弃未保存修改并返回聊天？')) return; onClose() }} aria-label="返回聊天"><Icon name="back"/></PulseButton><strong>设置</strong></div>
      <nav aria-label="设置分类">{categories.map(category => <PulseButton key={category.id} className={category.id === categoryId ? 'active' : ''} onClick={() => selectCategory(category.id)}><span>{category.label}</span>{category.id === 'advanced' && dirty && <i />}</PulseButton>)}</nav>
    </aside>
    <section className="settings-content" ref={contentEl}>
      <header className="settings-content-header"><PulseButton className="settings-back" onClick={() => { if (onCategoryChange) onCategoryChange(); else setMobileDetail(false) }}><Icon name="back"/> 分类</PulseButton><div><h1>{selectedCategory.label}</h1><p>{selectedCategory.description}</p></div><PulseButton className="icon-button settings-close" onClick={async () => { if (!onDirtyChange && dirty && !await dialogs.confirm('放弃未保存修改并返回聊天？')) return; onClose() }} aria-label="返回聊天"><Icon name="close"/></PulseButton></header>
      {requestError && <div className="settings-alert" role="alert">{requestError}{requestError.includes('外部修改') && <PulseButton onClick={() => void load()}>重新加载</PulseButton>}</div>}
      {categoryId === 'appearance' && <Card className="settings-card" variant="outlined"><SettingSelect label="主题" value={appearance.theme} options={['system', 'light', 'dark']} labels={['跟随系统', '浅色', '深色']} onChange={value => setAppearanceValue('theme', value)} /><SettingSelect label="界面字号" value={appearance.interfaceScale} options={['compact', 'standard', 'large']} labels={['较小', '标准', '较大']} onChange={value => setAppearanceValue('interfaceScale', value)} /><SettingSelect label="代码字号" value={appearance.codeScale} options={['compact', 'standard', 'large']} labels={['较小', '标准', '较大']} onChange={value => setAppearanceValue('codeScale', value)} /></Card>}
      {categoryId === 'archive' && <Card className="settings-card" variant="outlined"><p>归档聊天可以恢复到原项目；永久删除不可撤销。</p><Button type="primary" onClick={onOpenArchive}>打开归档对话</Button></Card>}
      {categoryId !== 'appearance' && categoryId !== 'archive' && !canEditConfig && <div className="settings-card">完整后台配置只在本机管理页开放。手机仍可更改外观并管理归档对话。</div>}
      {categoryId !== 'appearance' && categoryId !== 'archive' && canEditConfig && <>
        {categoryId === 'advanced' ? <div className="settings-card advanced-editor"><div className="settings-meta"><strong>配置文件</strong><code>{envelope?.path ?? '正在读取…'}</code><span>API Key 仅通过环境变量提供。已保存的 Jarvis 与 MCP 环境变量以“保留已保存值”显示；替换为新值或删除对应字段即可修改。</span></div><PulseTextArea aria-label="完整配置 JSON" spellCheck={false} value={advancedText} onChange={event => { const text = event.target.value; setAdvancedText(text); try { const parsed = JSON.parse(text) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是 JSON 对象'); setDraft(parsed as JsonObject); setAdvancedError(''); setDirty(!deepEqual(parsed, envelope?.config)) } catch (error) { setDirty(true); setAdvancedError(error instanceof Error ? error.message : 'JSON 格式错误') } }} /><div className="json-actions"><PulseButton onClick={() => { setAdvancedText(JSON.stringify(draft ?? {}, null, 2)); setAdvancedError(''); setDirty(!deepEqual(draft, envelope?.config)) }}>格式化草稿</PulseButton><PulseButton disabled={!envelope?.backupAvailable || saving} onClick={() => void restore()}>恢复上一份备份</PulseButton></div>{advancedError && <p className="settings-error">{advancedError}</p>}{changedPaths.length > 0 && <PulseDisclosure className="change-preview" label={<>变更预览（{changedPaths.length}个顶层字段）</>}><pre>{changedPaths.map(key => `${key}: ${JSON.stringify(envelope?.config[key]) ?? '（新增）'} → ${JSON.stringify(draft?.[key]) ?? '（删除）'}`).join('\n')}</pre></PulseDisclosure>}</div> : <div className="settings-card">
          <div className="settings-meta"><strong>配置文件</strong><code>{envelope?.path ?? '正在读取…'}</code><span>修改保存在同一份 JSON 草稿中，保存后用于新任务。旧任务继续使用启动时配置。</span></div>
          {draft && categoryId === 'models' ? <ModelsEditor transport={transport} config={draft} envStatus={envelope?.environment ?? {}} onChange={configChanged} /> : draft && categoryId === 'routing' ? <RoutingEditor config={draft} onChange={configChanged} /> : draft && categoryId === 'mcp' ? <McpEditor config={draft} onChange={configChanged} /> : draft && categoryId === 'tools' ? <ToolsEditor config={draft} onChange={configChanged} /> : draft && categoryId === 'network' ? <NetworkEditor config={draft} onChange={configChanged} /> : draft && categoryId === 'instructions' ? <InstructionsEditor config={draft} onChange={configChanged} /> : draft && ['front','approval','jarvis','runtime'].includes(categoryId) ? <FeatureEditor category={categoryId} config={draft} onChange={configChanged} /> : selectedCategory.paths.map(path => <ConfigField key={path} path={path} value={draft ? getPath(draft, path) : undefined} envStatus={envelope?.environment ?? {}} disabled={!draft || saving} onChange={value => setField(path, value)} />)}
          {categoryId === 'models' && draft && <div className="settings-meta"><strong>当前生效模型</strong><span>{envelope?.active?.provider && envelope?.active?.model ? `${envelope.active.provider} · ${envelope.active.model}` : '当前配置尚未提供实际生效模型信息'}</span><small>来源覆盖：{Object.keys(envelope?.sources ?? {}).join('、') || '未检测到环境覆盖'}</small></div>}
          {categoryId === 'runtime' && <p className="restart-note">工作目录或数据目录属于启动设置，保存后需重启 Pulse 才会完全生效。</p>}
        </div>}
        <footer className="settings-actions"><span>{dirty ? '有未保存的修改' : envelope ? '所有修改已保存' : ''}</span><PulseButton disabled={(!dirty && !advancedError) || saving} onClick={cancelChanges}>取消修改</PulseButton><PulseButton className="settings-primary" disabled={!dirty || saving || Boolean(advancedError)} onClick={() => void save()}>{saving ? '正在校验并保存…' : '保存全部'}</PulseButton></footer>
      </>}
    </section>
  </main>
}

function SettingSelect({ label, value, options, labels, onChange }: { label: string; value: string; options: string[]; labels: string[]; onChange: (value: string) => void }) {
  return <label className="settings-row"><span>{label}</span><Select value={value} options={options.map((option, index) => ({ value: option, label: labels[index] }))} onChange={onChange} /></label>
}

function ConfigField({ path, value, envStatus, disabled, onChange }: { path: string; value: unknown; envStatus: Record<string, boolean>; disabled: boolean; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2))
  const [error, setError] = useState('')
  useEffect(() => setText(value === undefined ? '' : JSON.stringify(value, null, 2)), [value])
  const label = path.split('.').at(-1) ?? path
  const pretty = configLabels[path] ?? configLabels[label] ?? label.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`).replace(/^./, letter => letter.toUpperCase())
  if (typeof value === 'boolean') return <label className="settings-row"><span>{pretty}</span><Switch checked={value} disabled={disabled} onChange={onChange} /></label>
  if (typeof value === 'string') return <label className="settings-input-row"><span>{pretty}{path.endsWith('apiKeyEnv') && <small>{envStatus[value] ? '环境变量已设置' : '环境变量未设置'}</small>}</span><Input value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></label>
  if (typeof value === 'number') return <label className="settings-input-row"><span>{pretty}</span><InputNumber value={value} disabled={disabled} onChange={next => next !== null && onChange(next)} /></label>
  return <label className="settings-json-row"><span>{pretty}<small>该字段包含复杂结构，可在高级配置中编辑；此处保留未知配置。</small></span><Input.TextArea spellCheck={false} value={text} disabled={disabled} onChange={event => { setText(event.target.value); try { const parsed = event.target.value.trim() ? JSON.parse(event.target.value) : undefined; onChange(parsed); setError('') } catch { setError('JSON 格式错误，修正后会加入当前草稿。') } }} />{error && <small className="settings-error">{error}</small>}</label>
}

type Obj = Record<string, any>
function asObject(value: unknown): Obj { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
function updateObject(config: Obj, path: string, value: unknown, onChange: (next: Obj) => void) { onChange(setPath(config, path, value)) }
function TextControl({ label, value, hint, placeholder, onChange }: { label: string; value: unknown; hint?: string; placeholder?: string; onChange: (value: string) => void }) { return <label className="field-control"><span>{label}{hint && <small>{hint}</small>}</span><Input value={typeof value === 'string' ? value : ''} placeholder={placeholder} onChange={event => onChange(event.target.value)} /></label> }
function NumberControl({ label, value, unit, min, max, onChange }: { label: string; value: unknown; unit?: string; min?: number; max?: number; onChange: (value: number) => void }) { return <label className="field-control"><span>{label}</span><div className="number-control"><InputNumber<number> {...(min === undefined ? {} : { min })} {...(max === undefined ? {} : { max })} value={typeof value === 'number' ? value : null} onChange={next => next !== null && onChange(Number(next))} />{unit && <small>{unit}</small>}</div></label> }
function SelectControl({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) { return <label className="field-control"><span>{label}</span><Select value={value} options={options} onChange={onChange} /></label> }
function ToggleControl({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="toggle-control"><span><strong>{label}</strong><small>{description}</small></span><Switch checked={checked} onChange={onChange} /></label> }
function ArrayControl({ label, value, onChange, placeholder = '输入内容' }: { label: string; value: unknown; onChange: (value: string[]) => void; placeholder?: string }) {
  const items = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
  return <section className="array-control"><header><strong>{label}</strong><PulseButton type="button" onClick={() => onChange([...items, ''])}>添加</PulseButton></header>{items.length ? items.map((item, index) => <div className="array-row" key={`${index}-${item}`}><PulseInput value={item} placeholder={placeholder} onChange={event => onChange(items.map((entry, i) => i === index ? event.target.value : entry))} /><PulseButton type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => onChange(items.filter((_, i) => i !== index))}>删除</PulseButton></div>) : <p className="editor-empty">尚未添加。点击“添加”创建第一项。</p>}</section>
}
function modelRef(providerId: string, modelId: string): string { return `${providerId}/${modelId}` }
function splitModelRef(value: unknown): { providerId: string; modelId: string } | undefined {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf('/')
  return separator > 0 && separator < value.length - 1 ? { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) } : undefined
}
function ModelPicker({ providers, value, onChange, allowFollowDefault = false, localOllamaOnly = false }: { providers: Obj; value: unknown; onChange: (value: string | undefined) => void; allowFollowDefault?: boolean; localOllamaOnly?: boolean }) {
  const current = splitModelRef(value)
  const [providerId, setProviderId] = useState(current?.providerId ?? '')
  useEffect(() => { if (current) setProviderId(current.providerId) }, [current?.providerId])
  const eligible = Object.entries(providers).filter(([, raw]) => {
    const provider = asObject(raw)
    if (!localOllamaOnly) return true
    if (provider.provider !== 'ollama') return false
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(provider.baseURL ?? 'http://127.0.0.1:11434').hostname) }
    catch { return false }
  })
  const selectedProviderId = eligible.some(([id]) => id === providerId) ? providerId : ''
  const models = asObject(asObject(providers[selectedProviderId]).models)
  const selectedModel = current && selectedProviderId === current.providerId && models[current.modelId] ? current.modelId : ''
  return <div className="model-picker"><label className="field-control"><span>服务商</span><PulseSelect value={selectedProviderId} onChange={event => { setProviderId(event); onChange(undefined) }}><option value="">选择服务商</option>{eligible.map(([id, raw]) => <option key={id} value={id}>{asObject(raw).name ?? id} · {id}</option>)}</PulseSelect></label><label className="field-control"><span>模型</span><PulseSelect value={selectedModel} disabled={!selectedProviderId} onChange={event => onChange(event ? modelRef(selectedProviderId, event) : undefined)}><option value="">{selectedProviderId ? '选择模型' : '先选择服务商'}</option>{Object.entries(models).map(([id, raw]) => <option key={id} value={id}>{asObject(raw).displayName ?? id} · {id}</option>)}</PulseSelect></label>{allowFollowDefault && <PulseButton type="button" className="settings-secondary model-follow-default" onClick={() => onChange(undefined)}>跟随默认模型</PulseButton>}</div>
}
function ModelsEditor({ config, envStatus, onChange, transport }: { transport: PulseWebTransport; config: Obj; envStatus: Record<string, boolean>; onChange: (next: Obj) => void }) {
  const dialogs = usePulseDialogs()
  const providers = asObject(config.providers)
  const updateProviders = (next: Obj) => onChange({ ...structuredClone(config), providers: next })
  const updateProvider = (providerId: string, update: (provider: Obj) => Obj) => updateProviders({ ...providers, [providerId]: update(asObject(providers[providerId])) })
  const updateModel = (providerId: string, modelId: string, update: (model: Obj) => Obj) => updateProvider(providerId, provider => ({ ...provider, models: { ...asObject(provider.models), [modelId]: update(asObject(asObject(provider.models)[modelId])) } }))
  const addProvider = () => { let id = `provider-${Object.keys(providers).length + 1}`; while (providers[id]) id += '-new'; updateProviders({ ...providers, [id]: { provider: 'openai-compatible', name: '新服务商', baseURL: '', apiKeyEnv: '', models: {} } }) }
  const addModel = (providerId: string) => { const models = asObject(asObject(providers[providerId]).models); let id = `model-${Object.keys(models).length + 1}`; while (models[id]) id += '-new'; updateModel(providerId, id, () => ({ displayName: '新模型', modelCode: '' })) }
  const references = (id: string) => {
    const refs: string[] = []
    if (config.activeModel === id) refs.push('默认模型')
    if (config.assistantModel === id) refs.push('助理聊天模型')
    for (const [task, route] of Object.entries(asObject(config.taskRouting))) if (Array.isArray(route) && route.includes(id)) refs.push(`路由/${task}`)
    if (asObject(config.frontModel).model === id) refs.push('即时预回复')
    if (asObject(config.approvalReview).model === id) refs.push('审批复核')
    return refs
  }
  return <div className="specialized-editor">
    <section className="editor-section"><header className="editor-section-head"><div><h2>服务商与模型</h2><p>模型属于服务商；不同服务商可以配置同名模型。</p></div><PulseButton type="button" className="settings-secondary" onClick={addProvider}>＋ 添加服务商</PulseButton></header>
      {Object.entries(providers).map(([id, raw]) => { const provider = asObject(raw), models = asObject(provider.models); return <article className="config-entity" key={id}><header><div><strong>{provider.name || id}</strong><small>{id} · {provider.provider || '未设置类型'}</small></div><PulseButton type="button" className="settings-danger" disabled={Object.keys(models).length > 0} title={Object.keys(models).length ? '请先移除该服务商下的模型' : '删除服务商'} onClick={() => { const next = { ...providers }; delete next[id]; updateProviders(next) }}>删除服务商</PulseButton></header>
        <div className="field-grid"><TextControl label="显示名称" value={provider.name} onChange={value => updateProvider(id, item => ({ ...item, name: value }))} /><SelectControl label="协议类型" value={provider.provider ?? ''} options={['openai-compatible','openai','deepseek','anthropic','ollama','mock'].map(value => ({ value, label: value }))} onChange={value => updateProvider(id, item => ({ ...item, provider: value }))} /><TextControl label="服务地址" value={provider.baseURL} placeholder="https://api.example.com/v1" onChange={value => updateProvider(id, item => ({ ...item, baseURL: value }))} /><TextControl label="API Key 环境变量" value={provider.apiKeyEnv} hint={provider.apiKeyEnv ? envStatus[provider.apiKeyEnv] ? '环境变量已设置' : '环境变量未设置' : '此服务商无需密钥'} placeholder="PROVIDER_API_KEY" onChange={value => updateProvider(id, item => ({ ...item, apiKeyEnv: value }))} />{typeof provider.maxContextTokens === 'number' && <NumberControl label="默认上下文上限" value={provider.maxContextTokens} unit="tokens" min={1} onChange={value => updateProvider(id, item => ({ ...item, maxContextTokens: value }))} />}{typeof provider.maxOutputTokens === 'number' && <NumberControl label="默认输出上限" value={provider.maxOutputTokens} unit="tokens" min={1} onChange={value => updateProvider(id, item => ({ ...item, maxOutputTokens: value }))} />}</div>
        <section className="provider-models"><header className="editor-section-head"><div><h3>模型</h3><p>模型代码是发送给该服务商的实际 ID。</p></div><PulseButton type="button" className="settings-secondary" onClick={() => addModel(id)}>＋ 添加模型</PulseButton></header>
          {Object.entries(models).map(([modelId, rawModel]) => { const model = asObject(rawModel), ref = modelRef(id, modelId), refs = references(ref); return <article className="config-entity provider-model" key={modelId}><header><div><strong>{model.displayName || modelId}</strong><small>{ref} · {model.modelCode || '模型代码未设置'}</small></div><PulseButton type="button" className="settings-danger" disabled={refs.length > 0} title={refs.length ? `被配置引用：${refs.join('、')}` : '删除模型'} onClick={() => updateProvider(id, item => { const next = { ...asObject(item.models) }; delete next[modelId]; return { ...item, models: next } })}>删除模型</PulseButton></header><div className="field-grid"><TextControl label="显示名称" value={model.displayName} onChange={value => updateModel(id, modelId, item => ({ ...item, displayName: value }))} /><TextControl label="模型代码" value={model.modelCode} onChange={value => updateModel(id, modelId, item => ({ ...item, modelCode: value }))} /><SelectControl label="推理强度" value={model.reasoningEffort ?? 'medium'} options={['low','medium','high'].map(value => ({ value, label: value === 'low' ? '低' : value === 'high' ? '高' : '中' }))} onChange={value => updateModel(id, modelId, item => ({ ...item, reasoningEffort: value }))} /><SelectControl label="图像输入" value={model.imageInput ?? 'unknown'} options={[{value: 'unknown', label: '待验证'}, {value: 'supported', label: '支持'}, {value: 'unsupported', label: '不支持'}]} onChange={value => updateModel(id, modelId, item => ({...item, imageInput: value}))} /><PulseButton type="button" className="settings-secondary" onClick={()=>{void apiJson<{accepted:boolean}>(transport,'/api/automation/vision-probe',jsonRequest('POST',{model:ref})).then(result=>{if(result.accepted)updateModel(id,modelId,item=>({...item,imageInput:'supported'}))}).catch(error=>dialogs.alert(`图像协议检测失败，请先保存配置：${String(error)}`))}}>检测已保存模型的图像输入</PulseButton><NumberControl label="上下文上限" value={model.maxContextTokens} unit="tokens" min={1} onChange={value => updateModel(id, modelId, item => ({ ...item, maxContextTokens: value }))} /><NumberControl label="输出上限" value={model.maxOutputTokens} unit="tokens" min={1} onChange={value => updateModel(id, modelId, item => ({ ...item, maxOutputTokens: value }))} /><NumberControl label="每百万输入价格" value={model.pricing?.inputPerMillion} unit={model.pricing?.currency ?? 'USD'} min={0} onChange={value => updateModel(id, modelId, item => ({ ...item, pricing: { ...asObject(item.pricing), inputPerMillion: value } }))} /><NumberControl label="每百万输出价格" value={model.pricing?.outputPerMillion} unit={model.pricing?.currency ?? 'USD'} min={0} onChange={value => updateModel(id, modelId, item => ({ ...item, pricing: { ...asObject(item.pricing), outputPerMillion: value } }))} /></div>{refs.length > 0 && <small className="field-note">当前使用位置：{refs.join('、')}</small>}</article> })}
        </section></article> })}
      {!Object.keys(providers).length && <p className="editor-empty">暂无服务商配置。</p>}
    </section>
    <section className="editor-section"><h2>模型用途</h2><p>先选择服务商，再从该服务商的模型中选择。</p><label className="field-control"><span>默认模型<small>用于没有单独任务路由的请求</small></span></label><ModelPicker providers={providers} value={config.activeModel} onChange={value => onChange({ ...structuredClone(config), activeModel: value })} /><label className="field-control"><span>助理聊天模型<small>聊天模式专用</small></span></label><ModelPicker providers={providers} value={config.assistantModel} allowFollowDefault onChange={value => onChange({ ...structuredClone(config), assistantModel: value })} />
    </section>
  </div>
}
function RoutingEditor({ config, onChange }: { config: Obj; onChange: (next: Obj) => void }) {
  const providers = asObject(config.providers), routing = asObject(config.taskRouting)
  const tasks = [{ id: 'reason', label: '推理' }, { id: 'plan', label: '规划' }, { id: 'merge', label: '汇总' }, { id: 'verify', label: '验收' }, { id: 'vision', label: '视觉执行' }]
  const setList = (task: string, value: string[]) => onChange(setPath(config, `taskRouting.${task}`, value))
  return <div className="specialized-editor routing-editor">{tasks.map(task => {
    const list = Array.isArray(routing[task.id]) ? routing[task.id] as string[] : []
    return <section className="route-card" key={task.id}>
      <header><div><h2>{task.label}</h2><p>按顺序尝试；首个模型为首选，其余为故障回退。</p></div><PulseButton type="button" className="settings-secondary" onClick={() => setList(task.id, [...list, ''])}>＋ 添加模型</PulseButton></header>
      {list.length ? list.map((modelId, index) => <div className="route-row" key={`${index}-${modelId}`}>
        <span className="route-rank">{index === 0 ? '首选' : `回退 ${index}`}</span>
        <ModelPicker providers={providers} value={modelId} onChange={value => setList(task.id, list.map((item, i) => i === index ? value ?? '' : item))} />
        <PulseButton type="button" className="route-move-up" disabled={index === 0} aria-label="上移" onClick={() => { const next = [...list]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setList(task.id, next) }}>↑</PulseButton>
        <PulseButton type="button" className="route-move-down" disabled={index === list.length - 1} aria-label="下移" onClick={() => { const next = [...list]; [next[index + 1], next[index]] = [next[index + 1]!, next[index]!]; setList(task.id, next) }}>↓</PulseButton>
        <PulseButton type="button" className="settings-danger" aria-label="移除路由模型" onClick={() => setList(task.id, list.filter((_, i) => i !== index))}>移除</PulseButton>
      </div>) : <p className="editor-empty">使用默认模型；添加后可指定首选和回退顺序。</p>}
    </section>
  })}</div>
}
function McpEditor({ config, onChange }: { config: Obj; onChange: (next: Obj) => void }) {
  const capabilities = asObject(config.capabilities), servers = asObject(capabilities.mcpServers)
  const patch = (id: string, key: string, value: unknown) => onChange(setPath(config, `capabilities.mcpServers.${id}.${key}`, value))
  const patchMap = (id: string, key: 'env' | 'envFrom' | 'toolPolicies', name: string, value: string | undefined) => { const current = { ...asObject(asObject(servers[id])[key]) }; if (value === undefined) delete current[name]; else current[name] = value; patch(id, key, current) }
  const add = () => { let id = `server-${Object.keys(servers).length + 1}`; while (servers[id]) id += '-new'; onChange(setPath(config, `capabilities.mcpServers.${id}`, { command: '', args: [], timeoutMs: 30000, env: {}, envFrom: {}, toolPolicies: {} })) }
  return <div className="specialized-editor"><header className="editor-section-head"><div><h2>MCP 服务</h2><p>每个服务会启动一个本机进程。环境值仅在保存后由后台使用。</p></div><PulseButton type="button" className="settings-secondary" onClick={add}>＋ 添加服务</PulseButton></header>{Object.entries(servers).map(([id, raw]) => { const server = asObject(raw); return <article className="config-entity" key={id}><header><div><strong>{id}</strong><small>{server.command || '尚未设置启动命令'}</small></div><PulseButton type="button" className="settings-danger" onClick={() => { const next = { ...servers }; delete next[id]; onChange(setPath(config, 'capabilities.mcpServers', next)) }}>删除服务</PulseButton></header><div className="field-grid"><TextControl label="启动命令" value={server.command} onChange={value => patch(id, 'command', value)} /><TextControl label="工作目录" value={server.cwd} placeholder="留空使用 Pulse 工作目录" onChange={value => patch(id, 'cwd', value)} /><NumberControl label="启动超时" value={server.timeoutMs} unit="毫秒" min={1000} max={300000} onChange={value => patch(id, 'timeoutMs', value)} /></div><ArrayControl label="命令参数" value={server.args} placeholder="--option" onChange={value => patch(id, 'args', value)} /><MapControl title="环境变量" value={server.env} onChange={(key, value) => patchMap(id, 'env', key, value)} secret /><MapControl title="环境变量引用" value={server.envFrom} onChange={(key, value) => patchMap(id, 'envFrom', key, value)} /><MapControl title="工具权限" value={server.toolPolicies} onChange={(key, value) => patchMap(id, 'toolPolicies', key, value)} options={['read','write','external']} /></article> })}{!Object.keys(servers).length && <p className="editor-empty">尚未登记 MCP 服务。</p>}</div>
}
function MapControl({ title, value, onChange, secret = false, options }: { title: string; value: unknown; onChange: (key: string, value: string | undefined) => void; secret?: boolean; options?: string[] }) {
  const entries = Object.entries(asObject(value))
  const add = () => { let index = entries.length + 1, key = `NEW_${index}`; while (Object.prototype.hasOwnProperty.call(asObject(value), key)) key = `NEW_${++index}`; onChange(key, '') }
  return <section className="map-control"><header><strong>{title}</strong><PulseButton type="button" onClick={add}>添加</PulseButton></header>{entries.map(([key, val]) => { const retained = secret && val === '__PULSE_KEEP_SECRET__'; return <div className="map-row" key={key}><PulseInput aria-label={`${title}变量名`} value={key} readOnly /><div>{options ? <PulseSelect value={String(val)} onChange={event => onChange(key, event)}>{options.map(option => <option key={option}>{option}</option>)}</PulseSelect> : <><PulseInput type={secret ? 'password' : 'text'} autoComplete="new-password" placeholder={secret ? retained ? '已保存值会保留；输入新值可替换' : '输入环境变量值' : '值或源环境变量名'} value={retained ? '' : String(val)} onChange={event => onChange(key, event.target.value)} />{retained && <small className="secret-hint">已保存 · 留空保留</small>}</>}</div><PulseButton type="button" className="settings-danger" aria-label={`删除${title} ${key}`} onClick={() => onChange(key, undefined)}>删除</PulseButton></div> })}</section>
}
function ToolsEditor({ config, onChange }: { config: Obj; onChange: (next: Obj) => void }) {
  const caps = asObject(config.capabilities), enabled = Array.isArray(caps.enabled) ? caps.enabled as string[] : []
  const known = [...new Set(['pdf','spreadsheet','browser','computer','skills',...Object.keys(asObject(caps.mcpServers)),...enabled])]; const descriptions: Record<string,string> = { pdf:'读取工作区内 PDF 文档。', spreadsheet:'读取工作区内电子表格。', browser:'使用 Playwright 操作浏览器。', computer:'操作本机桌面，需要系统截屏和输入权限。', skills:'按需加载可信技能指引。', mcp:'连接本机登记的 MCP 服务。' }
  const toggle = (id: string, checked: boolean) => onChange(setPath(config, 'capabilities.enabled', checked ? [...new Set([...enabled,id])] : enabled.filter(item => item !== id)))
  return <div className="specialized-editor"><section className="editor-section"><header className="editor-section-head"><div><h2>工具能力</h2><p>关闭能力会阻止新任务使用该工具。当前安装的扩展以配置的能力 ID 为准。</p></div></header>{known.map(id => <ToggleControl key={id} label={id} description={descriptions[id] ?? (id === 'mcp' || asObject(caps.mcpServers)[id] ? `连接已登记的 MCP 服务“${id}”。` : '已配置的宿主扩展能力。')} checked={enabled.includes(id)} onChange={value => toggle(id, value)} />)}</section><SelectControl label="浏览器连接模式" value={asObject(caps.browser).mode ?? 'dedicated'} options={[{value:'dedicated',label:'专用浏览器'},{value:'existing',label:'现有 Chrome/Edge（扩展连接）'}]} onChange={value=>onChange(setPath(config,'capabilities.browser.mode',value))}/><SelectControl label="专用浏览器" value={asObject(caps.browser).channel ?? 'chromium'} options={[{value:'chromium',label:'Chromium'},{value:'chrome',label:'Chrome'},{value:'msedge',label:'Edge'}]} onChange={value=>onChange(setPath(config,'capabilities.browser.channel',value))}/><TextControl label="Desktop Helper 路径" value={asObject(caps.computer).helperPath} onChange={value=>onChange(setPath(config,'capabilities.computer.helperPath',value))}/><ArrayControl label="技能选择" value={caps.skills} placeholder="技能名称（留空表示自动发现）" onChange={value => onChange(setPath(config, 'capabilities.skills', value))} /><ArrayControl label="受信任的技能目录" value={caps.trustedSkillRoots} placeholder="绝对目录路径" onChange={value => onChange(setPath(config, 'capabilities.trustedSkillRoots', value))} /></div>
}
function NetworkEditor({ config, onChange }: { config: Obj; onChange: (next: Obj) => void }) { return <div className="specialized-editor"><ToggleControl label="允许网络访问" description="允许工具连接下方明确列出的主机。" checked={Boolean(config.allowNetwork)} onChange={value => onChange({ ...config, allowNetwork: value })} /><ArrayControl label="允许访问的主机" value={config.networkHosts} placeholder="example.com" onChange={value => onChange({ ...config, networkHosts: value })} /></div> }
function SecretControl({ label, value, onChange }: { label: string; value: unknown; onChange: (value: string | undefined) => void }) { const retained = value === '__PULSE_KEEP_SECRET__'; return <label className="field-control secret-control"><span>{label}<small>{retained ? '当前有已保存值；留空保留，输入新值替换。' : '令牌不会回显到页面。'}</small></span><div className="secret-input"><Input.Password autoComplete="new-password" value={retained ? '' : typeof value === 'string' ? value : ''} placeholder={retained ? '已保存的访问令牌' : '输入访问令牌'} onChange={event => onChange(event.target.value)} /><Button danger disabled={!retained && !value} onClick={() => onChange(undefined)}>删除</Button></div></label> }
function InstructionsEditor({ config, onChange }: { config: Obj; onChange: (next: Obj) => void }) { return <div className="specialized-editor"><label className="prompt-editor"><span><strong>系统指令</strong><small>作为 Pulse 的基础工作指引。不要在此填写 API 密钥或认证信息。</small></span><PulseTextArea rows={12} value={typeof config.systemPrompt === 'string' ? config.systemPrompt : ''} onChange={event => onChange({ ...config, systemPrompt: event.target.value })} placeholder="输入系统指令" /></label><TextControl label="指令文件路径" hint="配置文件与指令文件同时存在时，由运行配置规则决定实际来源。" value={config.systemPromptFile} onChange={value => onChange({ ...config, systemPromptFile: value })} /></div> }
function FeatureEditor({ category, config, onChange }: { category: string; config: Obj; onChange: (next: Obj) => void }) {
  const patch = (path: string, value: unknown) => onChange(setPath(config, path, value))
  if (category === 'front') {
    const front = asObject(config.frontModel), providers = asObject(config.providers)
    return <div className="specialized-editor"><ToggleControl label="启用即时预回复" description="在正式任务开始前生成简短回复。" checked={Boolean(front.enabled)} onChange={value => patch('frontModel.enabled', value)} /><section className="editor-section"><h2>预回复模型</h2><p>从已登记的供应商模型中选择。</p><ModelPicker providers={providers} value={front.model} onChange={value => patch('frontModel.model', value)} /><NumberControl label="超时时间" value={front.timeoutMs ?? 15000} unit="毫秒" min={1000} max={120000} onChange={value => patch('frontModel.timeoutMs', value)} /></section></div>
  }
  if (category === 'approval') {
    const review = asObject(config.approvalReview), providers = asObject(config.providers)
    return <div className="specialized-editor"><section className="editor-section"><h2>全局审批模式</h2><p>仅影响新任务的工具审批；聊天栏的人工／自动审核选择全局生效并自动保存。</p><SelectControl label="全局审批模式" value={config.approvalMode ?? 'ask'} options={[{value:'read-only',label:'只读'},{value:'ask',label:'人工审核'},{value:'auto',label:'自动审核'}]} onChange={value=>patch('approvalMode',value)} /></section><section className="editor-section"><h2>审批复核模型</h2><p>只使用本机 Ollama；业务问题、风险不明和模型错误会转回人工。</p><ModelPicker providers={providers} value={review.model} localOllamaOnly onChange={value => patch('approvalReview.model', value)} /><NumberControl label="超时时间" value={review.timeoutMs ?? 15000} unit="毫秒" min={1000} max={60000} onChange={value => patch('approvalReview.timeoutMs', value)} /></section></div>
  }
  if (category === 'jarvis') {
    const jarvis = asObject(config.jarvis)
    return <div className="specialized-editor"><ToggleControl label="连接 Jarvis 记忆服务" description="开启后，任务准备阶段会查询并筛选相关记忆。" checked={Boolean(jarvis.enabled)} onChange={value=>patch('jarvis.enabled',value)} /><section className="editor-section"><h2>连接与上下文</h2><div className="field-grid"><TextControl label="服务地址" value={jarvis.apiUrl ?? 'http://127.0.0.1:7330'} onChange={value=>patch('jarvis.apiUrl',value)} /><SecretControl label="访问令牌" value={jarvis.token} onChange={value=>patch('jarvis.token',value)} /><NumberControl label="上下文预算" value={jarvis.contextTokenBudget ?? 4000} unit="tokens" min={256} max={32000} onChange={value=>patch('jarvis.contextTokenBudget',value)} /></div><ToggleControl label="允许远程连接" description="仅在 Jarvis 服务部署在其他设备时开启。" checked={Boolean(jarvis.allowRemote)} onChange={value=>patch('jarvis.allowRemote',value)} /><ToggleControl label="自动记录候选记忆" description="任务结束时生成候选记录，仍需审核后才会进入长期记忆。" checked={jarvis.autoCandidate !== false} onChange={value=>patch('jarvis.autoCandidate',value)} /></section></div>
  }
  if (category === 'runtime') return <div className="specialized-editor"><section className="editor-section"><h2>工作区与存储</h2><p>目录设置在服务重启后生效；修改数据目录不会在线迁移现有记录。</p><div className="field-grid"><TextControl label="默认工作目录" value={config.cwd} onChange={value=>patch('cwd',value)} /><TextControl label="数据目录" value={config.dataDir} onChange={value=>patch('dataDir',value)} /></div><div className="restart-note">更改数据目录后需重启 Pulse 才会生效。</div></section><section className="editor-section"><h2>任务限制</h2><div className="field-grid"><NumberControl label="最大执行轮数" value={config.maxTurns ?? 32} unit="轮" min={1} max={200} onChange={value=>patch('maxTurns',value)} /><NumberControl label="单次运行时限" value={config.maxRuntimeMs ?? 900000} unit="毫秒" min={1000} max={86400000} onChange={value=>patch('maxRuntimeMs',value)} /><NumberControl label="自动压缩阈值" value={config.autoCompactPercent ?? 90} unit="%" min={1} max={90} onChange={value=>patch('autoCompactPercent',value)} /></div></section></div>
  return null
}
