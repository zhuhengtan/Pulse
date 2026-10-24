import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { NativeBrowserState } from './desktopTransport.js'
import type { AutomationSession, BrowserController, BrowserWorkspaceState } from './AutomationPanel.js'
import { describeAutomationError } from './AutomationPanel.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { browserAddress } from './browserAddress.js'
import { PulseButton, PulseInput } from './PulseControls.js'
import { Icon } from './Icon.js'

export function NativeBrowserPanel({ transport, selectedSession: id, active, initialLease, controllerRef, onBrowserState }: { transport: PulseWebTransport; selectedSession: string; active: boolean; initialLease?: string | undefined; controllerRef: Ref<BrowserController>; onBrowserState(state: BrowserWorkspaceState): void }) {
  const [session, setSession] = useState<AutomationSession>(), [native, setNative] = useState<NativeBrowserState>(), [lease, setLease] = useState(initialLease ?? ''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [url, setUrl] = useState(''), [readOnly, setReadOnly] = useState(false), [available, setAvailable] = useState(false)
  const host = window.pulseDesktop, base = `/api/automation/sessions/${encodeURIComponent(id)}`, viewport = useRef<HTMLDivElement>(null)
  const live = useRef(true), lock = useRef(false), report = useRef(onBrowserState); report.current = onBrowserState
  const canControl = Boolean(available && lease && session?.state === 'human' && !readOnly)
  async function load() {
    const result = await apiJson<{ sessions: AutomationSession[]; approvalMode: string; nativeBrowser?: boolean }>(transport, '/api/automation/sessions')
    if (!live.current) return
    setAvailable(result.nativeBrowser === true)
    if (!result.nativeBrowser) setError('当前后台尚未连接原生浏览器，请更新并重启开发后台及 Electron 后重试。')
    setSession(result.sessions.find(item => item.id === id)); setReadOnly(result.approvalMode === 'read-only')
  }
  useEffect(() => {
    live.current = true
    void load().catch(reason => setError(describeAutomationError(reason)))
    void host?.browserState?.(id).then(value => { if (live.current) setNative(value) })
    const off = host?.browserEvents?.(value => { if (value.id === id) setNative(value) })
    const timer = window.setInterval(() => void load().catch(() => {}), 1500)
    return () => { live.current = false; off?.(); window.clearInterval(timer); void host?.browserLayout?.(id, null) }
  }, [id, transport])
  useEffect(() => { setLease(initialLease ?? '') }, [id, initialLease])
  useEffect(() => { if (session && session.state !== 'human') setLease('') }, [session?.state])
  useEffect(() => {
    if (!lease) return
    const timer = window.setInterval(() => void apiJson(transport, `${base}/heartbeat`, jsonRequest('POST', { lease })).catch(() => setLease('')), 10000)
    return () => window.clearInterval(timer)
  }, [id, lease, transport])
  const page = native?.tabs.items.find(item => item.active)
  useEffect(() => { setUrl(page?.url === 'about:blank' ? '' : page?.url ?? '') }, [page?.url])
  useEffect(() => { report.current({ session: session ? { ...session, ...(native ? { tabs: native.tabs, ...(page ? { title: page.title, url: page.url } : {}) } : {}) } : undefined, canControl, busy }) }, [session, native, canControl, busy])
  useEffect(() => {
    let frame = 0, previous = ''
    const layout = () => {
      frame = 0
      const element = viewport.current, rect = element?.getBoundingClientRect()
      const overlay = [...document.querySelectorAll('[aria-modal="true"], .ant-dropdown:not(.ant-dropdown-hidden), .ant-popover:not(.ant-popover-hidden)')].some(node => node.getClientRects().length)
      const bounds = active && !overlay && element?.getClientRects().length && rect && rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      const serialized = JSON.stringify(bounds)
      if (serialized !== previous) { previous = serialized; void host?.browserLayout?.(id, bounds).catch(() => {}) }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(layout) }
    const observer = new ResizeObserver(schedule)
    if (viewport.current) observer.observe(viewport.current)
    const mutations = new MutationObserver(schedule); mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-modal', 'hidden'] })
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true); schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); void host?.browserLayout?.(id, null) }
  }, [id, active, Boolean(native), session?.state, error])
  async function run(operation: () => Promise<unknown>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation(); await load(); const value = await host?.browserState?.(id); if (live.current) setNative(value) }
    catch (reason) { if (live.current) setError(describeAutomationError(reason)) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  const command = (method: string, params: Record<string, unknown>) => run(() => apiJson(transport, `${base}/command`, jsonRequest('POST', { lease, method, params })))
  const control = (action: string) => run(async () => { const value = await apiJson<AutomationSession & { lease?: string }>(transport, `${base}/control`, jsonRequest('POST', { action })); setLease(value.lease ?? ''); setSession(value) })
  useImperativeHandle(controllerRef, () => ({ selectTab: (index, revision) => { if (canControl) void command('selectTab', { index, revision }) }, closeTab: (index, revision) => { if (canControl) void command('closeTab', { index, revision }) } }), [canControl, lease, id, transport])
  return <section className="native-browser-panel" aria-label="浏览器">
    <form className="workspace-addressbar" onSubmit={event => { event.preventDefault(); try { void command('navigate', { url: browserAddress(url) }) } catch (reason) { setError(String((reason as Error).message)) } }}>
      <PulseButton type="button" aria-label="后退" disabled={!canControl || busy} onClick={() => void command('back', {})}><Icon name="back" size={16}/></PulseButton>
      <PulseButton type="button" aria-label="刷新网页" disabled={!canControl || busy} onClick={() => void command('reload', {})}><Icon name="reload" size={16}/></PulseButton>
      <div className="workspace-url"><Icon name="web" size={15}/><PulseInput aria-label="浏览器地址" value={url} onChange={event => setUrl(event.target.value)} onFocus={event => event.target.select()} placeholder="输入网址" disabled={!canControl}/></div>
      <PulseButton type="submit" aria-label="前往" disabled={!canControl || busy}><Icon name="chevron" size={15}/></PulseButton>
      <PulseButton type="button" className="browser-ownership" disabled={!available || busy || readOnly || !session || session.state === 'closed'} onClick={() => void control(canControl ? 'resume' : 'takeover')}>{canControl ? '交还 AI' : '接管'}</PulseButton>
    </form>
    {session?.state === 'ai' && <div className="browser-control-notice" role="status"><i/>AI 正在浏览，接管后可操作网页</div>}
    {session?.reconnectRequired && <p role="status">本机后台已重新连接，请接管以恢复网页。</p>}
    {(error || native?.error) && <p className="workspace-error" role="alert">{error || describeAutomationError(native?.error)}</p>}
    <div ref={viewport} className="native-browser-viewport" aria-label="原生网页视口"/>
  </section>
}
