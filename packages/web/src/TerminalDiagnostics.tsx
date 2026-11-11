import { useEffect, useRef, useState } from 'react'
import { Button, Card, Tag } from 'antd'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

type Scenario = 'playback-complete' | 'playback-timeout' | 'callback-quarantine'
type Action = 'enable' | 'run' | 'finish-cleanup' | 'disable'
interface Snapshot {
  enabled: boolean
  simulated: true
  productionListener: false
  persistentPairing: false
  scenario?: string
  busy: boolean
  cleanup: { state: 'idle' | 'running' | 'unconfirmed' | 'completed'; pendingCallbacks: number }
  session: { state: 'absent' | 'open' | 'closed'; sessionId?: string; generation?: number; reportedMuted?: boolean }
  callbacks: { asrPending: number; asrQuarantined: number; replyPending: number; replyQuarantined: number }
  reply?: { requestId: string; phase: string; ackCount?: number; chunkCount?: number; errorCode?: string; admissionConfirmed: boolean }
  timeline: Array<{ at: number; event: string }>
  lastError?: string
}
interface Scope {
  transport: PulseWebTransport
  active: boolean
  pending: boolean
  needsRefresh: boolean
  snapshot?: Snapshot
  controller?: AbortController
}
interface View { transport: PulseWebTransport; snapshot?: Snapshot; pending: boolean; needsRefresh: boolean; error: string }
const endpoint = '/api/device-use/terminal-diagnostics'
const scenarios: Record<Scenario, string> = {
  'playback-complete': '模拟播放完成回执',
  'playback-timeout': '模拟播放超时',
  'callback-quarantine': '模拟回调隔离与清理',
}
const phases: Record<string, string> = {
  'awaiting-reply': '等待模拟回复',
  'awaiting-tts': '等待模拟语音合成',
  synthesizing: '模拟语音合成中',
  sent: '已发送模拟回复，尚未收到终端确认',
  received: '模拟终端已接收，不代表开始播放',
  started: '模拟终端报告开始，不代表播放完成',
  completed: '模拟终端报告完成，仅协议回执',
  error: '模拟终端报告播放错误，未确认完成',
  failed: '模拟处理失败，未确认播放',
  unknown: '播放结果未知，不能声称已完成',
  superseded: '已被后续模拟轮次取代，未确认播放',
}
const cleanupLabels: Record<Snapshot['cleanup']['state'], string> = {
  idle: '尚未开始清理',
  running: '清理进行中，尚未确认',
  unconfirmed: '清理未确认，仍有回调未退出',
  completed: '清理已确认（仅进程内回调）',
}
const eventLabels: Record<string, string> = {
  enabled: '已启用纯模拟诊断',
  disabled: '已关闭纯模拟诊断',
  'scenario-failed': '模拟流程失败',
  'playback-sent': '已发送模拟播放数据',
  'final-reply-available': '模拟最终回复已就绪',
  'playback-stop-requested': '已请求停止模拟播放，不是物理停止证明',
  'asr-started': '模拟转写回调已开始',
  'synthetic-admission-confirmed': '模拟请求受理已确认',
  'session-opened': '模拟会话已打开',
  'session-closed': '模拟会话已关闭',
  'callback-quarantined': '迟到模拟回调已隔离，尚未退出',
  'cleanup-unconfirmed': '清理尚未确认',
  'playback-timeout': '等待播放回执超时，结果未知',
  'playback-received': '模拟终端已接收数据，不代表开始播放',
  'playback-started': '模拟终端报告开始播放',
  'playback-completed': '模拟终端报告播放完成，无声学证据',
  'cleanup-started': '开始清理进程内回调',
  'cleanup-completed': '进程内回调清理已确认',
}
const sessionLabels: Record<Snapshot['session']['state'], string> = { absent: '尚无模拟会话', open: '模拟会话已打开', closed: '模拟会话已关闭' }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
// Fail closed if a different/older backend responds. This panel must never
// present a production listener or persistent pairing as a safe simulation.
function isSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || typeof value.enabled !== 'boolean' || value.simulated !== true || value.productionListener !== false || value.persistentPairing !== false || typeof value.busy !== 'boolean') return false
  const { cleanup, session, callbacks, reply, timeline } = value
  if (!record(cleanup) || !['idle', 'running', 'unconfirmed', 'completed'].includes(String(cleanup.state)) || !count(cleanup.pendingCallbacks) || cleanup.state === 'completed' && cleanup.pendingCallbacks !== 0) return false
  if (!record(session) || !['absent', 'open', 'closed'].includes(String(session.state)) || !optionalString(session.sessionId) || session.generation !== undefined && !count(session.generation) || session.reportedMuted !== undefined && typeof session.reportedMuted !== 'boolean') return false
  if (!record(callbacks) || !['asrPending', 'asrQuarantined', 'replyPending', 'replyQuarantined'].every(key => count(callbacks[key]))) return false
  if (reply !== undefined && (!record(reply) || typeof reply.requestId !== 'string' || typeof reply.phase !== 'string' || typeof reply.admissionConfirmed !== 'boolean' || reply.ackCount !== undefined && !count(reply.ackCount) || reply.chunkCount !== undefined && !count(reply.chunkCount) || !optionalString(reply.errorCode))) return false
  return optionalString(value.scenario) && optionalString(value.lastError) && Array.isArray(timeline) && timeline.every(item => record(item) && typeof item.at === 'number' && Number.isFinite(item.at) && typeof item.event === 'string')
}
function hasPendingCallbacks(snapshot: Snapshot) {
  return snapshot.cleanup.pendingCallbacks > 0 || snapshot.callbacks.asrPending > 0 || snapshot.callbacks.replyPending > 0
}
function canAct(snapshot: Snapshot, action: Action) {
  if (snapshot.busy) return false
  if (action === 'disable') return snapshot.enabled
  if (action === 'finish-cleanup') return snapshot.enabled && snapshot.cleanup.state === 'unconfirmed'
  const ready = !hasPendingCallbacks(snapshot) && !['running', 'unconfirmed'].includes(snapshot.cleanup.state)
  return ready && (action === 'enable' ? !snapshot.enabled : snapshot.enabled)
}

/** Local-admin-only, memory-only protocol diagnostics, never a hardware test. */
export function TerminalDiagnostics({ transport, canManage }: { transport: PulseWebTransport; canManage: boolean }) {
  const scope = useRef<Scope | null>(null)
  const [view, setView] = useState<View>({ transport, pending: true, needsRefresh: false, error: '' })
  const [scenario, setScenario] = useState<Scenario>('playback-complete')

  async function request(context: Scope, action?: Action, selectedScenario?: Scenario) {
    if (!context.active || context.pending || scope.current !== context) return
    if (action && (!context.snapshot || context.needsRefresh || !canAct(context.snapshot, action))) return
    context.pending = true
    const controller = new AbortController()
    context.controller = controller
    setView(previous => ({ ...previous, pending: true, error: '' }))
    const current = () => context.active && scope.current === context
    try {
      const init = action ? jsonRequest('POST', { action, ...(action === 'run' ? { scenario: selectedScenario } : {}) }) : {}
      const next = await apiJson<unknown>(context.transport, endpoint, { ...init, signal: controller.signal })
      if (!current()) return
      if (!isSnapshot(next)) throw new Error('INVALID_SIMULATED_DIAGNOSTICS')
      context.snapshot = next
      context.needsRefresh = false
      setView({ transport: context.transport, snapshot: next, pending: false, needsRefresh: false, error: '' })
    } catch {
      if (!current()) return
      context.needsRefresh = true
      setView(previous => ({ ...previous, pending: false, needsRefresh: true, error: action
        ? '操作结果尚未核实。请手动刷新核对；不会自动重试或重跑模拟。'
        : '无法核验模拟诊断状态，请检查本机后台后手动刷新；不会自动启用或重试。' }))
    } finally {
      if (current()) context.pending = false
    }
  }

  useEffect(() => {
    const context: Scope = { transport, active: canManage, pending: false, needsRefresh: false }
    scope.current = context
    setView({ transport, pending: canManage, needsRefresh: false, error: '' })
    setScenario('playback-complete')
    if (canManage) void request(context)
    return () => {
      context.active = false
      context.controller?.abort()
      if (scope.current === context) scope.current = null
    }
  }, [transport, canManage])

  const execute = (action?: Action) => {
    const context = scope.current
    if (canManage && context?.transport === transport) void request(context, action, scenario)
  }
  if (!canManage) return <Card className="settings-card" title="语音终端模拟诊断"><p>模拟诊断仅限本机管理会话。配对手机和远程页面不能读取、启用或运行诊断。</p></Card>
  const currentView = view.transport === transport ? view : undefined
  const snapshot = currentView?.snapshot
  const pending = !currentView || currentView.pending
  const disabled = (action: Action) => pending || !!currentView?.needsRefresh || !snapshot || !canAct(snapshot, action)
  const reply = snapshot?.reply
  return <Card className="settings-card" title="语音终端模拟诊断">
    <p>纯模拟，默认关闭。只在当前后台进程内存中验证协议，不调用真实模型、不访问麦克风或扬声器、不使用密钥、不持久化配对，也不执行设备动作。</p>
    <p>本诊断不会启用生产监听器。这里的回执和静音状态均为模拟数据，没有声学证据，不能证明真实硬件发声、停止播放或物理静音。</p>
    <p><Tag>{!snapshot ? pending ? '正在读取模拟诊断' : '模拟诊断状态未核验' : currentView?.needsRefresh ? '上次快照，当前状态未核验' : snapshot.enabled ? '模拟诊断已启用' : '模拟诊断已关闭'}</Tag>{snapshot?.busy && <Tag>后台模拟流程处理中，请手动刷新</Tag>}</p>
    {currentView?.error && <p role="alert">{currentView.error}</p>}
    {currentView?.needsRefresh && snapshot && <p>以下保留上次读取的证据，不代表当前状态。核验前不接受新的模拟操作。</p>}
    <div className="json-actions">
      <Button disabled={disabled('enable')} onClick={() => execute('enable')}>启用纯模拟诊断</Button>
      <Button disabled={pending} onClick={() => execute()}>刷新模拟状态</Button>
      <Button danger disabled={disabled('disable')} onClick={() => execute('disable')}>关闭纯模拟诊断</Button>
    </div>
    <p><label>诊断场景 <select aria-label="终端模拟诊断场景" value={scenario} disabled={pending || !!snapshot?.busy} onChange={event => setScenario(event.target.value as Scenario)}>
      {Object.entries(scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label></p>
    <Button disabled={disabled('run')} onClick={() => execute('run')}>运行所选模拟场景</Button>
    <p>每次运行需要手动触发，不会自动轮询或失败重试。关闭诊断不等于回调已经退出，清理结果以下方独立状态为准。</p>
    {snapshot && <>
      {snapshot.scenario && <p>上次场景：{scenarios[snapshot.scenario as Scenario] ?? '未知模拟场景'}</p>}
      <p aria-label="模拟会话状态">{sessionLabels[snapshot.session.state]}{snapshot.session.sessionId ? ` · ${snapshot.session.sessionId}` : ''}{snapshot.session.generation !== undefined ? ` · 世代 ${snapshot.session.generation}` : ''}</p>
      <p>模拟静音报告：{snapshot.session.reportedMuted === undefined ? '尚无报告' : snapshot.session.reportedMuted ? '已报告静音，不证明物理静音' : '已报告未静音，不代表实际发声'}</p>
      <p aria-label="模拟清理状态">{cleanupLabels[snapshot.cleanup.state]} · 待退出回调：{snapshot.cleanup.pendingCallbacks}</p>
      <p>转写回调：待退出 {snapshot.callbacks.asrPending}，已隔离 {snapshot.callbacks.asrQuarantined}；回复回调：待退出 {snapshot.callbacks.replyPending}，已隔离 {snapshot.callbacks.replyQuarantined}。</p>
      <p>隔离仅阻止迟到结果继续影响会话，不代表回调已退出；待退出数量归零并确认清理后才算结束。</p>
      {snapshot.cleanup.state === 'unconfirmed' && <Button disabled={disabled('finish-cleanup')} onClick={() => execute('finish-cleanup')}>释放模拟回调并核验清理</Button>}
      {reply ? <>
        <p aria-label="模拟回复状态">{phases[reply.phase] ?? '未知协议阶段，不能确认播放完成'}（{reply.phase}）</p>
        <p>模拟请求：{reply.requestId}。请求受理：{reply.admissionConfirmed ? '已确认，仅代表受理' : '未确认'}。分块回执：{reply.ackCount ?? '未知'} / {reply.chunkCount ?? '未知'}，不代表播放完成。</p>
        {reply.errorCode && <p>模拟错误码：{reply.errorCode}{reply.errorCode === 'VOICE_TERMINAL_PLAYBACK_TIMEOUT' ? '。等待播放回执超时，结果仍未知，不会自动重播。' : ''}</p>}
      </> : <p>尚无模拟回复证据。</p>}
      {snapshot.lastError && <p role="status">最近一次模拟流程报告错误，请核对回执、时间线和清理状态；不会自动重跑。</p>}
      <details><summary>模拟事件时间线（{snapshot.timeline.length}）</summary>
        {snapshot.timeline.length ? <ol>{snapshot.timeline.map((entry, index) => <li key={`${entry.at}-${index}`}>{new Date(entry.at).toLocaleString()} · {eventLabels[entry.event] ?? entry.event}</li>)}</ol> : <p>暂无模拟事件。</p>}
      </details>
    </>}
    <details><summary>回执含义与证据边界</summary><ul>
      <li>received：终端已接收数据，不代表开始播放。</li>
      <li>started：终端报告开始，不代表播放完成。</li>
      <li>completed：终端报告完成。本诊断仅有模拟协议回执，没有声学证明。</li>
      <li>error：终端报告播放错误，不能当作完成。</li>
      <li>unknown：超时或缺失确认，结果未知，不能自动重播或推定成功。</li>
    </ul></details>
  </Card>
}
