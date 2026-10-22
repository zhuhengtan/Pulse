import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Pagination, Modal, Tag } from 'antd'
import { usePulseDialogs } from './PulseControls.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

interface Device { id: string; name: string; createdAt: string; lastUsedAt: string; clientType?: 'web' | 'h5' | 'electron'; scope?: 'local' | 'paired' }
const clientLabels = { web: 'Web', h5: 'H5', electron: 'Electron' }
interface Pairing { qrSvg: string; pairUrl: string; expiresAt: number }
const pageSize = 8
function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false })
}

export function DeviceManagement({ transport, localAdmin }: { transport: PulseWebTransport; localAdmin: boolean }) {
  const dialogs = usePulseDialogs()
  const [snapshot, setSnapshot] = useState<{ devices: Device[]; currentId?: string }>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [pairing, setPairing] = useState<Pairing>()
  const [pairingLoading, setPairingLoading] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [now, setNow] = useState(Date.now())
  const connect = async () => {
    setPairingOpen(true); setPairingLoading(true); setPairingError(''); setPairing(undefined)
    try { setPairing(await apiJson<Pairing>(transport, '/api/pair/qr')); setNow(Date.now()) }
    catch { setPairingError('二维码无法加载，请检查本机连接后重试。') }
    finally { setPairingLoading(false) }
  }
  useEffect(() => {
    if (!pairingOpen || !localAdmin) return
    let active = true
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    const poll = window.setInterval(() => { void apiJson<Device[]>(transport, '/api/devices').then(devices => { if (active) setSnapshot(value => value ? { ...value, devices } : value) }).catch(() => {}) }, 3000)
    return () => { active = false; window.clearInterval(timer); window.clearInterval(poll) }
  }, [pairingOpen, localAdmin, transport])
  const load = async () => {
    setLoading(true); setError('')
    try {
      const [devices, session] = await Promise.all([
        apiJson<Device[]>(transport, '/api/devices'),
        apiJson<{ deviceId?: string }>(transport, '/api/session'),
      ])
      setSnapshot({ devices, ...(session.deviceId ? { currentId: session.deviceId } : {}) })
    } catch { setError('设备列表无法加载，请检查本机 Pulse 连接后重试。') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (localAdmin) void load() }, [transport, localAdmin])
  const filtered = useMemo(() => [...(snapshot?.devices ?? [])].sort((a, b) =>
    Number(b.id === snapshot?.currentId) - Number(a.id === snapshot?.currentId) || b.lastUsedAt.localeCompare(a.lastUsedAt)
  ).filter(device => `${device.name} ${device.id} ${device.clientType ? clientLabels[device.clientType] : ''}`.toLowerCase().includes(search.trim().toLowerCase())), [snapshot, search])
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  const remove = async (device: Device) => {
    if (busy || loading || !snapshot?.currentId || device.id === snapshot.currentId) return
    if (!await dialogs.confirm(`移除“${device.name}”（${device.id.slice(-8)}）的授权？此客户端需要重新配对才能访问 Pulse。聊天和项目不会被删除。`)) return
    setBusy(device.id); setError(''); setMessage('')
    try {
      const result = await apiJson<{ ok: boolean }>(transport, `/api/devices/${encodeURIComponent(device.id)}/revoke`, jsonRequest('POST'))
      if (!result.ok) { await load(); setMessage('该设备授权已不存在，列表已更新。'); return }
      setSnapshot(value => value ? { ...value, devices: value.devices.filter(item => item.id !== device.id) } : value)
      setMessage('已移除设备授权。')
    } catch { setError('移除失败，请重试。') }
    finally { setBusy('') }
  }
  if (!localAdmin) return <section className="settings-card"><p>请在运行 Pulse 的电脑上管理设备授权。</p></section>
  return <section className="settings-card device-management" aria-label="已授权设备">
    <p className="device-explanation">查看已登录的 Web、H5 和 Electron 客户端。同一客户端会记住授权，再次打开或扫码时复用记录。清除浏览器数据或重装后需要重新连接。</p>
    <div className="device-connect"><div><strong>连接手机 / H5</strong><p>手机与电脑连接同一 Wi-Fi，扫码后即可访问 Pulse。</p></div><Button type="primary" onClick={() => void connect()}>扫码连接</Button></div>
    <div className="device-toolbar"><Input aria-label="搜索设备" placeholder="搜索设备名称或编号" allowClear value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><Button loading={loading} disabled={Boolean(busy)} onClick={() => void load()}>刷新</Button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {snapshot && !snapshot.currentId && <p className="settings-error">无法识别当前设备，暂不可移除授权，请刷新后重试。</p>}
    {snapshot?.devices.some(device => !device.clientType) && <p className="device-history-note">历史记录会在客户端重新连接后补充类型，同名记录不会自动合并。</p>}
    <p className="device-count">共 {snapshot?.devices.length ?? 0} 台已授权设备{search && `，找到 ${filtered.length} 台`}</p>
    <div className="device-list" aria-busy={loading}>
      {filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(device => <article className="managed-device" key={device.id} aria-label={`${device.name} ${device.id.slice(-8)}`}>
        <div className="managed-device-info"><strong>{device.name}<Tag>{device.clientType ? clientLabels[device.clientType] : '历史客户端'}</Tag>{device.id === snapshot?.currentId && <Tag color="blue">当前设备</Tag>}</strong><code title={device.id}>编号 {device.id.slice(-8)}</code><small>最近使用：{dateLabel(device.lastUsedAt)}</small><small>授权时间：{dateLabel(device.createdAt)}</small></div>
        <div className="managed-device-actions"><Button danger disabled={loading || Boolean(busy) || !snapshot?.currentId || device.id === snapshot.currentId} onClick={() => void remove(device)}>移除</Button></div>
      </article>)}
      {!filtered.length && !loading && snapshot && <p className="device-empty">{search ? '没有匹配的设备。' : '暂无已授权设备。'}</p>}
    </div>
    {filtered.length > pageSize && <Pagination className="device-pagination" current={currentPage} pageSize={pageSize} total={filtered.length} showSizeChanger={false} onChange={setPage} />}
    <Modal title="连接手机 / H5" open={pairingOpen} onCancel={() => setPairingOpen(false)} footer={<><Button onClick={() => setPairingOpen(false)}>完成</Button><Button type="primary" loading={pairingLoading} onClick={() => void connect()}>刷新二维码</Button></>}>
      <div className="device-pairing"><p>请用手机相机扫码，并在浏览器中打开。手机与电脑需要连接同一 Wi-Fi。</p>
        {pairingLoading && <p role="status">正在生成二维码…</p>}
        {pairingError && <p role="alert" className="settings-error">{pairingError}</p>}
        {pairing && (pairing.expiresAt > now ? <><img src={`data:image/svg+xml,${encodeURIComponent(pairing.qrSvg)}`} alt="H5 连接二维码"/><p>有效期剩余 {Math.ceil((pairing.expiresAt - now) / 1000)} 秒；扫码完成后列表会自动更新。</p><Input aria-label="H5 连接地址" readOnly value={pairing.pairUrl}/></> : <p role="status">二维码已过期，请刷新后重新扫码。</p>)}
      </div>
    </Modal>
  </section>
}
