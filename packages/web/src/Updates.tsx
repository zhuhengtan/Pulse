import { useEffect, useState } from 'react'
import './updates.css'
import { Button, Card, Switch, Tag } from 'antd'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

export interface UpdateStatus {
  frontend: string; frontendVersion?: string; enabled?: boolean; trusted?: boolean; autoDownload?: boolean;
  running?: { backend: string; shell?: string }; active?: Record<string, { version: string }>;
  previous?: Record<string, { version: string }>; staged?: Record<string, { version: string }>;
  phase?: string; pending?: boolean; error?: string; checkedAt?: string; blocked?: string[];
  lastFailure?: { version: string; code: string; at: string };
  serviceOffline?: boolean;
  progress?: { received: number; total: number };
  modules?: Array<{ name: string; title: string; version?: string }>;
  environment?: { node: string; chromium?: number };
  available?: Array<{ component: string; version: string; notes: string; downloadUrl: string; requires?: { backend?: string; shell?: string; chromium?: number } }>
}
const phases: Record<string, string> = { idle: '已就绪', checking: '检查中', downloading: '下载中', ready: '等待应用', waiting: '等待后台空闲', applying: '正在应用', failed: '更新未完成' }
const reasons: Record<string, string> = { TASKS_OR_MESSAGES_ACTIVE: '任务或消息尚未处理完', DATA_REQUESTS_ACTIVE: '正在处理数据请求', TERMINAL_ACTIVE: '终端仍在运行', AUTOMATION_ACTIVE: '浏览器或自动化会话仍在使用', UPDATE_OTHER_DATA_CLIENTS: '其他 CLI 或服务正在使用数据', MANAGED_SERVICE_REQUIRED: '请从托管启动器重启一次后台', SHELL_REQUIRED: '需要更新桌面客户端', CHROMIUM_REQUIRED: '需要更新桌面客户端的浏览器内核', MANUAL_DATA_MIGRATION_REQUIRED: '需要手动维护升级' }
export function useUpdateStatus(transport: PulseWebTransport, enabled = true) {
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
const newer = (candidate: string, current?: string) => current ? candidate.localeCompare(current, undefined, { numeric: true }) > 0 : false
const overview = (status?: UpdateStatus) => [
  { id: 'shell', title: 'Electron 桌面壳', version: status?.running?.shell, fallback: '未连接桌面壳', method: '下载安装包' },
  { id: 'backend', title: '后台运行包', version: status?.running?.backend, fallback: '暂时无法读取', method: '后台空闲时应用' },
  { id: 'frontend', title: 'Web / H5 界面', version: status?.frontendVersion, fallback: '随安装包提供（未声明版本）', method: '刷新页面生效' },
]

export function UpdateSettings({ transport, canManage }: { transport: PulseWebTransport; canManage: boolean }) {
  const { status, setStatus, error, setError } = useUpdateStatus(transport)
  const [busy, setBusy] = useState(false)
  const currentPage = document.querySelector<HTMLMetaElement>('meta[name="pulse-frontend-version"]')?.content
  const action = async (name: string, body?: unknown) => {
    setBusy(true); setError('')
    try { setStatus(await apiJson<UpdateStatus>(transport, '/api/updates/' + name, jsonRequest('POST', body))) }
    catch { setError('操作未完成。请检查网络或等待当前更新结束后重试。') }
    finally { setBusy(false) }
  }
  const shell = status?.available?.find(item => item.component === 'shell')
  const alert = error || status?.error
  return <div className="component-versions">
    <Card className="settings-card pulse-updates" title="软件更新与组件版本">
      <p>桌面壳、后台运行包和 Web/H5 界面各自发布；版本查看、检查、下载和应用都在这一页完成。后台下载完成后等待空闲再应用，已打开的界面会提示刷新。</p>
      {status?.serviceOffline && <p>后台未连接或尚未提供更新接口，当前显示恢复入口的基础版本和已保存的组件选择；安排的更新会在托管后台启动后应用。</p>}
      {status?.checkedAt ? <p>发布信息检查时间：{new Date(status.checkedAt).toLocaleString()}</p> : <p>尚未取得发布信息，请先检查更新。</p>}
      {alert && <p role="alert">{alert}</p>}
      {!canManage ? <>
        <dl><dt>后台版本</dt><dd>{status?.running?.backend ?? '—'}</dd><dt>前端版本</dt><dd>{status?.frontendVersion ?? '随安装包提供'}</dd>{status?.running?.shell && <><dt>桌面壳版本</dt><dd>{status.running.shell}</dd></>}</dl>
        <p>完整组件版本和更新由本机管理员查看。</p>
      </> : <>
        {status?.phase && <Tag>{phases[status.phase] ?? status.phase}</Tag>}
        <div className="component-version-list">{overview(status).map(row => {
          const latest = status?.available?.find(item => item.component === row.id)
          const staged = status?.staged?.[row.id]?.version, previous = status?.previous?.[row.id]?.version
          return <article key={row.id} aria-label={row.title}>
            <header><h3>{row.title}</h3>{latest && newer(latest.version, row.version) && <Tag color="blue">有新版本</Tag>}</header>
            <dl>
              <dt>当前版本</dt><dd>{row.version ?? row.fallback}</dd>
              <dt>最新发布</dt><dd>{latest?.version ?? '尚未检查到发布版本'}</dd>
              <dt>生效方式</dt><dd>{row.method}</dd>
              {staged && <><dt>已下载版本</dt><dd>{staged}</dd></>}
              {previous && <><dt>上一版本</dt><dd>{previous}</dd></>}
              {row.id === 'frontend' && currentPage && row.version && currentPage !== row.version && <><dt>本页面版本</dt><dd>{currentPage}（刷新后使用当前版本）</dd></>}
            </dl>
            {latest?.requires && <p className="component-version-requirements">{[latest.requires.backend && `后台 ≥ ${latest.requires.backend}`, latest.requires.shell && `桌面壳 ≥ ${latest.requires.shell}`, latest.requires.chromium && `Chromium ≥ ${latest.requires.chromium}`].filter(Boolean).join('；')}</p>}
          </article>
        })}</div>
        {status?.progress && <p role="status">下载进度：{Math.round(status.progress.received / status.progress.total * 100)}%</p>}
        {status?.blocked?.map(reason => <p key={reason}>{reasons[reason] ?? '更新将在满足兼容条件且后台空闲后继续。'}</p>)}
        {status?.lastFailure && <p>上次应用未完成：{status.lastFailure.version}（{status.lastFailure.code}），已保留可用版本。</p>}
        {status?.enabled === false && <p>开发或未托管环境不会自动更新。正式部署可使用 pulse update enable 接入。</p>}
        {status?.trusted === false && <p>尚未配置发布公钥，当前版本将继续运行。</p>}
        <label>自动下载并在后台空闲后应用 <Switch checked={status?.autoDownload ?? true} disabled={busy || !status} onChange={autoDownload => { void action('settings', { autoDownload }) }} /></label>
        <div className="pulse-update-actions"><Button loading={busy} onClick={() => { void action('check') }}>检查更新</Button><Button disabled={busy || status?.pending || !status?.available?.some(item => item.component !== 'shell')} onClick={() => { void action('download') }}>下载更新</Button><Button disabled={busy || !status?.staged} onClick={() => { void action('apply') }}>空闲时应用</Button><Button disabled={busy || !status?.previous} onClick={() => { void action('rollback') }}>回退到上一版本</Button></div>
        {shell && (!status?.running?.shell || shell.version.localeCompare(status.running.shell, undefined, { numeric: true }) > 0) && <p>桌面客户端 {shell.version} 可用。<a href={shell.downloadUrl} target="_blank" rel="noreferrer">下载安装包</a>，安装后重新打开即可。</p>}
        {status?.available?.map(item => <details key={`${item.component}-${item.version}`}><summary>{item.component === 'shell' ? '桌面客户端' : item.component === 'backend' ? '后台' : '界面'} {item.version}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{item.notes || '维护更新'}</p></details>)}
      </>}
    </Card>
    {canManage && <Card className="settings-card" title="后台内部模块">
      <p>以下模块保持配套发布，随后台运行包一起更新。</p>
      {status?.modules?.length ? <div className="component-module-list">{status.modules.map(module => <article key={module.name}><div><strong>{module.title}</strong><small>{module.name}</small></div><span>{module.version ?? '未安装或未声明版本'}</span></article>)}</div> : <p>当前后台未提供内部模块版本信息。</p>}
      {status?.environment && <p className="component-version-requirements">Node.js {status.environment.node}{status.environment.chromium && ` · Chromium ${status.environment.chromium}`}</p>}
    </Card>}
  </div>
}

export function FrontendUpdateNotice({ transport, enabled, refresh }: { transport: PulseWebTransport; enabled: boolean; refresh: () => void }) {
  const current = document.querySelector<HTMLMetaElement>('meta[name="pulse-frontend"]')?.content
  const { status } = useUpdateStatus(transport, enabled && Boolean(current))
  if (!current || !status || status.frontend === current) return null
  return <aside className="pulse-update-notice" role="status"><span>界面已有新版本，刷新后使用。</span><Button size="small" onClick={refresh}>保留草稿并刷新</Button></aside>
}
