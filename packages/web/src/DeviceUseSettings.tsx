import { SceneSandbox } from './SceneSandbox.js'
import { TerminalDiagnostics } from './TerminalDiagnostics.js'
import { useEffect, useRef, useState } from 'react'
import { Button, Card, Checkbox, Input, InputNumber, Select, Tag } from 'antd'
import { ApiError, apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { usePulseDialogs } from './PulseControls.js'

interface Device { deviceId: string; adapter: string; name: string; roomId: string; aliases: string[]; enrolled: boolean; stale: boolean; availability: string; observedAt: number; state: Record<string, unknown>; capabilities: Array<{ kind: string; writable: boolean }> }
interface Grant { authorizationRef: string; deviceId: string; actions: string[]; expiresAt: number; limits?: { brightness?: { max: number } } }
interface Audit { origin: { entryPoint: string }; dispatch?: { grant: { actions: string[]; expiresAt: number; limits?: { brightness?: { max: number } } }; confirmation: { required: boolean; verifiedByHost: boolean } } }
interface Status { reconciliation?: { commandId: string; outcome: string; checkedAt: number }; homeAssistantTemperature?: { baseUrl: string; homeId: string; climateTemperatureUnit: 'celsius' | 'fahrenheit' } | null; unresolvedCount?: number; blockingCount?: number; manuallyReleasedCount?: number; terminalHistoryTruncated?: boolean; permissionEventCount?: number; permissionEvents?: Array<{ eventId: string; at: number; action: 'grant' | 'revoke'; grant: { deviceId: string; actions: string[] } }>; enabled: boolean; mode: 'simulator' | 'home-assistant'; ready: boolean; status: string; devices: Device[]; grants: Grant[]; commands: Array<{ commandId: string; status: string; updatedAt: number; manualDisposition?: { at: number; eventId: string }; reason?: string; request: { deviceId: string }; audit?: Audit }> }
const commandLabels: Record<string, string> = { accepted: '已受理，尚未下发', sent: '已尝试发送，未确认', observed: '新鲜状态已核对', unknown: '结果不明，请先对账', failed: '失败', cancelled: '下发前取消', expired: '下发前过期' }
const reconciliationLabels: Record<string, string> = {
  'manually-released': '此条已人工处理隔离，执行结果仍未知。本次不重新判断执行，也不重发或恢复授权。',
  'state-match-unverified': 'HA 当前显示与目标一致，但不能证明设备实际执行。原命令仍未决，冲突隔离保留，没有重发命令。',
  observed: '新鲜状态与目标一致。仅核对当前状态，不证明是原动作造成；没有重发命令。',
  'not-pending': '该命令已有结束记录，本次没有再次读取设备或重发。',
  'not-sent': '原命令尚无下发记录。查询不会触发发送，也不能据此声称动作已完成。',
  disabled: 'Device Use 已关闭，仅保留历史记录；没有读取设备或重发。',
  'mode-not-active': '此命令所属的适配器当前未启用。保留原结果，不会自动切换或连接。',
  'credentials-required': '缺少本机凭据交接，未读取网关。请在本机配置；不会自动登录或重发。',
  'connection-unverified': '无法核验当前网关就是原命令的连接，保留未知结果。请自行核实设备，不自动确认或重发。',
  offline: '设备离线或不可用，原结果仍未知。没有重发；设备恢复后可再次只读查询。',
  stale: '没有取得晚于下发时间的新鲜状态，原结果仍未知。没有使用缓存认定成功，也没有重发。',
  'read-timeout': '只读查询超时，原结果仍未知。没有重发命令。',
  'read-failed': '无法读取设备状态，原结果仍未知。请检查连接和凭据；没有重发命令。',
  'state-mismatch': '当前状态与原目标不一致，仍不能确定原动作结果。请核实设备，不会自动重发。',
  unconfirmable: '原记录缺少下发或可核对能力的证据，不能自动确认。保留记录，不会重发。',
}
export function DeviceUseSettings({ transport, canManage }: { transport: PulseWebTransport; canManage: boolean }) {
  const dialogs = usePulseDialogs()
  const [status, setStatus] = useState<Status>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [baseUrl, setBaseUrl] = useState(''), [homeId, setHomeId] = useState('home'), [token, setToken] = useState(''), [entities, setEntities] = useState(''), [insecure, setInsecure] = useState(false), [write, setWrite] = useState(false)
  const [grantDevice, setGrantDevice] = useState(''), [power, setPower] = useState(true), [brightness, setBrightness] = useState(false), [maximum, setMaximum] = useState(100), [minutes, setMinutes] = useState(60)
  const [reconciliations, setReconciliations] = useState<Record<string, { outcome: string; checkedAt: number }>>({})
  const [temperatureUnit, setTemperatureUnit] = useState<'' | 'celsius' | 'fahrenheit'>('')
  const inFlight = useRef(false), haDraftEdited = useRef(false), temperatureInitialized = useRef(false)
  const load = async () => { try { const next = await apiJson<Status>(transport, '/api/device-use/status'); setStatus(next)
    if (!temperatureInitialized.current) {
      temperatureInitialized.current = true
      if (!haDraftEdited.current && next.homeAssistantTemperature) { setBaseUrl(next.homeAssistantTemperature.baseUrl); setHomeId(next.homeAssistantTemperature.homeId); setTemperatureUnit(next.homeAssistantTemperature.climateTemperatureUnit) }
    }
    setError('') } catch { setError('Device Use 状态无法加载，请检查本机后台连接。') } }
  useEffect(() => { if (canManage) void load() }, [transport, canManage])
  const mutate = async (action: string, body: unknown) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { const next = await apiJson<Status>(transport, `/api/device-use/${action}`, jsonRequest('POST', body)); setStatus(next)
      if (next.reconciliation) { const result = next.reconciliation; setReconciliations(previous => ({ ...previous, [result.commandId]: result })) } else setReconciliations({})
    }
    catch (error) { setError(error instanceof ApiError && error.detail === 'DEVICE_PERMISSION_AUDIT_CAPACITY' ? '授权审计容量已满，已拒绝新增授权以保留历史证据。现有授权仍可立即撤销；不要删除命令或未决记录来绕过限制。' : action === 'reconcile' ? '只读查询未完成。原命令记录保留，没有重发；请检查后台连接后再查询。' : action === 'home-assistant' ? '网关连接失败。请检查地址、实体白名单和令牌；令牌已从表单清除，没有保存。' : '操作未完成，请刷新核对当前状态；不会自动重试设备动作。') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const manualRelease = async (commandId: string) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const preview = await apiJson<{ challengeId: string; commandId: string; device: { deviceId: string; adapter: string; homeId: string }; desiredState: Record<string, unknown>; sentAt: number | null; warning: string }>(transport, '/api/device-use/manual-resolution/preview', jsonRequest('POST', { commandId }))
      const typed = await dialogs.prompt(`请现场核实具体设备后，输入完整设备 ID：${preview.device.deviceId}。家庭：${preview.device.homeId}。命令：${preview.commandId}。原目标：${JSON.stringify(preview.desiredState)}。`, '')
      if (typed !== preview.device.deviceId) return
      if (!await dialogs.confirm(`仅人工处理以下单条命令：${preview.commandId}\n设备：${preview.device.deviceId}；家庭：${preview.device.homeId}；适配器：${preview.device.adapter}\n原目标：${JSON.stringify(preview.desiredState)}；下发时间：${preview.sentAt === null ? '无记录' : new Date(preview.sentAt).toLocaleString()}\n${preview.warning}\n我已现场核实此设备当前安全，理解迟到风险，确认仅解除此条隔离。`)) return
      setStatus(await apiJson<Status>(transport, '/api/device-use/manual-resolution/confirm', jsonRequest('POST', { commandId: preview.commandId, challengeId: preview.challengeId, deviceId: typed })))
      setReconciliations({})
    } catch (error) {
      setError(error instanceof ApiError && error.detail === 'DEVICE_MANUAL_DISPATCH_NOT_QUIESCENT' ? '本地发送或执行链尚未结束，不能人工解除隔离。记录保留，没有重发。' : '人工处理未完成。请先关闭并撤权，核对命令及设备身份，再重新逐条确认；没有重发或恢复授权。')
    } finally { inFlight.current = false; setBusy(false) }
  }
  if (!canManage) return <Card className="settings-card"><p>Device Use 只能在本机管理会话中设置。配对手机和远程页面不能连接网关、纳管设备或授权。</p></Card>
  const selected = status?.devices.find(d => d.deviceId === grantDevice)
  const light = (d: Device) => d.deviceId === 'sim:light' || d.adapter === 'home-assistant' && d.capabilities.every(c => c.kind === 'power' || c.kind === 'brightness')
  const connect = async () => {
    if (busy || !token.trim() || !entities.trim()) return
    if (!await dialogs.confirm(`连接 ${baseUrl}，仅访问下方实体白名单。令牌只在此后台进程内存使用，不写入设置或发送给模型；重启后需重新交接。${insecure ? '本次明确允许局域网 HTTP，令牌和设备数据可能被同网络中的攻击者截获。' : '使用 HTTPS 连接。'}${write ? '允许白名单中的灯提供写入能力，仍需逐台纳管和单独授权。' : '白名单默认只读。'}空调始终只读。${temperatureUnit ? `缺少显式温标时按你确认的${temperatureUnit === 'celsius' ? '摄氏 °C' : '华氏 °F'}解释，按此网关与家庭标识保存此选择。` : '未确认空调温标，缺少显式单位的温度将隐藏。'}`)) return
    const secret = token; setToken('')
    await mutate('home-assistant', { baseUrl, homeId, token: secret, allowInsecureLocalHttp: insecure, ...(temperatureUnit ? { climateTemperatureUnit: temperatureUnit } : {}), entities: entities.split(/[\s,]+/).filter(Boolean).map(entityId => ({ entityId, writable: write && entityId.startsWith('light.') })) })
  }
  return <>
    <Card className="settings-card" title="Device Use">
      <p>设备接入默认关闭。先在模拟器验证，再连接自己的 Home Assistant。发现设备不代表纳管，纳管不代表允许控制。</p>
      <p><Tag>{!status ? '正在加载' : !status.enabled ? '已关闭' : !status.ready ? '等待本机凭据交接' : status.mode === 'simulator' ? '仅模拟器，无真实硬件' : '网关已配置，真实硬件尚未验收'}</Tag></p>
      <p>不支持开锁、关闭安防、危险加热等高风险动作。当前授权入口仅支持灯光开关和亮度。电脑休眠、深睡唤醒及真实语音硬件均未验收。</p>
      <div className="json-actions"><Button disabled={busy} onClick={() => void mutate('config', { enabled: true, mode: 'simulator' })}>启用模拟器</Button><Button disabled={busy || !status?.enabled} danger onClick={async () => { if (await dialogs.confirm('关闭 Device Use 并撤销当前控制授权？已发送的动作可能已经执行，关闭不等于物理停止。')) await mutate('config', { enabled: false, mode: status?.mode ?? 'simulator' }) }}>关闭并撤权</Button><Button disabled={busy} onClick={() => void load()}>刷新状态</Button><Button disabled={busy || !status?.ready} onClick={() => void mutate('discover', {})}>发现白名单设备</Button></div>
      {error && <p role="alert">{error}</p>}
    </Card>
    <Card className="settings-card" title="Home Assistant 凭据交接">
      <p>请在自己的 Home Assistant 中手动准备令牌。不要把令牌贴进聊天或高级 JSON。此页只接受灯、传感器和只读空调的精确实体 ID，不扫描或授权整个家庭。</p>
      <label>网关地址<Input aria-label="HA 网关地址" placeholder="https://home.example.local" value={baseUrl} onChange={e => { haDraftEdited.current = true; setBaseUrl(e.target.value); setTemperatureUnit('') }} disabled={busy} /></label>
      <label>家庭标识<Input aria-label="家庭标识" value={homeId} onChange={e => { haDraftEdited.current = true; setHomeId(e.target.value); setTemperatureUnit('') }} disabled={busy} /></label>
      <label>本次令牌<Input.Password aria-label="HA 本次令牌" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} disabled={busy} /></label>
      <label>精确实体白名单<Input.TextArea aria-label="HA 实体白名单" placeholder={'light.living_room\nsensor.living_room_temperature'} value={entities} onChange={e => setEntities(e.target.value)} disabled={busy} /></label>
      <label>空调只读温标<select aria-label="空调只读温标" value={temperatureUnit} onChange={e => { haDraftEdited.current = true; setTemperatureUnit(e.target.value as '' | 'celsius' | 'fahrenheit') }} disabled={busy}>
        <option value="">未知，不解释缺少单位的温度</option><option value="celsius">已确认：摄氏 °C</option><option value="fahrenheit">已确认：华氏 °F</option>
      </select></label>
      <p>仅在你已确认该网关的空调温标时选择；不会读取家庭配置。未知或设备单位矛盾时隐藏温度，不开放温控写入。只保存此网关和家庭标识的温标选择，更换地址或家庭标识后需重新确认。</p>
      <p><Checkbox checked={insecure} disabled={busy} onChange={e => setInsecure(e.target.checked)}>明确允许不加密的局域网 HTTP</Checkbox></p>
      <p><Checkbox checked={write} disabled={busy} onChange={e => setWrite(e.target.checked)}>为白名单灯开放可写能力（不会自动授权）</Checkbox></p>
      <Button disabled={busy || !token.trim() || !baseUrl || !entities.trim()} onClick={() => void connect()}>交接令牌并连接白名单</Button>
    </Card>
    <Card className="settings-card" title="发现与纳管">
      {!status?.devices.length && <p>尚未发现设备。模拟器不是真实家庭，真实设备也不会自动连接。</p>}
      {status?.devices.map(device => <div key={device.deviceId} className="settings-card">
        <strong>{device.name}</strong> <Tag>{device.enrolled ? '已纳管' : '未纳管'}</Tag><p>{device.deviceId} · {device.roomId} · {device.availability}{device.stale ? ' · 过时或离线，不是实时读数' : ''}</p>
        <p>观测时间：{new Date(device.observedAt).toLocaleString()}；状态：{JSON.stringify(device.state)}</p>
        <p>能力：{device.capabilities.map(c => `${c.kind}（${c.writable ? '可写但仍需授权' : '只读'}）`).join('、')}</p>
        <Button disabled={busy} onClick={async () => { const roomId = await dialogs.prompt('设备房间标识', device.roomId); if (roomId === null) return; const alias = await dialogs.prompt('设备别名（多个用逗号分隔）', device.aliases.join(',')); if (alias === null) return; if (await dialogs.confirm(`纳管 ${device.name}（${device.deviceId}），房间 ${roomId}？这不会授权控制。`)) await mutate('enroll', { deviceId: device.deviceId, roomId, aliases: alias.split(/[,，]/).map(s => s.trim()).filter(Boolean) }) }}>纳管 / 编辑房间别名</Button>
      </div>)}
    </Card>
    <Card className="settings-card" title="最小控制授权">
      <p>仅限已纳管灯具，可随时撤权。语音或聊天只使用已有授权，不能自行连接账号、授权设备或绕过审批。</p>
      <label>具体设备<Select aria-label="授权设备" style={{ width: '100%' }} value={grantDevice || undefined} onChange={value => { setGrantDevice(value ?? ''); setBrightness(false) }} options={(status?.devices ?? []).filter(d => d.enrolled && light(d)).map(d => ({ value: d.deviceId, label: `${d.name} (${d.deviceId})` }))} disabled={busy || !status?.ready} /></label>
      <p><Checkbox checked={power} onChange={e => setPower(e.target.checked)} disabled={busy}>开关</Checkbox> <Checkbox checked={brightness} onChange={e => setBrightness(e.target.checked)} disabled={busy || !selected?.capabilities.some(c => c.kind === 'brightness' && c.writable)}>亮度</Checkbox></p>
      <label>亮度上限（%）<InputNumber aria-label="亮度上限" min={0} max={100} value={maximum} onChange={v => setMaximum(v ?? 100)} disabled={busy} /></label>{' '}<label>有效分钟（最多 24 小时）<InputNumber aria-label="授权有效分钟" min={1} max={1440} value={minutes} onChange={v => setMinutes(v ?? 60)} disabled={busy} /></label>
      <p><Button disabled={busy || !selected || !power && !brightness} onClick={async () => { const actions = [...(power ? ['power'] : []), ...(brightness ? ['brightness'] : [])]; if (await dialogs.confirm(`允许本机 Pulse 控制 ${selected?.name}（${grantDevice}）：${actions.join('、')}，亮度不超过 ${maximum}%，有效 ${minutes} 分钟？不包含其他设备和高风险动作。`)) await mutate('grant', { deviceId: grantDevice, actions, brightnessMax: maximum, expiresInMinutes: minutes }) }}>确认具体范围并授权</Button></p>
      {status?.grants.map(grant => <p key={grant.authorizationRef}>{grant.deviceId}：{grant.actions.join('、')}，到期 {new Date(grant.expiresAt).toLocaleString()} <Button disabled={busy} danger onClick={() => void mutate('revoke', { authorizationRef: grant.authorizationRef })}>立即撤权</Button></p>)}
    </Card>
    <Card className="settings-card" title="命令与结果证据">
      <p>已发送不等于已完成。结果不明时可逐条只读查询原命令与新鲜状态，不重发、不创建新命令，也不会自动连接网关。停止播报也不等于停止设备动作。</p>
      {status?.unresolvedCount !== undefined && <p>保留的未决命令：{status.unresolvedCount}。关闭设备接入或等待凭据交接不会清除这些结果。</p>}
      {status?.terminalHistoryTruncated && <p>仅显示最近 30 条已结束命令，所有未决命令都保留展示；后台审计记录未被删除。</p>}
      <p>人工处理须先关闭并撤权，再现场核实单个低风险灯具。处理后执行结果仍未知，只解除所选命令隔离；旧动作可能迟到。不会重发、重新连接或恢复授权。</p>{status?.blockingCount !== undefined && <p>仍阻断后续控制：{status.blockingCount}；已人工解除隔离但结果仍未知：{status.manuallyReleasedCount ?? 0}。</p>}<p>审计来源说明可信 Host 的执行入口，关联 ID 不证明用户身份，也不能替代审批。</p><p>HA 状态、更新时间和在线标记仅代表网关报告，不能证明设备实际执行。旧 HA 记录中的 observed 也不补作物理确认依据。</p>
      {!status?.commands.length && <p>暂无命令。启用并授权模拟灯后，可以对语音助手说“把模拟客厅灯亮度调到 30%”。</p>}
      {status?.commands.map(command => <p key={command.commandId}>{command.request.deviceId} · {commandLabels[command.status] ?? command.status} · {new Date(command.updatedAt).toLocaleString()}<br />命令 {command.commandId}{command.reason ? ` · ${command.reason}` : ''}<br />{command.audit ? command.audit.dispatch ? `执行前授权：${command.audit.dispatch.grant.actions.join('、')}，到期 ${new Date(command.audit.dispatch.grant.expiresAt).toLocaleString()}${command.audit.dispatch.grant.limits?.brightness ? `，亮度上限 ${command.audit.dispatch.grant.limits.brightness.max}%` : ''}。额外动作确认：${command.audit.dispatch.confirmation.required ? command.audit.dispatch.confirmation.verifiedByHost ? '可信 Host 已验证' : '未验证' : '此授权未要求'}。` : '未记录执行前授权通过证据，不能据此声称已经下发。' : '旧记录未采集授权快照，不补造历史。'}{['accepted', 'sent', 'unknown'].includes(command.status) && <><br /><Button disabled={busy} onClick={() => void mutate('reconcile', { commandId: command.commandId })}>只读查询原命令状态</Button></>}{command.status === 'unknown' && !command.manualDisposition && <><br /><Button disabled={busy || status.enabled} onClick={() => void manualRelease(command.commandId)}>逐条人工处理隔离</Button></>}{command.manualDisposition && <><br /><strong>已人工处理隔离，执行结果仍未知；没有恢复授权。</strong> {new Date(command.manualDisposition.at).toLocaleString()} · {command.manualDisposition.eventId}</>}{reconciliations[command.commandId] && <span role="status"><br />查询时间：{new Date(reconciliations[command.commandId]!.checkedAt).toLocaleString()}。{reconciliationLabels[reconciliations[command.commandId]!.outcome] ?? '结果仍未确定。保留原记录，没有重发命令。'}</span>}</p>)}
    </Card>
    <Card className="settings-card" title="授权生命周期">
      <p>最近的授权与撤销事件（共 {status?.permissionEventCount ?? 0} 条）。撤权不抹去既有命令的当时授权范围；旧记录没有审计数据时不补造。</p>
      {status?.permissionEvents?.map(event => <p key={event.eventId}>{new Date(event.at).toLocaleString()} · {event.action === 'grant' ? '发放授权' : '撤销授权'} · {event.grant.deviceId} · {event.grant.actions.join('、')}</p>)}
    </Card>
    <TerminalDiagnostics transport={transport} canManage={canManage} />
    <SceneSandbox transport={transport} canManage={canManage} />
  </>
}
