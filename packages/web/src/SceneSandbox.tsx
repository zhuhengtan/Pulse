import { useEffect, useRef, useState } from 'react'
import { Button, Card, Tag } from 'antd'
import { usePulseDialogs } from './PulseControls.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

type DeviceId = 'scene:lamp-a' | 'scene:lamp-b'
type State = { power?: boolean; brightness?: number }
type Step = { deviceId: DeviceId; desiredState: State }
type Fault = 'none' | 'reject-second' | 'disconnect-second'
type Action = { action: 'enable' | 'disable' | 'preview' } | { action: 'configure'; name: string; steps: Step[] } | { action: 'execute'; previewId: string; version: number; fault: Fault }
interface Snapshot {
  enabled: boolean
  busy: boolean
  simulated: true
  realDevices: false
  automaticRollback: false
  automaticRetry: false
  version: number
  scene: { name: string; steps: Step[] }
  devices: Array<{ deviceId: DeviceId; name: string; state: { power: boolean; brightness: number } }>
  preview?: { previewId: string; version: number; expiresAt: number; steps: Array<{ index: number; deviceId: DeviceId; from: State; to: State }>; atomic: false }
  run?: { runId: string; version: number; status: 'running' | 'completed'; outcome?: 'all-observed' | 'partial' | 'uncertain' | 'failed'; atomic: false; steps: Array<{ index: number; deviceId: DeviceId; status: string; commandId?: string; reason?: string }> }
  cleanup: { state: 'idle' | 'completed' | 'unconfirmed' }
  lastError?: string
}
interface Draft { name: string; steps: Array<{ deviceId: DeviceId; power: '' | 'on' | 'off'; brightness: string }> }
interface Scope {
  transport: PulseWebTransport
  active: boolean
  pending: boolean
  confirming: boolean
  needsRefresh: boolean
  initialized: boolean
  snapshot?: Snapshot
  draft: Draft
  fault: Fault
  saved?: string
  readyPreview?: string
  error: string
  controller?: AbortController
}
interface View { context?: Scope; pending: boolean; confirming: boolean; needsRefresh: boolean; snapshot?: Snapshot; draft: Draft; fault: Fault; error: string }
const endpoint = '/api/device-use/scene-sandbox'
const deviceNames: Record<DeviceId, string> = { 'scene:lamp-a': '虚拟灯 A', 'scene:lamp-b': '虚拟灯 B' }
const faults: Record<Fault, string> = { none: '无故障', 'reject-second': '第二步拒绝执行', 'disconnect-second': '第二步断连，结果未知' }
const statuses: Record<string, string> = {
  pending: '模拟步骤等待处理，尚未受理', accepted: '模拟请求已受理，尚未发送', sent: '模拟请求已发送，尚未确认', observed: '模拟状态已核对，不代表真实设备执行',
  failed: '模拟步骤失败', unknown: '模拟结果未知，不能推定成功', cancelled: '模拟步骤在发送前取消', expired: '模拟步骤在发送前过期', 'not-accepted': '模拟步骤未受理',
}
const cleanupLabels = { idle: '尚未清理', completed: '模拟清理已确认', unconfirmed: '模拟清理未确认' }
const defaultDraft = (): Draft => ({ name: '模拟双灯场景', steps: [
  { deviceId: 'scene:lamp-a', power: 'on', brightness: '30' }, { deviceId: 'scene:lamp-b', power: 'on', brightness: '60' },
] })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const deviceId = (value: unknown): value is DeviceId => value === 'scene:lamp-a' || value === 'scene:lamp-b'
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
function state(value: unknown): value is State {
  return record(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => key === 'power' || key === 'brightness')
    && (value.power === undefined || typeof value.power === 'boolean')
    && (value.brightness === undefined || finite(value.brightness) && value.brightness >= 0 && value.brightness <= 100)
}
function desired(value: unknown): value is State {
  return state(value) && !(value.power === false && (value.brightness ?? 0) > 0) && !(value.power === true && value.brightness === 0)
}
function stepList(value: unknown): value is Step[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2
    && value.every(step => record(step) && deviceId(step.deviceId) && desired(step.desiredState))
    && new Set(value.map(step => step.deviceId)).size === value.length
}
function indexedSteps(value: unknown): value is Array<Record<string, unknown> & { index: number; deviceId: DeviceId }> {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2
    && value.every(step => record(step) && count(step.index) && step.index < value.length && deviceId(step.deviceId))
    && new Set(value.map(step => step.index)).size === value.length && new Set(value.map(step => step.deviceId)).size === value.length
}
// Reject a real-device/older endpoint or malformed evidence instead of presenting it as a safe simulation.
function isSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.busy !== 'boolean' || value.simulated !== true || value.realDevices !== false || value.automaticRollback !== false || value.automaticRetry !== false || !count(value.version)) return false
  const { scene, devices, preview, run, cleanup } = value
  if (!record(scene) || typeof scene.name !== 'string' || !scene.name.trim() || scene.name.length > 60 || /[\x00-\x1f\x7f]/.test(scene.name) || !stepList(scene.steps)) return false
  if (!Array.isArray(devices) || devices.length !== 2 || !devices.every(item => record(item) && deviceId(item.deviceId) && typeof item.name === 'string' && state(item.state) && typeof item.state.power === 'boolean' && finite(item.state.brightness)) || new Set(devices.map(item => item.deviceId)).size !== 2) return false
  if (!record(cleanup) || !['idle', 'completed', 'unconfirmed'].includes(String(cleanup.state))) return false
  if (preview !== undefined && (!record(preview) || typeof preview.previewId !== 'string' || !preview.previewId || !count(preview.version) || !finite(preview.expiresAt) || preview.atomic !== false || !indexedSteps(preview.steps) || !preview.steps.every(step => state(step.from) && state(step.to)))) return false
  if (run !== undefined && (!record(run) || typeof run.runId !== 'string' || !run.runId || !count(run.version) || !['running', 'completed'].includes(String(run.status)) || run.atomic !== false || !indexedSteps(run.steps) || !run.steps.every(step => typeof step.status === 'string' && optionalString(step.commandId) && optionalString(step.reason)) || run.outcome !== undefined && !['all-observed', 'partial', 'uncertain', 'failed'].includes(String(run.outcome)))) return false
  return optionalString(value.lastError)
}
function sceneDraft(scene: Snapshot['scene']): Draft {
  return { name: scene.name, steps: scene.steps.map(step => ({ deviceId: step.deviceId, power: step.desiredState.power === undefined ? '' : step.desiredState.power ? 'on' : 'off', brightness: step.desiredState.brightness === undefined ? '' : String(step.desiredState.brightness) })) }
}
function parseDraft(draft: Draft): Snapshot['scene'] | undefined {
  const name = draft.name.trim()
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) return
  const steps = draft.steps.map(step => ({ deviceId: step.deviceId, desiredState: {
    ...(step.power === '' ? {} : { power: step.power === 'on' }),
    ...(step.brightness.trim() === '' ? {} : { brightness: Number(step.brightness) }),
  } }))
  return stepList(steps) ? { name, steps } : undefined
}
function signature(scene: Snapshot['scene']) {
  return JSON.stringify({ name: scene.name, steps: scene.steps.map(step => ({ deviceId: step.deviceId, power: step.desiredState.power, brightness: step.desiredState.brightness })) })
}
function unresolved(snapshot: Snapshot) {
  return snapshot.run?.steps.some(step => ['pending', 'accepted', 'sent', 'unknown'].includes(step.status) || !Object.hasOwn(statuses, step.status)) ?? false
}
function matchesSaved(context: Scope) {
  const parsed = parseDraft(context.draft)
  return !!parsed && !!context.snapshot && context.saved === signature(parsed) && context.saved === signature(context.snapshot.scene)
}
function freshPreview(context: Scope) {
  const snapshot = context.snapshot, preview = snapshot?.preview
  return !!preview && context.readyPreview === preview.previewId && preview.version === snapshot?.version && preview.expiresAt > Date.now()
    && matchesSaved(context) && preview.steps.length === snapshot.scene.steps.length
    && preview.steps.every(step => {
      const configured = snapshot.scene.steps[step.index]
      if (configured?.deviceId !== step.deviceId) return false
      const expected = { ...step.from, ...configured.desiredState }
      return step.to.power === expected.power && step.to.brightness === expected.brightness
    })
}
function allowed(context: Scope, action: Action['action']) {
  const snapshot = context.snapshot
  if (!snapshot || context.pending || context.confirming || context.needsRefresh || snapshot.busy || snapshot.run?.status === 'running') return false
  if (action === 'disable') return snapshot.enabled || snapshot.cleanup.state === 'unconfirmed'
  if (snapshot.cleanup.state === 'unconfirmed') return false
  if (action === 'enable') return !snapshot.enabled
  if (unresolved(snapshot)) return false
  if (!snapshot.enabled) return false
  if (action === 'configure') return !!parseDraft(context.draft)
  if (action === 'preview') return matchesSaved(context)
  return Object.hasOwn(faults, context.fault) && freshPreview(context) && (context.fault === 'none' || snapshot.scene.steps.length === 2)
}
function describeState(value: State) {
  return [value.power === undefined ? undefined : value.power ? '开' : '关', value.brightness === undefined ? undefined : `亮度 ${value.brightness}%`].filter(Boolean).join('，')
}

/** Local-admin-only, fixed-device, temporary scene simulation. No real control routes. */
export function SceneSandbox({ transport, canManage }: { transport: PulseWebTransport; canManage: boolean }) {
  const dialogs = usePulseDialogs()
  const scope = useRef<Scope | null>(null)
  const access = useRef({ transport, canManage })
  access.current = { transport, canManage }
  const [view, setView] = useState<View>({ pending: true, confirming: false, needsRefresh: false, draft: defaultDraft(), fault: 'none', error: '' })
  const [, updateExpiry] = useState(0)
  const current = (context: Scope) => context.active && scope.current === context && access.current.canManage && access.current.transport === context.transport
  const publish = (context: Scope) => {
    if (current(context)) setView({ context, pending: context.pending, confirming: context.confirming, needsRefresh: context.needsRefresh, ...(context.snapshot ? { snapshot: context.snapshot } : {}), draft: context.draft, fault: context.fault, error: context.error })
  }

  async function request(context: Scope, action?: Action) {
    if (!current(context) || context.pending || context.confirming || action && !allowed(context, action.action)) return
    context.pending = true
    context.error = ''
    delete context.readyPreview
    const controller = new AbortController()
    context.controller = controller
    publish(context)
    try {
      const next = await apiJson<unknown>(context.transport, endpoint, { ...(action ? jsonRequest('POST', action) : {}), signal: controller.signal })
      if (!current(context)) return
      if (!isSnapshot(next)) throw new Error('INVALID_SCENE_SIMULATION')
      if (action?.action === 'configure' && signature(next.scene) !== signature(action)) throw new Error('UNCONFIRMED_CONFIGURATION')
      context.snapshot = next
      context.needsRefresh = false
      if (!context.initialized || action?.action === 'configure') {
        context.draft = sceneDraft(next.scene)
        context.initialized = true
      }
      if (action?.action === 'configure') context.saved = signature(next.scene)
      if (action?.action === 'disable' || action?.action === 'enable') delete context.saved
      if (action?.action === 'preview' && next.preview) context.readyPreview = next.preview.previewId
      if (next.scene.steps.length === 1) context.fault = 'none'
    } catch {
      if (!current(context)) return
      context.needsRefresh = true
      context.error = action ? '操作结果尚未核实。请手动刷新核对；不会自动重试、重发或回滚。执行前须重新生成预览并确认。'
        : '无法核验场景沙盒状态，请检查本机后台后手动刷新；不会自动启用或重试。'
    } finally {
      if (current(context)) { context.pending = false; publish(context) }
    }
  }

  useEffect(() => {
    const context: Scope = { transport, active: canManage, pending: false, confirming: false, needsRefresh: false, initialized: false, draft: defaultDraft(), fault: 'none', error: '' }
    scope.current = context
    setView({ context, pending: canManage, confirming: false, needsRefresh: false, draft: context.draft, fault: 'none', error: '' })
    if (canManage) void request(context)
    return () => { context.active = false; context.controller?.abort(); if (scope.current === context) scope.current = null }
  }, [transport, canManage])

  useEffect(() => {
    const expiresAt = view.snapshot?.preview?.expiresAt
    if (!expiresAt || expiresAt <= Date.now()) return
    // A local expiry display update only. Never polls or retriggers a command.
    const timer = setTimeout(() => updateExpiry(value => value + 1), Math.min(expiresAt - Date.now() + 1, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [view.snapshot?.preview?.expiresAt])

  function act(action?: Action['action']) {
    const context = scope.current
    if (!context || !current(context)) return
    if (!action) { void request(context); return }
    if (action === 'configure') {
      const parsed = parseDraft(context.draft)
      if (parsed) void request(context, { action, ...parsed })
    } else if (action !== 'execute') void request(context, { action })
  }
  function edit(draft: Draft) {
    const context = scope.current
    if (!context || !current(context) || context.pending || context.confirming) return
    context.draft = draft
    delete context.readyPreview
    delete context.saved
    if (draft.steps.length === 1) context.fault = 'none'
    publish(context)
  }
  async function confirmExecution() {
    const context = scope.current
    if (!context || !current(context) || !allowed(context, 'execute')) return
    const preview = context.snapshot!.preview!, fault = context.fault
    const action: Action = { action: 'execute', previewId: preview.previewId, version: preview.version, fault }
    context.confirming = true
    publish(context)
    try {
      const confirmed = await dialogs.confirm(`仅执行纯模拟场景“${context.snapshot!.scene.name}”：${context.snapshot!.scene.steps.map((step, index) => `${index + 1}. ${deviceNames[step.deviceId]}（${describeState(step.desiredState)}）`).join('；')}。各步骤并行执行，非原子操作，可能部分失败或结果未知；没有自动回滚、重试或真实设备动作。故障模拟：${faults[fault]}。是否执行此预览？`)
      if (!current(context)) return
      context.confirming = false
      if (confirmed && context.snapshot?.preview?.previewId === action.previewId && allowed(context, 'execute')) await request(context, action)
      else if (confirmed) context.error = '预览已过期或状态已变化，未执行。请重新生成预览并确认。'
    } catch {
      if (current(context)) context.error = '确认未完成，没有发送执行请求。'
    } finally {
      if (current(context)) { context.confirming = false; publish(context) }
    }
  }

  if (!canManage) return <Card className="settings-card" title="场景模拟沙盒"><p>场景沙盒仅限本机管理会话。配对手机和远程页面不能读取、启用或执行模拟场景。</p></Card>
  const context = view.context?.transport === transport && view.context === scope.current ? view.context : undefined
  const snapshot = context ? view.snapshot : undefined
  const locked = !context || view.pending || view.confirming
  const disabled = (action: Action['action']) => !context || !allowed(context, action)
  const draft = context ? view.draft : defaultDraft()
  const editable = !locked && !!snapshot?.enabled && !view.needsRefresh && !snapshot.busy && !unresolved(snapshot)
  const previewReady = !!context && freshPreview(context)
  const updateStep = (index: number, patch: Partial<Draft['steps'][number]>) => edit({ ...draft, steps: draft.steps.map((step, at) => at === index ? { ...step, ...patch } : step) })
  return <Card className="settings-card" title="场景模拟沙盒">
    <p>纯模拟，默认关闭。只使用当前后台进程隔离临时沙盒中的两盏固定虚拟灯，不连接真实设备、Home Assistant、模型、授权或自动化。</p>
    <p>步骤并行执行，非原子操作；部分成功不会自动回滚，失败或未知不会自动重试。所有状态仅是模拟证据，不证明物理动作成功。</p>
    <p><Tag>{!snapshot ? locked ? '正在读取场景沙盒' : '场景沙盒状态未核验' : view.needsRefresh ? '上次快照，当前状态未核验' : snapshot.enabled ? '场景沙盒已启用' : '场景沙盒已关闭'}</Tag>{(snapshot?.busy || snapshot?.run?.status === 'running') && <Tag>模拟批次处理中，请手动刷新</Tag>}</p>
    {context && view.error && <p role="alert">{view.error}</p>}
    {context && view.needsRefresh && snapshot && <p>以下保留上次读取的证据，不代表当前状态。核验前不接受新的模拟操作。</p>}
    <div className="json-actions">
      <Button disabled={disabled('enable')} onClick={() => act('enable')}>启用场景沙盒</Button>
      <Button disabled={locked} onClick={() => act()}>刷新场景沙盒状态</Button>
      <Button danger disabled={disabled('disable')} onClick={() => act('disable')}>关闭并清理场景沙盒</Button>
    </div>
    <p>关闭只清理本进程模拟状态，不会撤销已发生的真实动作，也不表示真实设备已经停止。</p>
    <fieldset disabled={!editable}>
      <legend>模拟场景草稿</legend>
      <p><label>场景名称 <input aria-label="模拟场景名称" maxLength={60} value={draft.name} onChange={event => edit({ ...draft, name: event.target.value })} /></label></p>
      {draft.steps.map((step, index) => <div key={index} className="settings-device">
        <p><label>步骤 {index + 1} 虚拟灯 <select aria-label={`模拟步骤 ${index + 1} 设备`} value={step.deviceId} onChange={event => updateStep(index, { deviceId: event.target.value as DeviceId })}>
          {Object.entries(deviceNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label></p>
        <p><label>开关 <select aria-label={`模拟步骤 ${index + 1} 开关`} value={step.power} onChange={event => updateStep(index, { power: event.target.value as Draft['steps'][number]['power'] })}>
          <option value="">不指定</option><option value="on">开</option><option value="off">关</option>
        </select></label>{' '}<label>亮度（%） <input aria-label={`模拟步骤 ${index + 1} 亮度`} type="number" min={0} max={100} step="any" value={step.brightness} onChange={event => updateStep(index, { brightness: event.target.value })} /></label></p>
        <Button disabled={!editable || draft.steps.length === 1} onClick={() => edit({ ...draft, steps: draft.steps.filter((_, at) => at !== index) })}>移除模拟步骤 {index + 1}</Button>
      </div>)}
      <p><Button disabled={!editable || draft.steps.length === 2} onClick={() => { const id = (Object.keys(deviceNames) as DeviceId[]).find(id => !draft.steps.some(step => step.deviceId === id)); if (id) edit({ ...draft, steps: [...draft.steps, { deviceId: id, power: 'on', brightness: id === 'scene:lamp-a' ? '30' : '60' }] }) }}>添加第二盏虚拟灯</Button></p>
    </fieldset>
    <p>每步只用一盏不同的虚拟灯。亮度可留空或为 0–100；开灯不能指定 0，关灯不能指定正亮度。每步至少指定开关或亮度。</p>
    {!parseDraft(draft) && <p role="status">草稿无效：请填写 1–60 字名称、不同虚拟灯和一致的开关 / 亮度。</p>}
    <div className="json-actions"><Button disabled={disabled('configure')} onClick={() => act('configure')}>保存模拟场景</Button><Button disabled={disabled('preview')} onClick={() => act('preview')}>生成场景预览</Button></div>
    <p>{context && matchesSaved(context) ? '草稿已明确保存；执行仍须新的有效预览和确认。' : '草稿尚未明确保存。编辑不会自动保存或执行；请先保存，再生成新的预览。'}</p>
    <p><label>第二步故障模拟 <select aria-label="第二步故障模拟" value={context ? view.fault : 'none'} disabled={!editable || draft.steps.length !== 2} onChange={event => {
      if (!context || !current(context) || locked) return
      context.fault = event.target.value as Fault
      publish(context)
    }}>{Object.entries(faults).map(([value, label]) => <option key={value} value={value} disabled={value !== 'none' && draft.steps.length !== 2}>{label}</option>)}</select></label></p>
    {snapshot?.preview && <section aria-label="场景预览">
      <p>{previewReady ? '预览有效，仅代表模拟计划，尚未执行。' : '预览不可用于执行：已过期、已使用或草稿已变化。请重新保存或生成预览。'}</p>
      <p>配置版本 {snapshot.preview.version} · 预览到期 {new Date(snapshot.preview.expiresAt).toLocaleString()}</p>
      <ol>{[...snapshot.preview.steps].sort((a, b) => a.index - b.index).map(step => <li key={step.index}>{deviceNames[step.deviceId]}：{describeState(step.from)} → {describeState(step.to)}</li>)}</ol>
    </section>}
    <Button disabled={disabled('execute')} onClick={() => void confirmExecution()}>确认并执行模拟场景</Button>
    {context && view.confirming && <p role="status">等待本次模拟执行确认，取消不会发送请求。</p>}
    <p>不会自动轮询、重新触发或恢复执行。网络结果不明时请手动刷新；刷新只读取证据，不会执行场景。</p>
    {snapshot && <>
      <p aria-label="场景沙盒清理状态">{cleanupLabels[snapshot.cleanup.state]}，仅针对隔离模拟环境。</p>
      <section aria-label="虚拟灯当前状态"><h4>虚拟灯模拟状态</h4><ul>{snapshot.devices.map(device => <li key={device.deviceId}>{deviceNames[device.deviceId]}：{describeState(device.state)}</li>)}</ul></section>
      {snapshot.run ? <section aria-label="模拟批次结果">
        <p aria-label="模拟批次状态">{snapshot.run.status === 'running' ? '模拟批次进行中，不代表步骤完成。' : '模拟批次已结束，不代表每一步成功。'} 批次 {snapshot.run.runId} · 配置版本 {snapshot.run.version}</p>
        <ol>{[...snapshot.run.steps].sort((a, b) => a.index - b.index).map(step => <li key={step.index} aria-label={`模拟结果步骤 ${step.index + 1}`}>
          {deviceNames[step.deviceId]} · {statuses[step.status] ?? '未知模拟状态，不能确认完成'}（{step.status}）{step.commandId && <span> · 模拟命令 {step.commandId}</span>}{step.reason && <span> · 原因 {step.reason}</span>}
        </li>)}</ol>
        {unresolved(snapshot) && <p>存在未决模拟结果，不能推定整组成功或重新运行。请先手动读取核对；如需重置，只能明确关闭清理沙盒后重新启用。此操作仅丢弃隔离模拟状态。</p>}
        <p>保留逐步结果，部分失败或未知不会改写其他步骤的证据；没有自动回滚。</p>
      </section> : <p>尚无模拟批次记录。</p>}
      {snapshot.lastError && <p role="status">最近一次模拟操作报告错误，请核对逐步结果和清理状态；不会自动重跑。</p>}
    </>}
  </Card>
}
