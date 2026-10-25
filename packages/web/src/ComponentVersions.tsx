import { useState } from 'react'
import { Button, Card, Tag } from 'antd'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { useUpdateStatus, type UpdateStatus } from './Updates.js'

const newer = (candidate: string, current?: string) => current ? candidate.localeCompare(current, undefined, { numeric: true }) > 0 : false
export function ComponentVersions({ transport, canManage, onOpenUpdates }: { transport: PulseWebTransport; canManage: boolean; onOpenUpdates: () => void }) {
  const { status, setStatus, error, setError } = useUpdateStatus(transport)
  const [busy, setBusy] = useState(false)
  const currentPage = document.querySelector<HTMLMetaElement>('meta[name="pulse-frontend-version"]')?.content
  async function check() {
    setBusy(true); setError('')
    try { setStatus(await apiJson<UpdateStatus>(transport, '/api/updates/check', jsonRequest('POST', {}))) }
    catch { setError('版本检查未完成，请检查网络后重试。') }
    finally { setBusy(false) }
  }
  const rows = [
    { id: 'shell', title: 'Electron 桌面壳', version: status?.running?.shell, fallback: '未连接桌面壳', method: '下载安装包' },
    { id: 'backend', title: '后台运行包', version: status?.running?.backend, fallback: '暂时无法读取', method: '后台空闲时应用' },
    { id: 'frontend', title: 'Web / H5 界面', version: status?.frontendVersion, fallback: '随安装包提供（未声明版本）', method: '刷新页面生效' },
  ]
  return <div className="component-versions">
    <Card className="settings-card" title="Pulse 组件版本" extra={canManage && <Button loading={busy || status?.phase === 'checking'} onClick={() => void check()}>检查 Pulse 更新</Button>}>
      <p>各组件独立发布。这里查看版本，下载和应用操作在“软件更新”中管理。</p>
      {error && <p role="alert">{error}</p>}
      {status?.error && <p role="alert">上次检查未完成：{status.error}，以下仍显示已缓存的发布信息。</p>}
      {status?.checkedAt ? <p>发布信息检查时间：{new Date(status.checkedAt).toLocaleString()}</p> : <p>尚未取得发布信息，请先检查更新。</p>}
      {!canManage ? <p>完整组件版本和更新由本机管理员查看。</p> : <>
        {status?.serviceOffline && <p>后台未连接，当前显示恢复入口的基础版本和已保存的组件选择。</p>}
        <div className="component-version-list">{rows.map(row => {
          const latest = status?.available?.find(item => item.component === row.id)
          const staged = status?.staged?.[row.id]?.version, previous = status?.previous?.[row.id]?.version
          return <article key={row.id} aria-label={row.title}>
            <header><h3>{row.title}</h3>{latest && newer(latest.version, row.version) && <Tag color="blue">有新版本</Tag>}</header>
            <dl><dt>当前版本</dt><dd>{row.version ?? row.fallback}</dd><dt>最新发布</dt><dd>{latest?.version ?? '尚未检查到发布版本'}</dd><dt>生效方式</dt><dd>{row.method}</dd>
              {staged && <><dt>已下载版本</dt><dd>{staged}</dd></>}{previous && <><dt>上一版本</dt><dd>{previous}</dd></>}
              {row.id === 'frontend' && currentPage && row.version && currentPage !== row.version && <><dt>本页面版本</dt><dd>{currentPage}（刷新后使用当前版本）</dd></>}
            </dl>
            {latest?.requires && <p className="component-version-requirements">{[latest.requires.backend && `后台 ≥ ${latest.requires.backend}`, latest.requires.shell && `桌面壳 ≥ ${latest.requires.shell}`, latest.requires.chromium && `Chromium ≥ ${latest.requires.chromium}`].filter(Boolean).join('；')}</p>}
          </article>
        })}</div>
        <Button onClick={onOpenUpdates}>前往软件更新</Button>
      </>}
    </Card>
    {canManage && <Card className="settings-card" title="后台内部模块">
      <p>以下模块保持配套发布，随后台运行包一起更新。</p>
      {status?.modules?.length ? <div className="component-module-list">{status.modules.map(module => <article key={module.name}><div><strong>{module.title}</strong><small>{module.name}</small></div><span>{module.version ?? '未安装或未声明版本'}</span></article>)}</div> : <p>当前后台未提供内部模块版本信息。</p>}
      {status?.environment && <p className="component-version-requirements">Node.js {status.environment.node}{status.environment.chromium && ` · Chromium ${status.environment.chromium}`}</p>}
    </Card>}
  </div>
}
