import { useEffect, useState } from 'react'
import { apiJson, jsonRequest, ApiError, type PulseWebTransport } from './transport.js'
import { PulseButton, PulseInput, usePulseDialogs } from './PulseControls.js'
import './skill-manager.css'

type Origin = { repository: string; directory: string; commit: string; ref: string }
type Installed = { name: string; description: string; builtin: boolean; managed: boolean; modified: boolean; origin?: Origin }
type Detail = { name: string; description: string; content: string; compatibility?: string; license?: string; warnings: string[]; files: Array<{ path: string; bytes: number }>; origin?: Origin; builtin?: boolean }
type SearchResult = { id: string; name: string; source: string; installs: number }
const errors: Record<string, string> = {
  SKILL_DOWNLOAD_TOO_LARGE: '仓库下载超出大小限制，请选择更小的技能仓库。', SKILL_PREVIEW_TOO_LARGE: '该仓库的技能资源过多，尝试指定 owner/repo@skill。', SKILL_BYTES_LIMIT_EXCEEDED: '技能资源超出大小限制，未安装任何文件。', SKILL_SYMLINK_OR_FILE_TYPE_REJECTED: '所选技能目录含符号链接或不支持的文件类型，无法安装。', SKILL_METADATA_INVALID: '技能的名称或描述无效，请检查 SKILL.md。', SKILL_DESTINATION_EXISTS: '目标目录已经存在，请选择新的目录。',

  SKILL_REMOTE_RATE_LIMITED: '平台请求过多，请稍后重试。', SKILL_SEARCH_RESPONSE_CHANGED: '搜索接口发生变化，可改用 GitHub 仓库地址安装。', SKILL_REMOTE_NOT_FOUND: '没有找到可安装的技能，请检查仓库地址或技能名称。', SKILL_LOCALLY_MODIFIED: '技能有本地修改，已停止覆盖或删除，请先保存自己的修改。', SKILL_ALREADY_INSTALLED: '同名技能已经存在，请使用更新，或先处理已有技能。', SKILL_BUILTIN_PROTECTED: '内置技能随应用更新，不能在这里替换或卸载。', CONFIG_VERSION_CONFLICT: '配置已被其他操作修改，请重新加载设置后再试。', SKILL_PREVIEW_EXPIRED: '预览已过期，请重新查看后安装。', SKILL_STORE_BUSY: '技能目录正在使用，请稍后重试。', SKILL_GITHUB_SOURCE_REQUIRED: '首版支持公开 GitHub 仓库，请填写 https://github.com/owner/repo。',
}
function message(error: unknown): string {
  if (error instanceof ApiError) { const code = error.message; for (const [key, label] of Object.entries(errors)) if (code.includes(key)) return label }
  return `操作失败：${error instanceof Error ? error.message : '请检查网络与仓库地址'}`
}
export function SkillManager({ transport, configVersion, blocked, onChanged }: { transport: PulseWebTransport; configVersion: string | undefined; blocked: boolean; onChanged: () => Promise<void> }) {
  const dialogs = usePulseDialogs()
  const [tab, setTab] = useState<'market' | 'installed'>('market'), [query, setQuery] = useState(''), [source, setSource] = useState('')
  const [results, setResults] = useState<SearchResult[]>([]), [installed, setInstalled] = useState<Installed[]>([]), [details, setDetails] = useState<Detail[]>([])
  const [preview, setPreview] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [searched, setSearched] = useState(false)
  async function loadInstalled() { const value = await apiJson<{ skills: Installed[] }>(transport, '/api/skill-marketplace/installed'); setInstalled(value.skills) }
  useEffect(() => { void loadInstalled().catch(error => setError(message(error))) }, [transport])
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work() } catch (error) { setError(message(error)) } finally { setBusy(false) } }
  async function inspect(value: string) { setResults([]); setSearched(false); setDetails([]); setPreview(undefined); const result = await apiJson<{ previewId: string; skills: Detail[] }>(transport, '/api/skill-marketplace/inspect', jsonRequest('POST', { source: value })); setPreview(result.previewId); setDetails(result.skills) }
  async function mutate(action: string, data: Record<string, unknown>) {
    await apiJson(transport, `/api/skill-marketplace/${action}`, jsonRequest('POST', { ...data, configVersion }))
    await loadInstalled(); await onChanged(); window.dispatchEvent(new Event('pulse:skills-changed'))
    setNotice(action === 'uninstall' ? '技能已卸载。' : '技能已安装并启用，可在输入框键入 / 后选择。')
    setDetails([]); setPreview(undefined)
  }
  return <section className="skill-manager" aria-label="技能管理">
    <header className="editor-section-head"><div><h2>技能</h2><p>从 skills.sh 发现技能，安装后通过 /技能名 使用。</p></div><div className="skill-tabs"><PulseButton className={tab === 'market' ? 'active' : ''} onClick={() => setTab('market')}>技能市场</PulseButton><PulseButton className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>已安装</PulseButton></div></header>
    {blocked && <p className="settings-alert">请先保存或取消下面的配置修改，再安装或更新技能。</p>}
    {error && <p className="settings-alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {tab === 'market' ? <>
      <form className="skill-search" onSubmit={event => { event.preventDefault(); void run(async () => { const value = await apiJson<{ skills: SearchResult[] }>(transport, `/api/skill-marketplace/search?q=${encodeURIComponent(query)}`); setResults(value.skills); setSearched(true) }) }}><PulseInput aria-label="搜索技能" placeholder="搜索技能，例如 react、testing" value={query} onChange={event => setQuery(event.target.value)} /><PulseButton type="submit" disabled={busy || query.trim().length < 2}>搜索</PulseButton></form>
      <form className="skill-search" onSubmit={event => { event.preventDefault(); void run(() => inspect(source)) }}><PulseInput aria-label="GitHub 技能仓库地址" placeholder="GitHub 仓库地址或 owner/repo@skill" value={source} onChange={event => setSource(event.target.value)} /><PulseButton type="submit" disabled={busy || !source.trim()}>查看仓库</PulseButton></form>
      <div className="skill-list">{results.map(item => <article key={item.id}><div><strong>{item.name}</strong><small>{item.source} · {item.installs.toLocaleString()} 次安装</small></div><PulseButton disabled={busy} onClick={() => void run(() => inspect(`${item.source}@${item.id.split('/').pop()}`))}>查看详情</PulseButton></article>)}{searched && !results.length && <p>没有搜索结果，可尝试其他关键词或直接填写仓库地址。</p>}</div>
    </> : <div className="skill-list">{installed.map(item => <article key={item.name}><div><strong>/{item.name} {item.builtin && <span className="skill-badge">内置</span>}</strong><p>{item.description}</p><small>{item.origin?.repository}{item.modified ? ' · 有本地修改' : ''}</small></div><div className="skill-actions"><PulseButton disabled={busy} onClick={() => void run(async () => { setPreview(undefined); setDetails([await apiJson<Detail>(transport, `/api/skill-marketplace/detail?name=${encodeURIComponent(item.name)}`)]) })}>详情</PulseButton>{!item.builtin && item.managed && <><PulseButton disabled={busy || blocked || item.modified || !item.origin} onClick={() => void run(() => mutate('update', { name: item.name }))}>更新</PulseButton><PulseButton className="settings-danger" disabled={busy || item.modified} onClick={() => void run(async () => { if (await dialogs.confirm(`卸载技能 ${item.name}？`)) await mutate('uninstall', { name: item.name }) })}>卸载</PulseButton></>}</div></article>)}</div>}
    {busy && <p role="status">正在处理…</p>}
    {details.map(detail => <article className="skill-detail" key={detail.name + (detail.origin?.directory ?? '')}><header><div><h3>{detail.name}</h3><p>{detail.description}</p></div>{preview && !detail.builtin && <PulseButton className="settings-primary" disabled={busy || blocked || installed.some(item => item.name === detail.name)} onClick={() => void run(() => mutate('install', { previewId: preview, name: detail.name, directory: detail.origin?.directory ?? '' }))}>{installed.some(item => item.name === detail.name) ? '已安装' : '安装并启用'}</PulseButton>}</header>
      {detail.origin && <p className="skill-origin">{detail.origin.repository} / {detail.origin.directory || '.'}<br/>版本：{detail.origin.commit}</p>}
      {detail.compatibility && <p>环境要求：{detail.compatibility}</p>}{detail.license && <p>许可：{detail.license}</p>}{detail.warnings.map((warning, i) => <p className="settings-alert" key={i}>{warning}</p>)}
      <details><summary>附带文件（{detail.files.length}）</summary><ul>{detail.files.map(file => <li key={file.path}><code>{file.path}</code> · {file.bytes.toLocaleString()} B</li>)}</ul></details>
      <details><summary>技能正文</summary><pre>{detail.content}</pre></details>
      <p className="skill-hint">安装只保存文件。使用脚本时沿用任务审批和沙箱；依赖由实际任务检查，执行失败会显示在对应工具结果中。</p>
    </article>)}
  </section>
}
