import { DiffViewer } from './DiffViewer.js'
import { PulseButton, PulseInput, usePulseDialogs } from './PulseControls.js'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ApiError, apiJson, jsonRequest } from './transport.js'
import type { PulseWebTransport, WebProject } from './transport.js'
import { AutomationPanel } from './AutomationPanel.js'
import { Breadcrumb, Segmented, Tabs, Tree } from 'antd'
import { Icon } from './Icon.js'
import type { QueryPatch } from './routing.js'
const TerminalConsole = lazy(() => import('./TerminalConsole.js').then(module => ({ default: module.TerminalConsole })))

interface FileEntry { name: string; path: string; type: 'directory' | 'file' | 'other'; size: number; modifiedAt: string }
interface DirectoryResult { path: string; entries: FileEntry[] }
interface FileResult { path: string; binary: boolean; size: number; offset?: number; totalLines?: number; content?: string }
interface GitStatus { isGit: boolean; branch?: string; entries?: Array<{ index: string; worktree: string; path: string }> }
interface TerminalInfo { id: string; projectId: string; exited?: { code: number } }

export function WorkbenchPanel({ project, conversationId, transport, localAdmin, canUseTerminal, tab, setTab, onClose, position, onNavigate, embedded = false }: { project?: WebProject | undefined; conversationId?: string | undefined; transport: PulseWebTransport; localAdmin: boolean; canUseTerminal: boolean; tab: 'files' | 'git' | 'preview' | 'terminal' | 'automation'; setTab: (tab: 'files' | 'git' | 'preview' | 'terminal' | 'automation') => void; onClose: () => void; position?: URLSearchParams; onNavigate?: ((patch: QueryPatch, replace?: boolean) => void) | undefined; embedded?: boolean }) {
  const dialogs = usePulseDialogs()
  const widthKey = `pulse-web-workbench-width:${conversationId ?? project?.id ?? 'default'}`
  const [panelWidth, setPanelWidth] = useState(() => Number(window.localStorage.getItem(widthKey) ?? window.localStorage.getItem('pulse-web-workbench-width')) || 410)
  const [panelHeight, setPanelHeight] = useState(() => Number(window.localStorage.getItem('pulse-web-terminal-height')) || 340)
  const resizeCleanup = useRef<(() => void) | undefined>(undefined)
  const [localPath, setPath] = useState('.')
  const path = position ? position.get('path') ?? '.' : localPath
  const [directory, setDirectory] = useState<DirectoryResult>()
  const [file, setFile] = useState<FileResult>()
  const [fileOffset, setFileOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ path: string; line: number; text: string }>>([])
  const [git, setGit] = useState<GitStatus>()
  const [diff, setDiff] = useState('')
  const [localStaged, setStaged] = useState(false)
  const staged = position ? position.get('staged') === '1' : localStaged
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [localTerminalId, setActiveTerminalId] = useState<string>()
  const activeTerminalId = position?.get('terminal') ?? localTerminalId
  const terminalSelection = useRef(activeTerminalId); terminalSelection.current = activeTerminalId
  const fileRequest = useRef(0), gitRequest = useRef(0), diffRequest = useRef(0)
  const selectTerminal = (id?: string) => { if (onNavigate) onNavigate({ terminal: id }); else setActiveTerminalId(id) }

  useEffect(() => { window.localStorage.setItem(widthKey, String(panelWidth)) }, [panelWidth, widthKey])
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
  const loadDirectory = async (nextPath = '.', navigate = true) => {
    if (!project) return
    if (onNavigate && navigate) { onNavigate({ path: nextPath === '.' ? undefined : nextPath, file: undefined, offset: undefined }); return }
    const request = ++fileRequest.current
    setBusy(true); setError(''); setFile(undefined); setPath(nextPath)
    try { const value = await apiJson<DirectoryResult>(transport, `${projectApi}/files?path=${encodeURIComponent(nextPath)}`); if (request === fileRequest.current) setDirectory(value) }
    catch (reason) { if (request === fileRequest.current) setError(workspaceError(reason, '目录无法读取。')) }
    finally { if (request === fileRequest.current) setBusy(false) }
  }
  const openFile = async (filePath: string, offset = 0, navigate = true) => {
    if (!project) return
    if (onNavigate && navigate) { const parent = filePath.split('/').slice(0, -1).join('/'); onNavigate({ workspace: 'preview', diff: undefined, path: parent || undefined, file: filePath, artifact: undefined, artifactRun: undefined, automation: undefined, offset: offset || undefined }); return }
    const request = ++fileRequest.current
    setFile(undefined)
    setBusy(true); setError(''); setFileOffset(offset)
    try { const value = await apiJson<FileResult>(transport, `${projectApi}/file?path=${encodeURIComponent(filePath)}&offset=${offset}&limit=1000`); if (request === fileRequest.current) setFile(value) }
    catch (reason) { if (request === fileRequest.current) setError(workspaceError(reason, '文件无法读取。')) }
    finally { if (request === fileRequest.current) setBusy(false) }
  }
  const loadGit = async () => {
    if (!project) return
    setBusy(true); setError('')
    const request = ++gitRequest.current
    try { const value = await apiJson<GitStatus>(transport, `${projectApi}/git/status`); if (request === gitRequest.current) { setGit(value); if (!position?.get('diff')) setDiff('') } }
    catch (reason) { if (request === gitRequest.current) setError(workspaceError(reason, 'Git 状态无法读取。')) }
    finally { if (request === gitRequest.current) setBusy(false) }
  }
  const loadDiff = async (filePath?: string, useStaged = staged, navigate = true) => {
    if (!project) return
    if (onNavigate && navigate) { onNavigate({ diff: filePath, staged: useStaged }); return }
    const request = ++diffRequest.current
    setDiff('')
    setBusy(true); setError('')
    try { const value = await apiJson<{ diff: string }>(transport, `${projectApi}/git/diff?staged=${useStaged ? 1 : 0}${filePath ? `&path=${encodeURIComponent(filePath)}` : ''}`); if (request === diffRequest.current) setDiff(value.diff) }
    catch (reason) { if (request === diffRequest.current) setError(workspaceError(reason, 'Git 差异无法读取。')) }
    finally { if (request === diffRequest.current) setBusy(false) }
  }

  useEffect(() => { setPath('.'); setFile(undefined); setDirectory(undefined); setGit(undefined); setTerminals([]); setActiveTerminalId(undefined); if (project && !position) void loadDirectory('.', false); return () => { fileRequest.current++; gitRequest.current++; diffRequest.current++ } }, [project?.id])
  const routePath = position?.get('path') ?? '.', routeFile = position?.get('file'), routeOffset = Number(position?.get('offset') ?? 0), routeDiff = position?.get('diff')
  useEffect(() => {
    if (!position || tab !== 'files' || !project) return
    if (routeFile) void openFile(routeFile, routeOffset, false)
    else void loadDirectory(routePath, false)
    return () => { fileRequest.current++ }
  }, [project?.id, tab, routePath, routeFile, routeOffset])
  useEffect(() => { if (!position) return; if (tab === 'git' && routeDiff) void loadDiff(routeDiff, staged, false); else if (position) setDiff(''); return () => { diffRequest.current++ } }, [project?.id, tab, routeDiff, staged])
  useEffect(() => { if (tab === 'git') void loadGit() }, [tab, project?.id])
  useEffect(() => { if (tab === 'terminal') void loadTerminals() }, [tab, project?.id, canUseTerminal])

  const runSearch = async () => {
    if (!project || !search.trim()) return
    setBusy(true); setError('')
    try { const value = await apiJson<{ matches: Array<{ path: string; line: number; text: string }> }>(transport, `${projectApi}/search?q=${encodeURIComponent(search.trim())}`); setSearchResults(value.matches) }
    catch (reason) { setError(workspaceError(reason, '搜索失败。')) }
    finally { setBusy(false) }
  }
  const loadTerminals = async () => {
    if (!project || !canUseTerminal) return
    try {
      const value = await apiJson<TerminalInfo[]>(transport, `/api/terminals?projectId=${encodeURIComponent(project.id)}`)
      setTerminals(value)
      const requested = terminalSelection.current
      if (requested && !value.some(item => item.id === requested)) { setError('这个终端已关闭或不属于当前项目。'); return }
      const next = requested ?? value[0]?.id
      setActiveTerminalId(next)
      if (next && onNavigate && !position?.has('terminal')) onNavigate({ terminal: next }, true)
    } catch { setTerminals([]); setActiveTerminalId(undefined) }
  }
  const createTerminal = async () => {
    if (!project || !canUseTerminal) return
    setBusy(true); setError('')
    try {
      const terminal = await apiJson<TerminalInfo>(transport, '/api/terminals', jsonRequest('POST', { projectId: project.id }))
      setTerminals(items => [...items, terminal]); selectTerminal(terminal.id)
    } catch (reason) { setError(reason instanceof ApiError ? reason.status === 429 ? '终端数量已达上限，请先关闭不再使用的终端。' : reason.status === 401 || reason.status === 403 ? '终端需要本机管理会话，请刷新页面重新授权。' : reason.status === 404 ? '项目目录当前不可用，请检查项目路径。' : reason.status === 501 ? '本机终端原生组件未就绪，请修复 node-pty 后重试。' : '终端无法启动，请稍后重试并检查服务日志。' : '终端连接失败，请检查开发服务器的连接。') }
    finally { setBusy(false) }
  }
  const closeTerminal = async (terminal: TerminalInfo) => {
    if (!await dialogs.confirm('关闭这个终端会结束它启动的进程，确定继续吗？')) return
    setBusy(true); setError('')
    try {
      await apiJson<{ ok: boolean }>(transport, `/api/terminals/${encodeURIComponent(terminal.id)}`, { method: 'DELETE' })
      setTerminals(items => items.filter(item => item.id !== terminal.id))
      if (activeTerminalId === terminal.id) selectTerminal(terminals.find(item => item.id !== terminal.id)?.id)
    } catch { setError('终端关闭失败。') }
    finally { setBusy(false) }
  }

  if (!project && tab !== 'automation') return <div className="workbench-empty"><Icon name="folder" size={30}/><strong>选择一个项目</strong><span>选择项目后查看文件、变更和终端。</span></div>

  const parentPath = path === '.' ? undefined : path.split('/').slice(0, -1).join('/') || '.'
  const visibleGitEntries = (git?.entries ?? []).filter(entry => staged ? entry.index !== ' ' && entry.index !== '?' : entry.worktree !== ' ')
  const crumbs = path === '.' ? [] : path.split('/').filter(Boolean)
  const content = <>
    {project && !project.available && <p className="workbench-alert">这个目录当前不可用；历史聊天和记录仍保留。</p>}
    {error && <p className="workbench-alert" role="alert">{error}</p>}
    {tab === 'automation' && <AutomationPanel transport={transport} projectId={project?.id} localAdmin={localAdmin} selectedSession={position?.get('automation') ?? undefined} onSelectSession={onNavigate ? (automation, replace) => onNavigate({ automation }, replace) : undefined} />}
    {tab === 'files' && <div className="workbench-content">
      <form className="file-search" onSubmit={event => { event.preventDefault(); void runSearch() }}><PulseInput value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索项目文件"/><PulseButton disabled={busy || !search.trim()}>搜索</PulseButton></form>
      {searchResults.length > 0 && <div className="search-results">{searchResults.map((result, index) => <PulseButton key={`${result.path}-${result.line}-${index}`} onClick={() => { void openFile(result.path); setSearchResults([]) }}><strong>{result.path}:{result.line}</strong><span>{result.text}</span></PulseButton>)}</div>}
      {file ? <section className="file-view"><header><PulseButton onClick={() => { if (onNavigate) onNavigate({ file: undefined, offset: undefined }); else setFile(undefined) }}>← 文件列表</PulseButton><strong title={file.path}>{file.path}</strong><PulseButton onClick={() => void navigator.clipboard?.writeText(file.content ?? '')}>复制</PulseButton></header>{file.binary ? <p>这是二进制文件，暂不支持预览（{formatBytes(file.size)}）。</p> : <><pre><code>{file.content}</code></pre>{(fileOffset > 0 || (file.totalLines ?? 0) > fileOffset + 1000) && <footer><PulseButton disabled={fileOffset <= 0} onClick={() => void openFile(file.path, Math.max(0, fileOffset - 1000))}>上一页</PulseButton><span>{fileOffset + 1}–{Math.min(fileOffset + 1000, file.totalLines ?? fileOffset + 1000)} / {file.totalLines}</span><PulseButton disabled={fileOffset + 1000 >= (file.totalLines ?? 0)} onClick={() => void openFile(file.path, fileOffset + 1000)}>下一页</PulseButton></footer>}</>}</section> : <><Breadcrumb className="file-breadcrumb path-breadcrumb" items={[{ title: <PulseButton onClick={() => void loadDirectory('.')}>项目</PulseButton> }, ...crumbs.map((crumb, index) => ({ title: <PulseButton onClick={() => void loadDirectory(crumbs.slice(0, index + 1).join('/'))}>{crumb}</PulseButton> }))]} />{parentPath && <PulseButton className="file-entry parent" onClick={() => void loadDirectory(parentPath)}>↑ 上一级</PulseButton>}{busy && !directory ? <p>正在读取文件…</p> : <Tree.DirectoryTree className="workspace-file-tree" blockNode showIcon expandAction={false} selectedKeys={[]} treeData={(directory?.entries ?? []).map(entry => ({ key: entry.path, isLeaf: true, icon: <Icon name={entry.type === 'directory' ? 'folder' : 'file'} />, title: <span className="workspace-file-title"><strong>{entry.name}</strong><small>{entry.type === 'file' ? formatBytes(entry.size) : ''}</small></span>, disabled: entry.type === 'other' }))} onSelect={keys => { const entry = directory?.entries.find(item => item.path === keys[0]); if (entry?.type === 'directory') void loadDirectory(entry.path); else if (entry?.type === 'file') void openFile(entry.path) }} />}</>}
    </div>}
    {tab === 'git' && <div className="workbench-content git-view"><div className="git-heading"><strong>{git?.isGit ? `分支 · ${git.branch}` : 'Git 状态'}</strong><PulseButton onClick={() => void loadGit()}>刷新</PulseButton></div>{git?.isGit === false ? <p>这个项目目录不是 Git 仓库。</p> : <><Segmented className="git-stage-tabs" value={staged ? 'staged' : 'unstaged'} options={[{ value: 'unstaged', label: '未暂存' }, { value: 'staged', label: '已暂存' }]} onChange={value => { const next = value === 'staged'; setStaged(next); void loadDiff(undefined, next) }} />{visibleGitEntries.length ? visibleGitEntries.map(entry => <PulseButton className="git-file" key={`${entry.index}${entry.worktree}${entry.path}`} onClick={() => void loadDiff(entry.path, staged)}><span className="git-file-status">{staged ? entry.index : entry.worktree}</span><span className="git-file-path" title={entry.path}>{entry.path}</span></PulseButton>) : <p>{staged ? '没有已暂存的变更。' : '没有未暂存的变更。'}</p>}{diff && <DiffViewer text={diff} />}</>}</div>}
    {tab === 'terminal' && <div className="workbench-content terminal-view">{canUseTerminal ? <>
      <div className="terminal-tabs">{terminals.map((terminal, index) => <div className={`terminal-tab ${activeTerminalId === terminal.id ? 'active' : ''}`} key={terminal.id}><PulseButton onClick={() => selectTerminal(terminal.id)} title={`终端 ${index + 1}`}>终端 {index + 1}{terminal.exited ? ` · 已退出 ${terminal.exited.code}` : ''}</PulseButton><PulseButton aria-label={`关闭终端 ${index + 1}`} disabled={busy} onClick={() => void closeTerminal(terminal)}>×</PulseButton></div>)}<PulseButton className="terminal-new" disabled={busy || terminals.length >= 3} onClick={() => void createTerminal()}>＋ 新终端</PulseButton></div>
      {terminals.length === 0 ? <div className="terminal-empty"><strong>交互终端</strong><p>终端绑定到“{project?.name}”的目录，与聊天任务和审批事件隔离。</p><PulseButton disabled={busy} onClick={() => void createTerminal()}>打开终端</PulseButton></div> : <div className="terminal-stages"><Suspense fallback={<p>正在加载终端…</p>}>{terminals.map(terminal => <div className="terminal-stage" key={terminal.id} hidden={activeTerminalId !== terminal.id}><TerminalConsole terminalId={terminal.id} transport={transport} active={activeTerminalId === terminal.id} /></div>)}</Suspense></div>}
    </> : <p>交互终端仅限本机管理浏览器使用。</p>}</div>}
  </>
  if (embedded) return <section className="workspace-tool-content">{content}</section>
  return <aside className={`workbench-panel ${tab === 'terminal' ? 'terminal-dock' : ''}`} style={{ '--workbench-width': `${panelWidth}px`, '--workbench-height': `${panelHeight}px` } as CSSProperties} aria-label="工作区面板">
    <PulseButton className="workbench-resize" onPointerDown={beginResize} aria-label={tab === 'terminal' ? '调整终端高度' : '调整工作区宽度'} />
    <header className="workbench-header"><div><strong>{project?.name ?? '工作区'}</strong><small>{project?.cwd}</small></div><PulseButton className="icon-button" onClick={onClose} aria-label="关闭工作区"><Icon name="close"/></PulseButton></header>
    <Tabs className="workbench-tabs" activeKey={tab} onChange={value => setTab(value as typeof tab)} items={[{ key: 'files', label: '文件' }, { key: 'git', label: 'Git' }, { key: 'terminal', label: '终端' }, { key: 'automation', label: '自动化' }]} />
    {content}
  </aside>
}

function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function workspaceError(error: unknown, fallback: string): string { return error instanceof ApiError && error.status === 403 ? '路径不在项目目录中，已阻止访问。' : error instanceof ApiError && error.status === 404 ? '文件或项目不存在。' : fallback }
