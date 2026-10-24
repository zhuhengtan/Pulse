import './workspace.css'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { NativeBrowserPanel } from './NativeBrowserPanel.js'
import { describeAutomationError } from './AutomationPanel.js'
import type { BrowserController, BrowserWorkspaceState } from './AutomationPanel.js'
import { browserAddress } from './browserAddress.js'
import { DiffPreview } from './DiffPreview.js'
import { FilePreview } from './FilePreview.js'
import { Icon } from './Icon.js'
import { PulseButton, PulseInput } from './PulseControls.js'
import { apiJson, jsonRequest } from './transport.js'
import type { PulseWebTransport, WebProject } from './transport.js'
import { previewKey, readPreviewState, savePreviewState } from './previewState.js'
import type { PreviewTarget } from './previewState.js'
import { safeRelativePath } from './routing.js'
import type { QueryPatch } from './routing.js'
const WorkbenchPanel = lazy(() => import('./WorkbenchPanel.js').then(module => ({ default: module.WorkbenchPanel })))
const tools = [{ tool: 'git', label: '变更', icon: 'edit' }, { tool: 'files', label: '文件', icon: 'folder' }, { tool: 'terminal', label: '终端', icon: 'terminal' }, { tool: 'automation', label: '自动化', icon: 'tool' }] as const
function title(target: PreviewTarget) {
  return target.kind === 'start' ? '新标签页' : target.kind === 'tool' ? tools.find(item => item.tool === target.tool)!.label : target.kind === 'browser' ? '浏览器' : `${target.path.split('/').at(-1)}${target.kind === 'diff' ? ' · Diff' : ''}`
}
const newPage = (): PreviewTarget => ({ kind: 'start', id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` })

/** A sibling of chat, with one tab strip for documents, tools and browser pages. */
export function PreviewDock({ scope, projectId, project, conversationId, transport, localAdmin, canUseTerminal = false, position, onNavigate, onClose }: { scope: string; projectId?: string | undefined; project?: WebProject | undefined; conversationId?: string | undefined; transport: PulseWebTransport; localAdmin: boolean; canUseTerminal?: boolean; position?: URLSearchParams | undefined; onNavigate?: ((patch: QueryPatch, replace?: boolean) => void) | undefined; onClose?: (() => void) | undefined }) {
  const nativeBrowser = window.pulseDesktop?.nativeBrowser === true
  const tabBar = useRef<HTMLDivElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const initial = useRef(readPreviewState(scope))
  const [tabs, setTabs] = useState<PreviewTarget[]>(() => initial.current.tabs.filter(item => nativeBrowser || item.kind !== 'browser' && !(item.kind === 'tool' && item.tool === 'automation')).length ? initial.current.tabs.filter(item => nativeBrowser || item.kind !== 'browser' && !(item.kind === 'tool' && item.tool === 'automation')) : [newPage()])
  const [active, setActive] = useState(() => initial.current.active ?? previewKey(tabs[0]!))
  const [browserStates, setBrowserStates] = useState<Record<string, BrowserWorkspaceState>>({})
  const [closing, setClosing] = useState<string[]>([])
  const tabsRef = useRef(tabs); tabsRef.current = tabs
  const controllers = useRef<Record<string, BrowserController | null>>({})
  const leases = useRef<Record<string, string>>({}) // Control leases stay in memory only.
  const openEpoch = useRef(0)
  const [address, setAddress] = useState(''), [error, setError] = useState(''), [opening, setOpening] = useState(false)
  const [width, setWidth] = useState(() => { const stored = Number(localStorage.getItem('pulse-workspace-window-width')); return Number.isFinite(stored) && stored >= 360 ? Math.min(stored, window.innerWidth * .65) : 0 })
  const resizeCleanup = useRef<(() => void) | undefined>(undefined)
  const incomingPath = position?.get('artifact') ?? position?.get('file'), incomingRun = position?.get('artifactRun'), incomingSession = position?.get('automation'), incomingDiff = position?.get('diff'), staged = position?.get('staged') === '1', incomingTool = position?.get('workspace')
  const select = useCallback((target: PreviewTarget) => {
    const key = previewKey(target)
    setTabs(items => items.some(item => previewKey(item) === key) ? items : [...(items.length === 1 && items[0]?.kind === 'start' && target.kind !== 'start' ? [] : items), target].slice(-30)); setActive(key); setError('')
  }, [])
  const current = tabs.find(item => previewKey(item) === active) ?? tabs[0]
  useEffect(() => {
    if (incomingDiff && safeRelativePath(incomingDiff) && (conversationId || projectId)) select({ kind: 'diff', path: incomingDiff, ...(conversationId ? { conversationId } : { projectId: projectId! }), staged })
    else if (incomingPath && safeRelativePath(incomingPath)) {
      if (incomingRun && conversationId) select({ kind: 'file', path: incomingPath, conversationId, runId: incomingRun })
      else if (projectId) select({ kind: 'file', path: incomingPath, projectId })
    } else if (nativeBrowser && incomingSession && incomingTool !== 'automation') select({ kind: 'browser', sessionId: incomingSession })
    else if (['files', 'git', 'terminal'].includes(incomingTool ?? '')) select({ kind: 'tool', tool: incomingTool as Extract<PreviewTarget, { kind: 'tool' }>['tool'] })
  }, [incomingPath, incomingRun, incomingSession, incomingDiff, staged, projectId, conversationId, incomingTool, select])
  useEffect(() => { savePreviewState(scope, tabs, active) }, [scope, tabs, active])
  const browserPage = current?.kind === 'browser' ? browserStates[current.sessionId]?.session?.tabs?.items.find(item => item.active)?.index : undefined
  useEffect(() => { tabBar.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); if (current?.kind === 'start') addressInput.current?.focus() }, [active, browserPage])
  useEffect(() => () => { resizeCleanup.current?.(); openEpoch.current++ }, [])
  const clearRoute = () => onNavigate?.({ workspace: 'preview', artifact: undefined, artifactRun: undefined, file: undefined, automation: undefined, diff: undefined, staged: undefined }, true)
  function removeTabs(keys: string[]) {
    const remaining = tabsRef.current.filter(item => !keys.includes(previewKey(item)))
    savePreviewState(scope, remaining, remaining.length ? previewKey(remaining.at(-1)!) : undefined)
    setTabs(remaining)
    if (!remaining.length) {
      setActive('')
      if (onClose) onClose()
      else onNavigate?.({ workspace: undefined, automation: undefined, artifact: undefined, artifactRun: undefined, file: undefined, diff: undefined, staged: undefined, previewHidden: '1' }, true)
      return
    }
    setActive(value => keys.includes(value) ? previewKey(remaining.at(-1)!) : value)
    clearRoute()
  }
  async function closeTargets(targets: PreviewTarget[]) {
    const keys = targets.map(previewKey)
    if (keys.some(key => closing.includes(key))) return
    if (targets.some(target => target.kind === 'start')) openEpoch.current++
    setClosing(items => [...items, ...keys]); setError('')
    try {
      await Promise.all(targets.filter((target): target is Extract<PreviewTarget, { kind: 'browser' }> => target.kind === 'browser' && browserStates[target.sessionId]?.session?.state !== 'closed').map(target => apiJson(transport, `/api/automation/sessions/${target.sessionId}/control`, jsonRequest('POST', { action: 'close' })).catch(reason => { if (!(reason instanceof Error && reason.message.includes('AUTOMATION_SESSION_NOT_FOUND'))) throw reason }).then(() => window.pulseDesktop?.browserDispose?.(target.sessionId))))
      removeTabs(keys)
    } catch (reason) { setError(describeAutomationError(reason)) }
    finally { setClosing(items => items.filter(key => !keys.includes(key))) }
  }
  const close = (target: PreviewTarget) => { void closeTargets([target]) }
  const startPage = () => { select(newPage()); clearRoute(); setAddress('') }
  const openTool = (tool: Extract<PreviewTarget, { kind: 'tool' }>['tool']) => { select({ kind: 'tool', tool }); clearRoute() }
  async function openBrowser(value: string) {
    if (!nativeBrowser) throw new Error('请在 Electron 客户端中打开内置浏览器。')
    if (opening) return
    const epoch = ++openEpoch.current
    let createdSession: string | undefined
    setOpening(true); setError('')
    try {
      const url = browserAddress(value)
      const existing = tabs.find((item): item is Extract<PreviewTarget, { kind: 'browser' }> => item.kind === 'browser' && Boolean(item.sessionId))
      const sessions = await apiJson<{ sessions: Array<{ id: string; state: string }>; enabled: string[]; approvalMode: string; manualBrowser?: boolean; nativeBrowser?: boolean }>(transport, '/api/automation/sessions')
      if (epoch !== openEpoch.current) return
      if (sessions.approvalMode === 'read-only') throw new Error('当前为只读模式，无法打开浏览器。')
      if (!sessions.nativeBrowser || !sessions.manualBrowser) throw new Error('当前后台尚未连接原生浏览器，请更新并重启开发后台及 Electron 后重试。')
      const reusable = sessions.sessions.find(item => item.id === existing?.sessionId && item.state !== 'closed')
      const session = reusable ?? await apiJson<{ id: string; state: string }>(transport, '/api/automation/sessions', jsonRequest('POST', { projectId, conversationId, kind: 'browser', manual: true }))
      if (!reusable) createdSession = session.id
      if (epoch !== openEpoch.current) throw new Error('BROWSER_OPEN_CANCELLED')
      if (session.state === 'ai') throw new Error('AI 正在操作浏览器，请先切换到浏览器标签并接管。')
      const control = await apiJson<{ lease: string }>(transport, `/api/automation/sessions/${session.id}/control`, jsonRequest('POST', { action: 'takeover' }))
      leases.current[session.id] = control.lease
      await apiJson(transport, `/api/automation/sessions/${session.id}/command`, jsonRequest('POST', { lease: control.lease, method: existing && session.id === existing.sessionId ? 'newTab' : 'navigate', params: { url } }))
      if (epoch !== openEpoch.current) throw new Error('BROWSER_OPEN_CANCELLED')
      createdSession = undefined
      // Replace the launcher, keeping existing document and tool tabs in place.
      if (current?.kind === 'start') setTabs(items => items.filter(item => previewKey(item) !== previewKey(current)))
      select({ kind: 'browser', sessionId: session.id }); clearRoute(); setAddress('')
    } catch (reason) {
      if (createdSession) await apiJson(transport, `/api/automation/sessions/${createdSession}/control`, jsonRequest('POST', { action: 'close' })).catch(() => {})
      if (epoch !== openEpoch.current) return
      setError(reason instanceof Error && (reason.message.startsWith('请') || reason.message.startsWith('AI ') || reason.message.startsWith('当前')) ? reason.message : describeAutomationError(reason))
      throw reason
    } finally { setOpening(false) }
  }
  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault(); resizeCleanup.current?.()
    const move = (next: PointerEvent) => { const value = Math.max(360, Math.min(window.innerWidth * .65, window.innerWidth - next.clientX)); setWidth(value); localStorage.setItem('pulse-workspace-window-width', String(value)) }
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); resizeCleanup.current = undefined }
    resizeCleanup.current = end; window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true })
  }
  const recordBrowser = useCallback((id: string, state: BrowserWorkspaceState) => setBrowserStates(values => ({ ...values, [id]: state })), [])
  useEffect(() => {
    const closed = tabs.filter(target => target.kind === 'browser' && browserStates[target.sessionId]?.session?.state === 'closed').map(previewKey)
    if (closed.length) removeTabs(closed)
  }, [browserStates])
  const toolPosition = new URLSearchParams(position)
  // A restored tool tab must render its content even after the route is cleared.
  if (current?.kind === 'tool') toolPosition.set('workspace', current.tool)
  if (!tabs.length) return null
  return <aside className="workspace-window" aria-label="标签页" style={width ? { '--workspace-window-width': `${width}px` } as CSSProperties : undefined}>
    <PulseButton className="workspace-divider" onPointerDown={beginResize} aria-label="调整标签页面板宽度" />
    <header className="workspace-titlebar">
      <div ref={tabBar} className="workspace-tabs" role="tablist" aria-label="标签页">{tabs.map(target => {
        const key = previewKey(target), browser = target.kind === 'browser' ? browserStates[target.sessionId] : undefined
        const pages = browser?.session?.tabs?.items
        if (target.kind === 'browser' && pages?.length) return pages.map(page => <div className={`workspace-tab ${active === key && page.active ? 'active' : ''}`} key={`${key}:${page.index}`}><PulseButton role="tab" aria-selected={active === key && page.active} title={page.url} onClick={() => { setActive(key); clearRoute(); if (!page.active) controllers.current[target.sessionId]?.selectTab(page.index, browser!.session!.tabs!.revision) }}><Icon name="web" size={15}/><span>{page.title || '新标签页'}</span></PulseButton><PulseButton aria-label={`关闭网页 ${page.title || '新标签页'}`} disabled={!browser?.canControl || browser.busy || closing.includes(key)} onClick={() => pages.length === 1 ? close(target) : controllers.current[target.sessionId]?.closeTab(page.index, browser!.session!.tabs!.revision)}><Icon name="close" size={12}/></PulseButton></div>)
        return <div className={`workspace-tab ${active === key ? 'active' : ''}`} key={key}><PulseButton role="tab" aria-selected={active === key} onClick={() => { setActive(key); clearRoute() }} title={target.kind === 'file' || target.kind === 'diff' ? target.path : title(target)}><Icon name={target.kind === 'start' || target.kind === 'browser' ? 'web' : target.kind === 'diff' ? 'edit' : target.kind === 'tool' ? tools.find(item => item.tool === target.tool)!.icon : 'file'} size={15}/><span>{target.kind === 'browser' ? browser?.session?.title || title(target) : title(target)}</span></PulseButton><PulseButton aria-label={`关闭 ${target.kind === 'file' || target.kind === 'diff' ? target.path : title(target)} 标签`} onClick={() => close(target)}><Icon name="close" size={12}/></PulseButton></div>
      })}</div><PulseButton className="workspace-new-tab" title="新建标签页" aria-label="新建标签页" onClick={startPage}><Icon name="plus" size={17}/></PulseButton>
      {onClose && <PulseButton className="workspace-close" aria-label="关闭全部标签页" title="关闭全部标签页" disabled={closing.length > 0} onClick={() => void closeTargets(tabs)}><Icon name="close" size={16}/></PulseButton>}
    </header>
    {error && <p className="workspace-error" role="alert">{error}</p>}
    <div className="workspace-window-content">
      {current?.kind === 'start' && <div className="workspace-start">
        {nativeBrowser && <form className="workspace-addressbar" onSubmit={event => { event.preventDefault(); void openBrowser(address).catch(() => {}) }}><PulseButton type="button" aria-label="后退" disabled><Icon name="back" size={16}/></PulseButton><PulseButton type="button" aria-label="刷新网页" disabled><Icon name="reload" size={16}/></PulseButton><div className="workspace-url"><Icon name="search" size={15}/><PulseInput ref={addressInput} aria-label="浏览器地址" value={address} onChange={event => setAddress(event.target.value)} placeholder="输入网址" /></div><PulseButton type="submit" disabled={opening || !address.trim()} aria-label="前往"><Icon name="chevron" size={15}/></PulseButton></form>}
        <div className="workspace-launcher"><h2>工具</h2><div className="workspace-tool-grid">{tools.filter(item => item.tool !== 'automation').map(item => <PulseButton key={item.tool} onClick={() => openTool(item.tool)}><Icon name={item.icon} size={18}/><span>{item.label}</span><Icon name="chevron" size={12}/></PulseButton>)}{nativeBrowser && <PulseButton onClick={() => addressInput.current?.focus()}><Icon name="web" size={18}/><span>打开浏览器</span><Icon name="chevron" size={12}/></PulseButton>}</div>{nativeBrowser && project?.previewUrl && <><h2>项目</h2><PulseButton className="workspace-project-link" onClick={() => void openBrowser(project.previewUrl!).catch(() => {})}><Icon name="web"/><span>{project.name}<small>{project.previewUrl}</small></span></PulseButton></>}</div>
      </div>}
      {current?.kind === 'diff' && <DiffPreview key={previewKey(current)} target={current} transport={transport} />}
      {current?.kind === 'file' && <FilePreview key={previewKey(current)} target={current} transport={transport} onBrowser={nativeBrowser ? openBrowser : undefined} />}
      {current?.kind === 'tool' && <Suspense fallback={<p className="preview-empty">正在打开…</p>}><WorkbenchPanel embedded project={project} conversationId={conversationId} transport={transport} localAdmin={localAdmin} canUseTerminal={canUseTerminal} tab={current.tool} setTab={value => { if (value !== 'preview') openTool(value) }} onClose={() => close(current)} position={toolPosition} onNavigate={onNavigate} /></Suspense>}
      {tabs.filter((item): item is Extract<PreviewTarget, { kind: 'browser' }> => nativeBrowser && item.kind === 'browser' && !closing.includes(previewKey(item))).map(target => <div className="workspace-browser-stage" key={target.sessionId} hidden={active !== previewKey(target)}><NativeBrowserPanel transport={transport} selectedSession={target.sessionId} active={active === previewKey(target)} initialLease={leases.current[target.sessionId]} controllerRef={value => { controllers.current[target.sessionId] = value }} onBrowserState={state => recordBrowser(target.sessionId, state)} /></div>)}
    </div>
  </aside>
}
