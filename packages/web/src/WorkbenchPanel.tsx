import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ApiError, apiJson, jsonRequest } from './transport.js'
import type { PulseWebTransport, WebProject } from './transport.js'
import { Icon } from './Icon.js'
const TerminalConsole = lazy(() => import('./TerminalConsole.js').then(module => ({ default: module.TerminalConsole })))

interface FileEntry { name: string; path: string; type: 'directory' | 'file' | 'other'; size: number; modifiedAt: string }
interface DirectoryResult { path: string; entries: FileEntry[] }
interface FileResult { path: string; binary: boolean; size: number; offset?: number; totalLines?: number; content?: string }
interface GitStatus { isGit: boolean; branch?: string; entries?: Array<{ index: string; worktree: string; path: string }> }
interface TerminalInfo { id: string; projectId: string; exited?: { code: number } }

export function WorkbenchPanel({ project, transport, localAdmin, canUseTerminal, tab, setTab, onClose }: { project?: WebProject | undefined; transport: PulseWebTransport; localAdmin: boolean; canUseTerminal: boolean; tab: 'files' | 'git' | 'preview' | 'terminal'; setTab: (tab: 'files' | 'git' | 'preview' | 'terminal') => void; onClose: () => void }) {
  const [panelWidth, setPanelWidth] = useState(() => Number(window.localStorage.getItem('pulse-web-workbench-width')) || 410)
  const [panelHeight, setPanelHeight] = useState(() => Number(window.localStorage.getItem('pulse-web-terminal-height')) || 340)
  const resizeCleanup = useRef<(() => void) | undefined>(undefined)
  const [path, setPath] = useState('.')
  const [directory, setDirectory] = useState<DirectoryResult>()
  const [file, setFile] = useState<FileResult>()
  const [fileOffset, setFileOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ path: string; line: number; text: string }>>([])
  const [git, setGit] = useState<GitStatus>()
  const [diff, setDiff] = useState('')
  const [staged, setStaged] = useState(false)
  const [previewInput, setPreviewInput] = useState(project?.previewUrl ?? '')
  const [previewUrl, setPreviewUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string>()

  useEffect(() => { window.localStorage.setItem('pulse-web-workbench-width', String(panelWidth)) }, [panelWidth])
  useEffect(() => { window.localStorage.setItem('pulse-web-terminal-height', String(panelHeight)) }, [panelHeight])
  useEffect(() => () => resizeCleanup.current?.(), [])
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    resizeCleanup.current?.()
    const move = (next: PointerEvent) => {
      if (tab === 'terminal') setPanelHeight(Math.max(220, Math.min(window.innerHeight * 0.72, window.innerHeight - next.clientY - 92)))
      else setPanelWidth(Math.max(320, Math.min(900, window.innerWidth * 0.68, window.innerWidth - next.clientX)))
    }
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); resizeCleanup.current = undefined }
    resizeCleanup.current = end
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }

  const projectApi = project ? `/api/projects/${encodeURIComponent(project.id)}` : ''
  const loadDirectory = async (nextPath = '.') => {
    if (!project) return
    setBusy(true); setError(''); setFile(undefined); setPath(nextPath)
    try { setDirectory(await apiJson<DirectoryResult>(transport, `${projectApi}/files?path=${encodeURIComponent(nextPath)}`)) }
    catch (reason) { setError(workspaceError(reason, '目录无法读取。')) }
    finally { setBusy(false) }
  }
  const openFile = async (filePath: string, offset = 0) => {
    if (!project) return
    setBusy(true); setError(''); setFileOffset(offset)
    try { setFile(await apiJson<FileResult>(transport, `${projectApi}/file?path=${encodeURIComponent(filePath)}&offset=${offset}&limit=1000`)) }
    catch (reason) { setError(workspaceError(reason, '文件无法读取。')) }
    finally { setBusy(false) }
  }
  const loadGit = async () => {
    if (!project) return
    setBusy(true); setError('')
    try { setGit(await apiJson<GitStatus>(transport, `${projectApi}/git/status`)); setDiff('') }
    catch (reason) { setError(workspaceError(reason, 'Git 状态无法读取。')) }
    finally { setBusy(false) }
  }
  const loadDiff = async (filePath?: string, useStaged = staged) => {
    if (!project) return
    setBusy(true); setError('')
    try { const value = await apiJson<{ diff: string }>(transport, `${projectApi}/git/diff?staged=${useStaged ? 1 : 0}${filePath ? `&path=${encodeURIComponent(filePath)}` : ''}`); setDiff(value.diff) }
    catch (reason) { setError(workspaceError(reason, 'Git 差异无法读取。')) }
    finally { setBusy(false) }
  }

  useEffect(() => { setPath('.'); setFile(undefined); setDirectory(undefined); setGit(undefined); setTerminals([]); setActiveTerminalId(undefined); setPreviewInput(project?.previewUrl ?? ''); setPreviewUrl(''); if (project) void loadDirectory('.') }, [project?.id])
  useEffect(() => { if (tab === 'git') void loadGit(); if (tab === 'preview' && project?.previewUrl) void refreshPreview() }, [tab, project?.id])
  useEffect(() => { if (tab === 'terminal') void loadTerminals() }, [tab, project?.id, canUseTerminal])

  const runSearch = async () => {
    if (!project || !search.trim()) return
    setBusy(true); setError('')
    try { const value = await apiJson<{ matches: Array<{ path: string; line: number; text: string }> }>(transport, `${projectApi}/search?q=${encodeURIComponent(search.trim())}`); setSearchResults(value.matches) }
    catch (reason) { setError(workspaceError(reason, '搜索失败。')) }
    finally { setBusy(false) }
  }
  const savePreview = async () => {
    if (!project || !localAdmin) return
    setBusy(true); setError('')
    try {
      const value = await apiJson<WebProject>(transport, projectApi, jsonRequest('PATCH', { previewUrl: previewInput.trim() || null }))
      setPreviewInput(value.previewUrl ?? ''); setPreviewUrl('')
    } catch { setError('仅支持登记本机回环地址和明确端口，例如 http://127.0.0.1:5173。') }
    finally { setBusy(false) }
  }
  const refreshPreview = async () => {
    if (!project?.previewUrl) return
    setBusy(true); setError('')
    try { const value = await apiJson<{ url: string }>(transport, `${projectApi}/preview-ticket`, jsonRequest('POST')); setPreviewUrl(value.url) }
    catch { setError('预览无法加载，请检查项目开发服务器和登记地址。') }
    finally { setBusy(false) }
  }

  const loadTerminals = async () => {
    if (!project || !canUseTerminal) return
    try {
      const value = await apiJson<TerminalInfo[]>(transport, `/api/terminals?projectId=${encodeURIComponent(project.id)}`)
      setTerminals(value)
      setActiveTerminalId(current => value.some(item => item.id === current) ? current : value[0]?.id)
    } catch { setTerminals([]); setActiveTerminalId(undefined) }
  }
  const createTerminal = async () => {
    if (!project || !canUseTerminal) return
    setBusy(true); setError('')
    try {
      const terminal = await apiJson<TerminalInfo>(transport, '/api/terminals', jsonRequest('POST', { projectId: project.id }))
      setTerminals(items => [...items, terminal]); setActiveTerminalId(terminal.id)
    } catch (reason) { setError(reason instanceof ApiError && reason.status === 429 ? '终端数量已达上限，请先关闭不再使用的终端。' : '终端无法启动，请检查本机终端支持和项目目录。') }
    finally { setBusy(false) }
  }
  const closeTerminal = async (terminal: TerminalInfo) => {
    if (!window.confirm('关闭这个终端会结束它启动的进程，确定继续吗？')) return
    setBusy(true); setError('')
    try {
      await apiJson<{ ok: boolean }>(transport, `/api/terminals/${encodeURIComponent(terminal.id)}`, { method: 'DELETE' })
      setTerminals(items => items.filter(item => item.id !== terminal.id))
      setActiveTerminalId(current => current === terminal.id ? terminals.find(item => item.id !== terminal.id)?.id : current)
    } catch { setError('终端关闭失败。') }
    finally { setBusy(false) }
  }

  if (!project) return <aside className={`workbench-panel ${tab === 'terminal' ? 'terminal-dock' : ''}`} style={{ '--workbench-width': `${panelWidth}px`, '--workbench-height': `${panelHeight}px` } as CSSProperties}><button className="workbench-resize" onPointerDown={beginResize} aria-label={tab === 'terminal' ? '调整终端高度' : '调整工作区宽度'} /><header className="workbench-header"><strong>工作区</strong><button className="icon-button" onClick={onClose} aria-label="关闭工作区"><Icon name="close"/></button></header><div className="workbench-empty"><Icon name="folder" size={30}/><strong>选择一个项目</strong><span>登记本机目录后，可在这里查看文件、Git 差异和预览。</span></div></aside>
  const parentPath = path === '.' ? undefined : path.split('/').slice(0, -1).join('/') || '.'
  const crumbs = path === '.' ? [] : path.split('/').filter(Boolean)
  return <aside className={`workbench-panel ${tab === 'terminal' ? 'terminal-dock' : ''}`} style={{ '--workbench-width': `${panelWidth}px`, '--workbench-height': `${panelHeight}px` } as CSSProperties} aria-label="工作区面板">
    <button className="workbench-resize" onPointerDown={beginResize} aria-label={tab === 'terminal' ? '调整终端高度' : '调整工作区宽度'} />
    <header className="workbench-header"><div><strong>{project.name}</strong><small title={project.cwd}>{project.cwd}</small></div><button className="icon-button" onClick={onClose} aria-label="关闭工作区"><Icon name="close"/></button></header>
    <nav className="workbench-tabs">{(['files', 'git', 'preview', 'terminal'] as const).map(value => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'files' ? '文件' : value === 'git' ? 'Git' : value === 'preview' ? '预览' : '终端'}</button>)}</nav>
    {!project.available && <p className="workbench-alert">这个目录当前不可用；历史聊天和记录仍保留。</p>}
    {error && <p className="workbench-alert" role="alert">{error}</p>}
    {tab === 'files' && <div className="workbench-content">
      <form className="file-search" onSubmit={event => { event.preventDefault(); void runSearch() }}><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索项目文件"/><button disabled={busy || !search.trim()}>搜索</button></form>
      {searchResults.length > 0 && <div className="search-results">{searchResults.map((result, index) => <button key={`${result.path}-${result.line}-${index}`} onClick={() => { void openFile(result.path); setSearchResults([]) }}><strong>{result.path}:{result.line}</strong><span>{result.text}</span></button>)}</div>}
      {file ? <section className="file-view"><header><button onClick={() => setFile(undefined)}>← 文件列表</button><strong title={file.path}>{file.path}</strong><button onClick={() => void navigator.clipboard?.writeText(file.content ?? '')}>复制</button></header>{file.binary ? <p>这是二进制文件，暂不支持预览（{formatBytes(file.size)}）。</p> : <><pre><code>{file.content}</code></pre>{(fileOffset > 0 || (file.totalLines ?? 0) > fileOffset + 1000) && <footer><button disabled={fileOffset <= 0} onClick={() => void openFile(file.path, Math.max(0, fileOffset - 1000))}>上一页</button><span>{fileOffset + 1}–{Math.min(fileOffset + 1000, file.totalLines ?? fileOffset + 1000)} / {file.totalLines}</span><button disabled={fileOffset + 1000 >= (file.totalLines ?? 0)} onClick={() => void openFile(file.path, fileOffset + 1000)}>下一页</button></footer>}</>}</section> : <><div className="file-breadcrumb"><button onClick={() => void loadDirectory('.')}>项目</button>{crumbs.map((crumb, index) => <button key={`${crumb}-${index}`} onClick={() => void loadDirectory(crumbs.slice(0, index + 1).join('/'))}>/ {crumb}</button>)}</div>{parentPath && <button className="file-entry parent" onClick={() => void loadDirectory(parentPath)}>↑ 上一级</button>}{busy && !directory ? <p>正在读取文件…</p> : directory?.entries.map(entry => <button className="file-entry" key={entry.path} onClick={() => entry.type === 'directory' ? void loadDirectory(entry.path) : entry.type === 'file' ? void openFile(entry.path) : undefined}><span>{entry.type === 'directory' ? '▸' : '·'}</span><strong>{entry.name}</strong><small>{entry.type === 'file' ? formatBytes(entry.size) : ''}</small></button>)}</>}
    </div>}
    {tab === 'git' && <div className="workbench-content git-view"><div className="git-heading"><strong>{git?.isGit ? `分支 · ${git.branch}` : 'Git 状态'}</strong><button onClick={() => void loadGit()}>刷新</button></div>{git?.isGit === false ? <p>这个项目目录不是 Git 仓库。</p> : <><div className="git-stage-tabs"><button className={!staged ? 'active' : ''} onClick={() => { setStaged(false); void loadDiff(undefined, false) }}>未暂存</button><button className={staged ? 'active' : ''} onClick={() => { setStaged(true); void loadDiff(undefined, true) }}>已暂存</button></div>{git?.entries?.length ? git.entries.map(entry => <button className="git-file" key={`${entry.index}${entry.worktree}${entry.path}`} onClick={() => void loadDiff(entry.path, staged)}><span>{entry.index !== ' ' ? entry.index : entry.worktree}</span>{entry.path}</button>) : <p>工作区干净，没有文件变更。</p>}{diff && <pre className="git-diff">{diff}</pre>}</>}</div>}
    {tab === 'preview' && <div className="workbench-content preview-view"><div className="preview-controls"><input value={previewInput} disabled={!localAdmin} onChange={event => setPreviewInput(event.target.value)} placeholder="http://127.0.0.1:5173"/>{localAdmin && <button disabled={busy} onClick={() => void savePreview()}>登记</button>}<button disabled={busy || !project.previewUrl} onClick={() => void refreshPreview()}>刷新</button></div>{!project.previewUrl ? <p>{localAdmin ? '登记本机项目开发服务器后即可预览。Pulse 不会自动运行项目脚本。' : '此项目尚未登记预览服务。'}</p> : previewUrl ? <iframe title={`${project.name} 预览`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={previewUrl}/> : <p>使用受限预览代理；页面不能读取 Pulse 会话或设置。</p>}</div>}
    {tab === 'terminal' && <div className="workbench-content terminal-view">{canUseTerminal ? <>
      <div className="terminal-tabs">{terminals.map((terminal, index) => <div className={`terminal-tab ${activeTerminalId === terminal.id ? 'active' : ''}`} key={terminal.id}><button onClick={() => setActiveTerminalId(terminal.id)} title={`终端 ${index + 1}`}>终端 {index + 1}{terminal.exited ? ` · 已退出 ${terminal.exited.code}` : ''}</button><button aria-label={`关闭终端 ${index + 1}`} disabled={busy} onClick={() => void closeTerminal(terminal)}>×</button></div>)}<button className="terminal-new" disabled={busy || terminals.length >= 3} onClick={() => void createTerminal()}>＋ 新终端</button></div>
      {terminals.length === 0 ? <div className="terminal-empty"><strong>交互终端</strong><p>终端绑定到“{project.name}”的目录，与聊天任务和审批事件隔离。</p><button disabled={busy} onClick={() => void createTerminal()}>打开终端</button></div> : <div className="terminal-stages"><Suspense fallback={<p>正在加载终端…</p>}>{terminals.map(terminal => <div className="terminal-stage" key={terminal.id} hidden={activeTerminalId !== terminal.id}><TerminalConsole terminalId={terminal.id} transport={transport} active={activeTerminalId === terminal.id} /></div>)}</Suspense></div>}
    </> : <p>交互终端仅限本机管理浏览器使用。</p>}</div>}
  </aside>
}

function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function workspaceError(error: unknown, fallback: string): string { return error instanceof ApiError && error.status === 403 ? '路径不在项目目录中，已阻止访问。' : error instanceof ApiError && error.status === 404 ? '文件或项目不存在。' : fallback }
