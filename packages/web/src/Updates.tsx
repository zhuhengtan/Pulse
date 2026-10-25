import { useEffect, useState } from 'react'
import './updates.css'
import { Button, Card, Switch, Tag } from 'antd'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

interface UpdateStatus {
  frontend: string; frontendVersion?: string; enabled?: boolean; trusted?: boolean; autoDownload?: boolean;
  running?: { backend: string; shell?: string }; active?: Record<string, { version: string }>;
  previous?: Record<string, { version: string }>; staged?: Record<string, { version: string }>;
  phase?: string; pending?: boolean; error?: string; checkedAt?: string; blocked?: string[];
  lastFailure?: { version: string; code: string; at: string };
  serviceOffline?: boolean;
  progress?: { received: number; total: number };
  available?: Array<{ component: string; version: string; notes: string; downloadUrl: string }>
}
const phases: Record<string, string> = { idle: '已就绪', checking: '检查中', downloading: '下载中', ready: '等待应用', waiting: '等待后台空闲', applying: '正在应用', failed: '更新未完成' }
const reasons: Record<string, string> = { TASKS_OR_MESSAGES_ACTIVE: '任务或消息尚未处理完', DATA_REQUESTS_ACTIVE: '正在处理数据请求', TERMINAL_ACTIVE: '终端仍在运行', AUTOMATION_ACTIVE: '浏览器或自动化会话仍在使用', UPDATE_OTHER_DATA_CLIENTS: '其他 CLI 或服务正在使用数据', MANAGED_SERVICE_REQUIRED: '请从托管启动器重启一次后台', SHELL_REQUIRED: '需要更新桌面客户端', CHROMIUM_REQUIRED: '需要更新桌面客户端的浏览器内核', MANUAL_DATA_MIGRATION_REQUIRED: '需要手动维护升级' }
function useUpdateStatus(transport: PulseWebTransport, enabled = true) {
  const [status, setStatus] = useState<UpdateStatus>(), [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    let active = true, busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try { const value = await apiJson<UpdateStatus>(transport, '/api/updates'); if (active) { setStatus(value); setError('') } }
      catch { if (active) setError('暂时无法读取更新状态，稍后将自动重试。') }
      finally { busy = false }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [transport, enabled])
  return { status, setStatus, error, setError }
}
export function UpdateSettings({ transport, canManage }: { transport: PulseWebTransport; canManage: boolean }) {
  const { status, setStatus, error, setError } = useUpdateStatus(transport)
  const [busy, setBusy] = useState(false)
  const action = async (name: string, body?: unknown) => {
    setBusy(true); setError('')
    try { setStatus(await apiJson<UpdateStatus>(transport, '/api/updates/' + name, jsonRequest('POST', body))) }
    catch { setError('操作未完成。请检查网络或等待当前更新结束后重试。') }
    finally { setBusy(false) }
  }
  const shell = status?.available?.find(item => item.component === 'shell')
  return <Card className="settings-card pulse-updates" title="软件更新">
    <p>后台和界面分别更新。后台下载完成后等待空闲再应用，已打开的界面会提示刷新。</p>
    {status?.serviceOffline && <p>后台未连接或尚未提供更新接口，仍可检查和下载；安排的更新将在托管后台启动后应用。</p>}
    <dl><dt>后台版本</dt><dd>{status?.running?.backend ?? '—'}</dd><dt>前端版本</dt><dd>{status?.frontendVersion ?? '随安装包提供'}</dd>{status?.running?.shell && <><dt>桌面壳版本</dt><dd>{status.running.shell}</dd></>}</dl>
    {status?.phase && <Tag>{phases[status.phase] ?? status.phase}</Tag>}
    {status?.checkedAt && <p>上次检查：{new Date(status.checkedAt).toLocaleString()}</p>}
    {status?.progress && <p role="status">下载进度：{Math.round(status.progress.received / status.progress.total * 100)}%</p>}
    {status?.staged && <p>已准备：{Object.entries(status.staged).map(([name, value]) => `${name === 'backend' ? '后台' : '界面'} ${value.version}`).join('、')}</p>}
    {status?.blocked?.map(reason => <p key={reason}>{reasons[reason] ?? '更新将在满足兼容条件且后台空闲后继续。'}</p>)}
    {(error || status?.error) && <p role="alert">{error || `更新未完成：${status?.error}`}</p>}
    {status?.lastFailure && <p>上次应用未完成：{status.lastFailure.version}（{status.lastFailure.code}），已保留可用版本。</p>}
    {!canManage && <p>后台更新由这台电脑的本机管理员管理。</p>}
    {canManage && <>
      {status?.enabled === false && <p>开发或未托管环境不会自动更新。正式部署可使用 pulse update enable 接入。</p>}
      {status?.trusted === false && <p>尚未配置发布公钥，当前版本将继续运行。</p>}
      <label>自动下载并在后台空闲后应用 <Switch checked={status?.autoDownload ?? true} disabled={busy || !status} onChange={autoDownload => { void action('settings', { autoDownload }) }} /></label>
      <div className="pulse-update-actions"><Button loading={busy} onClick={() => { void action('check') }}>检查更新</Button><Button disabled={busy || status?.pending || !status?.available?.some(item => item.component !== 'shell')} onClick={() => { void action('download') }}>下载更新</Button><Button disabled={busy || !status?.staged} onClick={() => { void action('apply') }}>空闲时应用</Button><Button disabled={busy || !status?.previous} onClick={() => { void action('rollback') }}>回退到上一版本</Button></div>
      {shell && (!status?.running?.shell || shell.version.localeCompare(status.running.shell, undefined, { numeric: true }) > 0) && <p>桌面客户端 {shell.version} 可用。<a href={shell.downloadUrl} target="_blank" rel="noreferrer">下载安装包</a>，安装后重新打开即可。</p>}
      {status?.available?.map(item => <details key={`${item.component}-${item.version}`}><summary>{item.component === 'shell' ? '桌面客户端' : item.component === 'backend' ? '后台' : '界面'} {item.version}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{item.notes || '维护更新'}</p></details>)}
    </>}
  </Card>
}
export function FrontendUpdateNotice({ transport, enabled, refresh }: { transport: PulseWebTransport; enabled: boolean; refresh: () => void }) {
  const current = document.querySelector<HTMLMetaElement>('meta[name="pulse-frontend"]')?.content
  const { status } = useUpdateStatus(transport, enabled && Boolean(current))
  if (!current || !status || status.frontend === current) return null
  return <aside className="pulse-update-notice" role="status"><span>界面已有新版本，刷新后使用。</span><Button size="small" onClick={refresh}>保留草稿并刷新</Button></aside>
}
