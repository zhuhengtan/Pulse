import { useEffect, useState, type ReactNode } from 'react'
import { Button, Spin, Tag } from 'antd'
import { useNavigate } from 'react-router'
import { ApiError, apiJson, browserTransport, jsonRequest, type PulseWebTransport } from './transport.js'
import { Icon } from './Icon.js'
import { PulseBrand } from './PulseBrand.js'

export interface DesktopSetupStatus {
  phase: 'preparing' | 'starting' | 'ready' | 'error'
  firstRun: boolean
  development?: boolean
  version?: string
  configPath?: string
  dataDirectory?: string
  error?: string
  cli?: { path: string; conflict?: string }
  path?: { ready: boolean; restartTerminal?: boolean }
  service?: { connected: boolean; outdated?: boolean; version?: string }
  steps: Array<{ id: string; label: string; state: 'pending' | 'running' | 'ready' | 'warning' | 'error'; detail?: string }>
}
function useDesktopSetup(transport: PulseWebTransport, enabled: boolean) {
  const [status, setStatus] = useState<DesktopSetupStatus>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    let active = true, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try { const next = await apiJson<DesktopSetupStatus>(transport, '/api/desktop/setup'); if (active) { setStatus(next); setError('') } }
      catch { if (active) setError('无法读取安装状态，请重新打开客户端后重试。') }
      finally { pending = false }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 700)
    return () => { active = false; window.clearInterval(timer) }
  }, [transport, enabled])
  return { status, error, setError, setStatus }
}
function SetupDetails({ status, welcome = false }: { status?: DesktopSetupStatus | undefined; welcome?: boolean }) {
  return <div className="desktop-setup-steps">{status?.steps.map(step => <div key={step.id} className={`desktop-setup-step ${step.state}`}><span>{step.state === 'running' ? <Spin size="small" /> : step.state === 'ready' ? <span aria-hidden="true">✓</span> : <Icon name={step.state === 'error' ? 'close' : 'info'} size={17}/>}</span><div><strong>{step.label}</strong>{step.detail && (!welcome || !['config', 'cli'].includes(step.id) || step.state !== 'ready') && <small>{step.detail}</small>}</div><Tag color={step.state === 'ready' ? 'success' : step.state === 'error' ? 'error' : step.state === 'warning' ? 'warning' : 'default'}>{step.state === 'ready' ? '已就绪' : step.state === 'warning' ? '需留意' : step.state === 'error' ? '未完成' : '准备中'}</Tag></div>)}</div>
}
export function DesktopEnvironment({ transport, welcome = false, onContinue, onConfigureModels }: { transport: PulseWebTransport; welcome?: boolean; onContinue?: () => void; onConfigureModels?: () => void }) {
  const { status, error, setError, setStatus } = useDesktopSetup(transport, true)
  const [busy, setBusy] = useState(false)
  const action = async (name: 'repair' | 'complete' | 'restart-service' | 'data-directory', next?: () => void) => {
    setBusy(true); setError('')
    try {
      const result = await apiJson<DesktopSetupStatus>(transport, `/api/desktop/setup/${name}`, jsonRequest('POST'))
      if (name !== 'data-directory') setStatus(result)
      next?.()
    } catch (error) { setError(error instanceof ApiError && error.detail === 'SERVICE_IDENTITY_UNVERIFIED' ? '无法确认旧后台的身份。请先在原来的终端或服务管理入口停止该后台，再点击“检查并修复”。' : '操作未完成，请检查安装状态后重试。') }
    finally { setBusy(false) }
  }
  const preparing = !status || ['preparing', 'starting'].includes(status.phase)
  return <section className={welcome ? 'desktop-welcome-card' : 'settings-card desktop-environment'}>
    <div className="desktop-setup-intro"><div className="desktop-setup-mark"><PulseBrand variant="app" /></div><div><h2>{welcome ? '欢迎使用 Pulse' : '桌面环境'}</h2><p>{preparing ? '正在准备运行环境，首次启动可能需要一点时间。' : status?.phase === 'error' ? '环境准备尚未完成，可在这里修复或更换数据目录。' : '运行环境已准备完成。'}</p></div></div>
    {!status && !error && <div role="status"><Spin/> 正在检查安装状态…</div>}
    {status?.development && <p className="desktop-setup-note">开发预览使用仓库运行环境，不会注册系统命令或修改终端配置。</p>}
    {status?.version && <p className="desktop-setup-version">运行版本：{status.version}</p>}
    <SetupDetails status={status} welcome={welcome}/>
    {(error || status?.error) && <p role="alert" className="settings-error">{error || status?.error}</p>}
    {status?.cli?.conflict && <p className="desktop-setup-note">已有其他 pulse 命令，已保留。桌面版命令可通过完整路径调用：<code>{status.cli.path}</code></p>}
    {status?.cli && !status.cli.conflict && <p className="desktop-setup-note">请打开一个新终端，运行 <code>pulse --version</code> 检查命令。已打开的终端需要重新打开。</p>}
    {status?.path?.ready === false && status.cli && <p className="desktop-setup-note">你也可以直接运行：<code>{status.cli.path} --version</code></p>}
    {!welcome && status?.configPath && <div className="desktop-setup-paths"><span>配置文件 <code>{status.configPath}</code></span><span>聊天数据 <code>{status.dataDirectory}</code></span></div>}
    {status?.phase === 'ready' && welcome && <div className="desktop-model-intro"><strong>接下来配置模型</strong><p>可在“模型与服务商”选择服务商和模型。API Key 使用对应的环境变量；也可以稍后配置，先进入 Pulse。</p></div>}
    <div className="desktop-setup-actions"><Button disabled={busy || preparing} onClick={() => void action('repair')}>检查并修复</Button><Button disabled={busy || preparing} onClick={() => void action('data-directory')}>选择数据目录</Button>{status?.service?.outdated && <Button disabled={busy || preparing} onClick={() => void action('restart-service')}>应用后台更新</Button>}{status?.phase === 'ready' && (welcome ? <><Button disabled={busy} onClick={() => void action('complete', onContinue)}>稍后配置，进入 Pulse</Button><Button type="primary" disabled={busy} onClick={() => void action('complete', onConfigureModels)}>配置模型</Button></> : <Button type="primary" disabled={busy} onClick={onConfigureModels}>模型设置</Button>)}</div>
  </section>
}
export function DesktopSetupBoundary({ children }: { children: ReactNode }) {
  const enabled = window.pulseDesktop?.installation === true
  const [finished, setFinished] = useState(false)
  const { status, error } = useDesktopSetup(browserTransport, enabled && !finished)
  const navigate = useNavigate()
  useEffect(() => { if (status?.phase === 'ready' && !status.firstRun) setFinished(true) }, [status])
  if (!enabled || finished || status?.phase === 'ready' && !status.firstRun) return children
  return <main className="desktop-welcome"><DesktopEnvironment transport={browserTransport} welcome onContinue={() => setFinished(true)} onConfigureModels={() => { setFinished(true); void navigate('/settings/models') }}/>{error && <p role="alert">{error}</p>}</main>
}
