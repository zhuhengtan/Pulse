import { PulseButton, PulseCheckbox, PulseDisclosure, PulseInput, PulseTextArea, PulseToast, usePulseDialogs } from './PulseControls.js'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent, ReactElement } from 'react'
import { ApiError, apiJson, browserTransport, getWebConversation, jsonRequest } from './transport.js'
import { ConversationArtifacts } from './ConversationArtifacts.js'
import type { ConversationList, MessageList, PulseWebTransport, WebAttachment, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from './transport.js'
import { Drawer, Dropdown, Popover, Select } from 'antd'
import { MessageBubble } from './MessageBubble.js'
import { RichComposer, emptyComposerDraft, type ComposerDraft } from './RichComposer.js'
import { emptyTrace, isTraceEvent, PersistedRunTrace, reduceTrace, RunTraceView } from './RunTrace.js'
import type { TraceState } from './RunTrace.js'
import { copyText } from './clipboard.js'
import { SettingsPage } from './SettingsPage.js'
import { ArchivePage } from './ArchivePage.js'
import { Icon } from './Icon.js'
import { useBlocker } from 'react-router'
import { usePulseNavigation, workUrl, parsePulseRoute, type WorkspaceTab } from './routing.js'
const WorkbenchPanel = lazy(() => import('./WorkbenchPanel.js').then(module => ({ default: module.WorkbenchPanel })))

interface Device { id: string; name: string; createdAt: string; lastUsedAt: string }
type RunStatus =
  | { kind: 'status'; label: string }
  | { kind: 'review'; label: string }
  | { kind: 'tool'; activityId: string; label: string; state: string }
  | { kind: 'interaction'; runId: string; groupId: string; interactionKind: 'ask' | 'approval'; items: Array<{ effectId: string; input: Record<string, unknown> }>; conversationId?: string; conversationTitle?: string; projectId?: string; approvalPolicy?: 'manual' | 'delegate' }
  | { kind: 'lanes'; available: boolean; lanes: WebLane[] }
  | { kind: 'complete'; label: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' }

const historyStorageKey = 'pulse-web-conversation'

export function PulseApp({ transport = browserTransport }: { transport?: PulseWebTransport }) {
  const dialogs = usePulseDialogs()
  const { route, location, go, patchQuery, openPage, backToSource, backToSettings } = usePulseNavigation()
  const locationRef = useRef(location); locationRef.current = location
  const surfaceMode = route.page === 'work' ? 'work' : 'chat'
  const [settingsDirty, setSettingsDirty] = useState(false)
  const dialogRef = useRef(dialogs); dialogRef.current = dialogs
  const blocker = useBlocker(({ nextLocation }) => settingsDirty && route.page === 'settings' && parsePulseRoute(nextLocation.pathname, nextLocation.search).page !== 'settings')
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let active = true
    void dialogRef.current.confirm('放弃未保存修改并离开设置？').then(confirmed => { if (active) { if (confirmed) blocker.proceed(); else blocker.reset() } })
    return () => { active = false }
  }, [blocker])
  useEffect(() => { if (route.page !== 'settings') setSettingsDirty(false) }, [route.page])
  const [conversations, setConversations] = useState<WebConversation[]>([])
  const [assistantConversation, setAssistantConversation] = useState<WebConversation>()
  const [assistantReceipts, setAssistantReceipts] = useState<WebAssistantMessageReceipt[]>([])
  const [workInteractions, setWorkInteractions] = useState<Array<Extract<RunStatus, { kind: 'interaction' }>>>([])
  const [archivedConversations, setArchivedConversations] = useState<WebConversation[]>([])
  const [projects, setProjects] = useState<WebProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(() => window.localStorage.getItem('pulse-web-project') ?? undefined)
  const [messages, setMessages] = useState<WebMessage[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [paired, setPaired] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const sync = () => { setMobileLayout(media.matches); if (!media.matches) setDrawerOpen(false) }
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [status, setStatus] = useState<RunStatus[]>([])
  const [traces, setTraces] = useState<Record<string, TraceState>>({})
  const [persistedTraceFallback, setPersistedTraceFallback] = useState(false)
  const traceQueue = useRef<Array<{ runId: string; event: WebRunEvent }>>([])
  const traceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queueTrace = useCallback((runId: string, event: WebRunEvent) => {
    traceQueue.current.push({ runId, event })
    if (traceTimer.current !== undefined) return
    traceTimer.current = setTimeout(() => {
      traceTimer.current = undefined
      const batch = traceQueue.current.splice(0)
      setTraces(current => {
        const next = { ...current }
        for (const item of batch) next[item.runId] = reduceTrace(next[item.runId] ?? emptyTrace, item.event)
        return next
      })
    }, 60)
  }, [])
  const [reviewNote, setReviewNote] = useState('')
  const localMessages = useRef(new Map<string, WebMessage[]>())
  const rememberMessage = (key: string, message: WebMessage) => {
    localMessages.current.set(key, [...(localMessages.current.get(key) ?? []).filter(item => item.id !== message.id), message])
  }
  const patchLocalMessage = (key: string, id: string, patch: Partial<WebMessage>) => {
    localMessages.current.set(key, (localMessages.current.get(key) ?? []).map(item => item.id === id ? { ...item, ...patch } : item))
  }
  const mergeMessages = (key: string, persisted: WebMessage[]) => {
    const pending = (localMessages.current.get(key) ?? []).filter(message => !persisted.some(item => item.id === message.id || message.requestId && (item.requestId === message.requestId || item.id === `msg-${message.requestId}`)))
    localMessages.current.set(key, pending)
    return [...persisted, ...pending]
  }
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({})
  const submittedDrafts = useRef(new Map<string, { keys: string[]; revision: number }>())
  const draft = drafts[selectedId ?? 'new']?.markdown ?? ''
  const updateDraft = (key: string, update: (current: ComposerDraft) => ComposerDraft) => setDrafts(current => {
    const previous = current[key] ?? emptyComposerDraft()
    const next = update(previous)
    if (next === previous) return current
    return { ...current, [key]: next }
  })
  const rememberSubmittedDraft = (requestId: string, key: string) => {
    const source = drafts[key]
    if (source) submittedDrafts.current.set(requestId, { keys: [key], revision: source.revision })
  }
  const clearSubmittedDraft = (requestId: string) => {
    const sent = submittedDrafts.current.get(requestId)
    if (!sent) return
    for (const key of sent.keys) updateDraft(key, current => current.revision === sent.revision && current.processing === 0
      ? { ...emptyComposerDraft(), revision: current.revision + 1 }
      : current)
    submittedDrafts.current.delete(requestId)
  }
  const [newApprovalPolicy, setNewApprovalPolicy] = useState<'manual' | 'delegate'>('manual')
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [editingTitle, setEditingTitle] = useState('')
  const [menuId, setMenuId] = useState<string>()
  const menuIdRef = useRef(menuId)
  menuIdRef.current = menuId
  const detailsOpen = route.query.get('details') === '1'
  const setDetailsOpen = (open: boolean) => patchQuery({ details: open, ...(open ? { task: undefined, lane: undefined } : {}) })
  const [effectiveModel, setEffectiveModel] = useState<string>()
  const settingsOpen = route.page === 'settings'
  const archiveOpen = route.page === 'archive'
  const workbenchOpen = route.page === 'work' && route.query.has('workspace')
  const workbenchTab = (route.query.get('workspace') ?? 'files') as WorkspaceTab
  const setWorkbenchOpen = (open: boolean) => patchQuery({ workspace: open ? workbenchTab : undefined })
  const setWorkbenchTab = (tab: WorkspaceTab) => patchQuery({ workspace: tab })
  const runPanelOpen = route.page === 'work' && route.query.get('task') === '1'
  const setRunPanelOpen = (open: boolean) => patchQuery({ task: open, ...(!open ? { lane: undefined } : { details: undefined }) })
  const selectedLaneId = route.query.get('lane') ?? undefined
  const setSelectedLaneId = (lane: string) => patchQuery({ lane, task: true, details: undefined })
  const [sessionCapabilities, setSessionCapabilities] = useState<{ localAdmin: boolean; canUseTerminal: boolean }>({ localAdmin: false, canUseTerminal: false })
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(() => { try { return JSON.parse(window.localStorage.getItem('pulse-web-collapsed-projects') ?? '[]') as string[] } catch { return [] } })
  const [atBottom, setAtBottom] = useState(true)
  const followBottom = useRef(true)
  const scrollView = useRef<{ key: string; element: HTMLElement | null }>({ key: '', element: null })
  const [submitting, setSubmitting] = useState(false)
  const [resumingRunId, setResumingRunId] = useState<string>()
  const [pairing, setPairing] = useState<{ code: string; pairUrl: string; qrSvg: string; devices: Device[] }>()
  const [pairError, setPairError] = useState('')
  const [toast, setToast] = useState('')
  const eventClose = useRef<(() => void) | undefined>(undefined)
  const streamRunRef = useRef<string | undefined>(undefined)
  const assistantIdRef = useRef<string | undefined>(undefined)
  const routeEpoch = useRef(0)
  const requestId = useRef(0)
  const adoptedRoute = useRef<string | undefined>(undefined)
  const bootstrapStarted = useRef(false)
  const sendLock = useRef(false)
  const messagesEl = useRef<HTMLElement>(null)
  const composerEl = useRef<HTMLTextAreaElement>(null)
  const drawerTrigger = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedIdRef = useRef<string | undefined>(undefined)
  selectedIdRef.current = selectedId
  const selected = surfaceMode === 'chat' ? assistantConversation : conversations.find(item => item.id === selectedId)
  const isPairPage = route.page === 'pair'
  const routeRef = useRef(route); routeRef.current = route
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

  const openConversation = useCallback(async (conversation: WebConversation, saveSelection = true) => {
    if (saveSelection) { go(workUrl(conversation.id)); return }
    window.localStorage.setItem('pulse-web-surface', 'work')
    const id = ++requestId.current
    eventClose.current?.(); eventClose.current = undefined
    selectedIdRef.current = conversation.id
    setSelectedId(conversation.id)
    setSelectedProjectId(conversation.projectId)
    if (conversation.projectId) window.localStorage.setItem('pulse-web-project', conversation.projectId)
    else window.localStorage.removeItem('pulse-web-project')
    setMenuId(undefined); setLoadError(''); setStatus([]); setReviewNote('')
    setRunning(false); setStopping(false); setResumingRunId(undefined)
    if (saveSelection) window.localStorage.setItem(historyStorageKey, conversation.id)
    try {
      const result = await apiJson<MessageList>(transport, `/api/web/conversations/${encodeURIComponent(conversation.id)}/messages`)
      if (requestId.current !== id || selectedIdRef.current !== conversation.id) return
      setMessages(mergeMessages(conversation.id, result.filter(message => message.role !== 'system')))
      if (!conversation.activeRunId) return
      let snapshot: WebRunSnapshot
      try { snapshot = await apiJson<WebRunSnapshot>(transport, `/api/runs/${encodeURIComponent(conversation.activeRunId)}/state`) }
      catch { snapshot = { runId: conversation.activeRunId, state: 'interrupted', seq: 0, activities: [] } }
      if (requestId.current !== id || selectedIdRef.current !== conversation.id) return
      const restored = snapshotStatus(snapshot)
      setStatus(restored)
      setReviewNote(snapshot.reviewNote ?? '')
      if (snapshot.state === 'running') {
        setRunning(true)
        startRun(conversation.activeRunId, conversation.id, snapshot.seq)
      } else if (snapshot.state !== 'interrupted') {
        setConversations(items => items.map(item => item.id === conversation.id ? withoutActiveRun(item) : item))
      }
    } catch {
      if (requestId.current === id) setLoadError('这段对话暂时无法打开，请检查连接后重试。')
    }
  }, [drafts, transport, go])

  const loadAssistant = useCallback(async (showLoading = true) => {
    const id = ++requestId.current
    if (showLoading) setLoading(true)
    setLoadError('')
    try {
      const [view, projectList] = await Promise.all([
        apiJson<{ conversation: WebConversation; messages: MessageList; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[] }>(transport, '/api/assistant'),
        apiJson<WebProject[]>(transport, '/api/projects').catch(() => [] as WebProject[]),
      ])
      if (id !== requestId.current) return
      assistantIdRef.current = view.conversation.id
      const active = [...view.receipts].reverse().find(item => item.state === 'replying')
      const { activeRunId: _storedActiveRunId, ...assistantSummary } = view.conversation
      setAssistantConversation({ ...assistantSummary, ...(active ? { activeRunId: active.runId } : {}), kind: 'assistant' })
      setAssistantReceipts(view.receipts)
      setWorkInteractions(view.workInteractions.map(interaction => ({ kind: 'interaction', runId: interaction.runId, conversationId: interaction.conversationId, conversationTitle: interaction.title, ...(interaction.projectId ? { projectId: interaction.projectId } : {}), approvalPolicy: interaction.approvalPolicy, groupId: interaction.groupId, interactionKind: interaction.kind, items: interaction.items })))
      setProjects(projectList)
      selectedIdRef.current = view.conversation.id
      setSelectedId(view.conversation.id)
      setMessages(mergeMessages(view.conversation.id, view.messages.filter(message => message.role !== 'system')))
      if (active) setConversations(items => items.map(item => item.id === view.conversation.id ? { ...item, activeRunId: active.runId } : item))
      else setRunning(false)
      window.localStorage.setItem('pulse-web-surface', 'chat')
    } catch (error) {
      if (id !== requestId.current) return
      if (error instanceof ApiError && error.status === 401) { setPaired(false); setLoadError('此浏览器尚未授权。请在本机重试，或用手机扫码配对。') }
      else setLoadError('Pulse 助理聊天暂时无法加载，请检查连接后重试。')
    } finally { if (showLoading && id === requestId.current) setLoading(false) }
  }, [drafts, transport])

  const loadHistory = useCallback(async (preferred?: string) => {
    const epoch = routeEpoch.current
    let redirecting = false
    const id = ++requestId.current
    setLoading(true); setLoadError('')
    try {
      // Listing conversations can register legacy projects; load their catalog afterward.
      const list = await apiJson<ConversationList>(transport, '/api/conversations')
      if (id !== requestId.current) return
      const projectList = await apiJson<WebProject[]>(transport, '/api/projects')
      if (id !== requestId.current) return
      const current = routeRef.current
      if (!preferred && !current.newWork) {
        const saved = window.localStorage.getItem(historyStorageKey)
        const next = list.find(item => item.id === saved)
        const savedProject = window.localStorage.getItem('pulse-web-project') ?? undefined
        redirecting = true
        go(workUrl(next?.id, next ? undefined : projectList.find(project => project.id === savedProject)?.id), true)
        return
      }
      setConversations(list); setProjects(projectList)
      if (preferred) {
        const conversation = list.find(item => item.id === preferred) ?? await getWebConversation(transport, preferred)
        if (id !== requestId.current) return
        if (conversation.kind === 'assistant') { go('/chat', true); return }
        setConversations(items => items.some(item => item.id === conversation.id)
          ? items.map(item => item.id === conversation.id ? conversation : item)
          : [...items, conversation])
        window.localStorage.setItem(historyStorageKey, conversation.id)
        await openConversation(conversation, false)
      } else {
        const projectId = current.query.get('project') ?? undefined
        setSelectedProjectId(projectId)
        if (projectId && !projectList.some(project => project.id === projectId)) setLoadError('这个项目不存在或已移除，请选择其他项目。')
        selectedIdRef.current = undefined
        setSelectedId(undefined); setMessages(mergeMessages('new', [])); setStatus([]); setRunning(false)
      }
    } catch (error) {
      if (id !== requestId.current) return
      if (error instanceof ApiError && error.status === 401) { setPaired(false); setLoadError('此浏览器尚未授权。请在本机重试，或用手机扫码配对。') }
      else setLoadError(error instanceof ApiError && error.status === 404 ? '这段对话不存在或已删除。可以选择其他对话。' : '聊天记录暂时无法加载，请检查 Pulse 服务后重试。')
    } finally { if (!redirecting && epoch === routeEpoch.current) setLoading(false) }
  }, [openConversation, transport, go, drafts])

  const refreshDirectory = useCallback(async () => {
    try {
      const conversationList = await apiJson<ConversationList>(transport, '/api/conversations')
      const projectList = await apiJson<WebProject[]>(transport, '/api/projects')
      setConversations(current => [...conversationList, ...current.filter(item => item.archivedAt && item.id === selectedIdRef.current && !conversationList.some(next => next.id === item.id))])
      setProjects(projectList)
    } catch { /* Keep the last known directory while the service is temporarily offline. */ }
  }, [transport])

  const bootstrap = useCallback(async () => {
    const params = new URLSearchParams(locationRef.current.search)
    const code = params.get('code')
    let authenticated = false
    setLoading(true); setLoadError('')
    try {
      if (code) {
        await apiJson(transport, '/api/pair', jsonRequest('POST', { code, name: navigator.userAgent.slice(0, 50) }))
        const current = locationRef.current
        const params = new URLSearchParams(current.search); params.delete('code')
        go(current.pathname + (params.size ? `?${params}` : ''), true, current.state)
      } else if (localHost) await apiJson(transport, '/api/session/local', jsonRequest('POST'))
      const session = await apiJson<{ localAdmin?: boolean; canUseTerminal?: boolean }>(transport, '/api/session')
      setSessionCapabilities({ localAdmin: session.localAdmin === true, canUseTerminal: session.canUseTerminal === true })
      authenticated = true
      setPaired(true)

    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setPaired(false); setLoadError('设备尚未授权。请在本机打开 Pulse，或重新扫码配对。') }
      else { setPaired(false); setLoadError('无法连接或验证 Pulse，请检查服务和配对码后重试。') }
    } finally { if (!authenticated) setLoading(false) }
  }, [localHost, transport, go, location.state])

  useEffect(() => {
    if (isPairPage || bootstrapStarted.current) return
    bootstrapStarted.current = true
    void bootstrap()
  }, [bootstrap, isPairPage])
  useEffect(() => () => eventClose.current?.(), [])
  useEffect(() => {
    if (!paired) return
    const timer = window.setInterval(() => { void refreshDirectory() }, 15_000)
    const onVisibility = () => { if (document.visibilityState === 'visible') void refreshDirectory() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [paired, refreshDirectory])
  useEffect(() => {
    const receive = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      if (!message) return
      setToast(message); window.setTimeout(() => setToast(''), 2600)
    }
    window.addEventListener('pulse-toast', receive)
    return () => window.removeEventListener('pulse-toast', receive)
  }, [])
  useEffect(() => {
    if (!drawerOpen) return
    const first = document.querySelector<HTMLButtonElement>('.drawer .new-button')
    first?.focus()
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { if (menuIdRef.current) { setMenuId(undefined); return }; setDrawerOpen(false); drawerTrigger.current?.focus(); return }
      if (event.key !== 'Tab') return
      const drawer = document.querySelector<HTMLElement>('.drawer')
      const focusable = drawer ? [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')] : []
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [drawerOpen])

  useEffect(() => {
    if (!detailsOpen && !runPanelOpen) return
    const closePanels = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { patchQuery({ details: undefined, task: undefined, lane: undefined }) } }
    window.addEventListener('keydown', closePanels)
    return () => window.removeEventListener('keydown', closePanels)
  }, [detailsOpen, runPanelOpen])

  useEffect(() => {
    if (!detailsOpen || !sessionCapabilities.localAdmin) return
    let cancelled = false
    void apiJson<{ active?: { assistant?: { provider?: string; model?: string; name?: string }; provider?: string; model?: string } }>(transport, '/api/config').then(result => {
      const model = result.active?.assistant
      if (!cancelled) setEffectiveModel(model?.provider && model.model ? `${model.provider} · ${model.name ?? model.model} (${model.model})` : result.active?.provider && result.active.model ? `${result.active.provider} · ${result.active.model}` : undefined)
    }).catch(() => { if (!cancelled) setEffectiveModel(undefined) })
    return () => { cancelled = true }
  }, [detailsOpen, sessionCapabilities.localAdmin, transport])
  useEffect(() => {
    const element = composerEl.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 176)}px`
  }, [selectedId])
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const loadPairing = useCallback(async () => {
    setPairError('')
    try {
      const result = await apiJson<{ code: string; pairUrl: string; qrSvg: string }>(transport, '/api/pair/qr')
      const devices = await apiJson<Device[]>(transport, '/api/devices')
      setPairing({ ...result, devices })
    } catch { setPairError('请在运行 Pulse 的电脑上打开配对页面。') }
  }, [transport])
  useEffect(() => { if (isPairPage) void loadPairing() }, [isPairPage, loadPairing])

  const createConversation = () => {
    setNewApprovalPolicy('manual')
    window.localStorage.removeItem(historyStorageKey)
    go(workUrl(undefined, selectedProjectId))
    setDrawerOpen(false)
    window.setTimeout(() => composerEl.current?.focus(), 0)
  }

  const switchMode = (mode: 'chat' | 'work') => {
    if (surfaceMode === mode) return
    go(mode === 'chat' ? '/chat' : '/work')
  }

  useEffect(() => {
    if (!paired) return
    const search = route.query.toString()
    if (search !== new URLSearchParams(location.search).toString()) go(location.pathname + (search ? `?${search}` : ''), true, location.state)
  }, [paired, location.pathname, location.search, go])

  const loaders = useRef({ loadAssistant, loadHistory }); loaders.current = { loadAssistant, loadHistory }
  const [routeRevision, setRouteRevision] = useState(0)
  const documentKey = `${route.page}:${route.conversationId ?? (route.newWork ? 'new' : '')}:${route.newWork ? route.query.get('project') ?? '' : ''}`
  useEffect(() => {
    if (location.pathname === '/') { go('/chat' + location.search, true); return }
    if (!paired) return
    if (route.conversationId && adoptedRoute.current === route.conversationId) { adoptedRoute.current = undefined; return }
    adoptedRoute.current = undefined
    routeEpoch.current++
    if (traceTimer.current !== undefined) clearTimeout(traceTimer.current)
    traceTimer.current = undefined; traceQueue.current = []; setTraces({}); setPersistedTraceFallback(false)
    requestId.current++
    eventClose.current?.(); eventClose.current = undefined; streamRunRef.current = undefined
    selectedIdRef.current = undefined; setSelectedId(undefined)
    setDrawerOpen(false); setMessages([]); setStatus([]); setReviewNote(''); setRunning(false); setStopping(false); setResumingRunId(undefined)
    if (route.page === 'chat') void loaders.current.loadAssistant()
    else if (route.page === 'work') void loaders.current.loadHistory(route.conversationId)
    else setLoading(false)
  }, [paired, documentKey, routeRevision])

  useLayoutEffect(() => {
    const element = messagesEl.current
    const key = `${documentKey}:${routeRevision}`
    if (scrollView.current.key !== key || scrollView.current.element !== element) {
      scrollView.current = { key, element }
      followBottom.current = true
      setAtBottom(true)
    }
    const ready = route.page === 'chat'
      ? Boolean(selectedId) && selectedId === assistantConversation?.id
      : route.page === 'work' && (route.newWork ? selectedId === undefined : Boolean(route.conversationId) && selectedId === route.conversationId)
    // Position loaded history before paint. Automatic following must not animate
    // across the history; only the explicit "back to bottom" action is smooth.
    if (element && !loading && ready && followBottom.current) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
  }, [documentKey, routeRevision, loading, selectedId, messages, status, traces])

  const startRun = useCallback((runId: string, conversationId: string, after = 0) => {
    eventClose.current?.()
    streamRunRef.current = runId
    if (selectedIdRef.current === conversationId) setRunning(true)
    let lastSeq = after
    let traceSeq = 0
    let closed = false
    let unsubscribe: (() => void) | undefined
    eventClose.current = () => { closed = true; unsubscribe?.() }
    const onEvent = (event: WebRunEvent) => {
      if ((event.conversationId && event.conversationId !== conversationId) || event.runId !== runId || event.seq <= lastSeq) return
      lastSeq = event.seq
      if (selectedIdRef.current !== conversationId) return
      if (isTraceEvent(event) && event.seq > traceSeq) queueTrace(runId, event)
      // The state snapshot already rendered these. Replaying them after a trace
      // rewind would put answered approvals and stale tool rows back on screen.
      if (event.seq <= after && (event.type === 'status' || event.type === 'tool' || event.type === 'lanes' || event.type === 'waiting' || event.type === 'interactions' || event.type === 'text')) return
      if (event.type === 'status') setStatus(current => replaceStatus(current, { kind: 'status', label: event.data.label ?? (event.data.kind === 'context' ? '正在整理上下文' : '正在处理') }))
      if (event.type === 'tool') setStatus(current => replaceStatus(current, { kind: 'tool', activityId: event.data.activityId, label: readableTool(event.data.tool), state: event.data.status }))
      if (event.type === 'lanes') setStatus(current => replaceStatus(current, { kind: 'lanes', available: event.data.available, lanes: event.data.lanes }))
      if (event.type === 'waiting') setStatus(current => replaceStatus(current, { kind: 'interaction', runId, groupId: `effect:${event.data.effectId}`, interactionKind: event.data.input.kind === 'ask' ? 'ask' : 'approval', items: [{ effectId: event.data.effectId, input: event.data.input }] }))
      if (event.type === 'interactions') {
        setReviewNote(event.data.reviewNote ?? '')
        setStatus(current => {
          const kept = current.filter(item => item.kind !== 'interaction')
          const groups = event.data.interactions.map(group => ({ kind: 'interaction' as const, runId, groupId: group.groupId, interactionKind: group.kind, items: group.items }))
          return [...kept, ...groups]
        })
      }
      if (event.type === 'text') setMessages(current => replaceRunMessage(current, runId, event.data))
      if (event.type === 'complete') {
        const outcome = event.data.status
        const label = outcome === 'succeeded' ? '已完成' : outcome === 'cancelled' ? '已停止' : event.data.errorCode ? `未完成 · ${event.data.errorCode}` : '任务未完成'
        setReviewNote('')
        setStatus(current => replaceStatus(current.filter(item => item.kind !== 'interaction'), { kind: 'complete', label, outcome }))
      }
      if (event.type === 'error') setStatus(current => replaceStatus(current, { kind: 'complete', label: event.data.message, outcome: 'failed' }))
      if (event.type === 'run_finished') {
        eventClose.current?.(); eventClose.current = undefined
        if (streamRunRef.current === runId) streamRunRef.current = undefined
        setReviewNote('')
        setConversations(items => items.map(item => item.id === conversationId ? withoutActiveRun(item) : item))
        if (assistantIdRef.current === conversationId) {
          void apiJson<{ conversation: WebConversation; messages: MessageList; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[] }>(transport, '/api/assistant').then(view => {
            setAssistantReceipts(view.receipts)
            setWorkInteractions(view.workInteractions.map(interaction => ({ kind: 'interaction', runId: interaction.runId, conversationId: interaction.conversationId, conversationTitle: interaction.title, ...(interaction.projectId ? { projectId: interaction.projectId } : {}), approvalPolicy: interaction.approvalPolicy, groupId: interaction.groupId, interactionKind: interaction.kind, items: interaction.items })))
            if (selectedIdRef.current === conversationId) setMessages(mergeMessages(conversationId, view.messages.filter(message => message.role !== 'system')))
          }).catch(() => undefined)
        } else void apiJson<MessageList>(transport, `/api/web/conversations/${encodeURIComponent(conversationId)}/messages`).then(result => {
          if (selectedIdRef.current === conversationId) setMessages(mergeMessages(conversationId, result.filter(message => message.role !== 'system')))
        }).catch(() => undefined)
        if (selectedIdRef.current === conversationId) { setRunning(false); setStopping(false) }
      }
    }
    const subscribe = (cursor: number) => {
      if (closed || selectedIdRef.current !== conversationId) return
      lastSeq = cursor
      unsubscribe = transport.subscribe(`/api/runs/${encodeURIComponent(runId)}/events?after=${cursor}`, onEvent, () => {
        setToast('连接中断，正在尝试恢复…')
        window.setTimeout(() => setToast(''), 3000)
      })
      if (closed) unsubscribe()
    }
    if (conversationId === assistantIdRef.current) subscribe(after)
    else {
      // Hydrate the trace prefix before subscribing. Events newer than the state
      // snapshot may already be in this response; still replay other UI events,
      // but do not append their reasoning a second time.
      traceQueue.current = traceQueue.current.filter(item => item.runId !== runId)
      setTraces(current => ({ ...current, [runId]: emptyTrace }))
      void apiJson<{ events: WebRunEvent[]; seq?: number }>(transport, `/api/runs/${encodeURIComponent(runId)}/trace`).then(result => {
        if (closed || selectedIdRef.current !== conversationId) return
        traceSeq = result.seq ?? Math.max(0, ...result.events.map(event => event.seq))
        setTraces(current => ({ ...current, [runId]: result.events.reduce(reduceTrace, emptyTrace) }))
        subscribe(Math.min(after, traceSeq))
      }).catch(() => { subscribe(0) })
    }
  }, [transport, queueTrace])

  const historicalTraceKey = surfaceMode === 'work' && selectedId
    ? [...new Set(messages.flatMap(message => message.role === 'assistant' && message.runId ? [message.runId] : []))].join('\n')
    : ''

  useEffect(() => () => { if (traceTimer.current !== undefined) clearTimeout(traceTimer.current) }, [])

  useEffect(() => {
    if (!historicalTraceKey || !selectedId) return
    const conversationId = selectedId
    const runIds = historicalTraceKey.split('\n')
    let cancelled = false
    void apiJson<{ traces: Array<{ runId: string; events: WebRunEvent[] }> }>(transport, `/api/web/conversations/${encodeURIComponent(conversationId)}/traces`).then(result => {
      if (cancelled || selectedIdRef.current !== conversationId) return
      setTraces(current => {
        let changed = false
        const next = { ...current }
        for (const item of result.traces) {
          if (!runIds.includes(item.runId) || next[item.runId]) continue
          const reduced = item.events.reduce(reduceTrace, emptyTrace)
          if (reduced.order.length === 0) continue
          next[item.runId] = reduced
          changed = true
        }
        return changed ? next : current
      })
    }).catch(() => { if (!cancelled && selectedIdRef.current === conversationId) setPersistedTraceFallback(true) })
    return () => { cancelled = true }
  }, [historicalTraceKey, selectedId, transport])

  useEffect(() => {
    if (!paired || route.page !== 'chat') return
    const refreshAssistantQueue = async () => {
      try {
        const view = await apiJson<{ conversation: WebConversation; messages: MessageList; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[] }>(transport, '/api/assistant')
        setAssistantReceipts(view.receipts)
        setWorkInteractions(view.workInteractions.map(interaction => ({ kind: 'interaction', runId: interaction.runId, conversationId: interaction.conversationId, conversationTitle: interaction.title, ...(interaction.projectId ? { projectId: interaction.projectId } : {}), approvalPolicy: interaction.approvalPolicy, groupId: interaction.groupId, interactionKind: interaction.kind, items: interaction.items })))
        const active = [...view.receipts].reverse().find(item => item.state === 'replying')
        const { activeRunId: _storedActiveRunId, ...assistantSummary } = view.conversation
        setAssistantConversation({ ...assistantSummary, ...(active ? { activeRunId: active.runId } : {}), kind: 'assistant' })
        if (selectedIdRef.current === view.conversation.id) {
          setMessages(current => {
            const streaming = current.filter(message => message.id.startsWith('stream-') && message.runId)
            const persisted = mergeMessages(view.conversation.id, view.messages.filter(message => message.role !== 'system'))
            return [...persisted.filter(message => !streaming.some(item => item.runId === message.runId)), ...streaming]
          })
        }
        if (active && streamRunRef.current !== active.runId && selectedIdRef.current === view.conversation.id) {
          const snapshot = await apiJson<WebRunSnapshot>(transport, `/api/runs/${encodeURIComponent(active.runId)}/state`).catch(() => ({ runId: active.runId, state: 'running' as const, seq: 0, activities: [] }))
          setStatus(snapshotStatus(snapshot))
          startRun(active.runId, view.conversation.id, snapshot.seq)
        } else if (!active && selectedIdRef.current === view.conversation.id) setRunning(false)
      } catch { /* Keep the last displayed messages if a transient poll fails. */ }
    }
    const timer = window.setInterval(() => { void refreshAssistantQueue() }, 900)
    void refreshAssistantQueue()
    return () => window.clearInterval(timer)
  }, [paired, route.page, startRun, transport])

  const send = async (payload?: { text: string; attachments?: WebAttachment[] | undefined; skills?: string[] | undefined; mentionedFiles?: string[] | undefined; requestId?: string | undefined } | FormEvent) => {
    if (payload && 'preventDefault' in payload) payload.preventDefault()
    const text = payload && 'text' in payload ? payload.text.trim() : draft.trim()
    const attachments = payload && 'text' in payload ? payload.attachments : undefined
    const skills = payload && 'text' in payload ? payload.skills : undefined
    const mentionedFiles = payload && 'text' in payload ? payload.mentionedFiles : undefined
    const hasAttachments = Boolean(attachments?.length)

    const sendEpoch = routeEpoch.current
    if (loading || loadError) return false
    if (surfaceMode === 'chat') {
      if ((!text && !hasAttachments) || submitting || sendLock.current || !paired || !assistantConversation) return false
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const optimisticId = `msg-${id}`
      sendLock.current = true; setSubmitting(true); setLoadError('')
      rememberSubmittedDraft(id, assistantConversation.id)
      const optimisticMessage: WebMessage = {
        id: optimisticId,
        role: 'user',
        text,
        requestId: id,
        deliveryState: 'queued',
        createdAt: new Date().toISOString(),
        ...(attachments?.length ? { attachments } : {}),
        ...(skills?.length ? { skills } : {}),
        ...(mentionedFiles?.length ? { mentionedFiles } : {}),
      }
      rememberMessage(assistantConversation.id, optimisticMessage)
      setMessages(current => [...current.filter(message => message.id !== optimisticId), optimisticMessage])
      try {
        const receipt = await apiJson<{ conversationId: string; messageId: string; runId: string; state: WebAssistantMessageReceipt['state'] }>(
          transport,
          '/api/assistant/messages',
          jsonRequest('POST', {
            requestId: id,
            text,
            ...(attachments?.length ? { attachments } : {}),
            ...(skills?.length ? { skills } : {}),
            ...(mentionedFiles?.length ? { mentionedFiles } : {}),
          })
        )
        setMessages(current => current.map(message => {
          if (message.id !== optimisticId) return message
          const { deliveryState: _oldDeliveryState, ...rest } = message
          const deliveryState = receipt.state === 'completed' ? undefined : receipt.state === 'failed' ? 'failed' : receipt.state === 'interrupted' ? 'interrupted' : receipt.state === 'queued' ? 'queued' : 'replying'
          return { ...rest, runId: receipt.runId, ...(deliveryState ? { deliveryState } : {}) }
        }))
        setAssistantReceipts(current => [...current.filter(item => item.messageId !== id), { messageId: id, runId: receipt.runId, state: receipt.state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])
        if (selectedIdRef.current === assistantConversation.id && sendEpoch === routeEpoch.current && receipt.state === 'replying') startRun(receipt.runId, assistantConversation.id)
        clearSubmittedDraft(id)
        return true
      } catch (error) {
        patchLocalMessage(assistantConversation.id, optimisticId, { deliveryState: 'failed' })
        if (selectedIdRef.current === assistantConversation.id) setMessages(current => current.map(message => message.id === optimisticId ? { ...message, deliveryState: 'failed' } : message))
        if (selectedIdRef.current === assistantConversation.id && error instanceof ApiError && error.status === 401) setLoadError('此设备授权已失效，请重新配对。')
      } finally { sendLock.current = false; setSubmitting(false) }
      return
    }
    if ((!text && !hasAttachments) || running || submitting || resumingRunId || selected?.activeRunId || sendLock.current || !paired) {
      if (selected?.activeRunId && !running && !resumingRunId) setToast('请先继续任务或结束这轮，再发送新消息。')
      return false
    }
    sendLock.current = true; setSubmitting(true); setLoadError('')
    let conversationId = selectedId
    const initialSelection = selectedIdRef.current
    const requestId = payload && 'text' in payload && payload.requestId ? payload.requestId : globalThis.crypto?.randomUUID?.() ?? `send-${Date.now()}`
    const pendingId = `pending-${requestId}`
    if (!(payload && 'text' in payload && payload.requestId)) rememberSubmittedDraft(requestId, initialSelection ?? 'new')
    const optimisticMessage: WebMessage = { id: pendingId, requestId, deliveryState: 'queued', role: 'user', text, createdAt: new Date().toISOString(), ...(attachments?.length ? { attachments } : {}), ...(skills?.length ? { skills } : {}), ...(mentionedFiles?.length ? { mentionedFiles } : {}) }
    rememberMessage(initialSelection ?? 'new', optimisticMessage)
    setMessages(current => [...current.filter(message => message.id !== pendingId), optimisticMessage])
    try {
      if (!conversationId) {
        const titleCandidate = text || (attachments?.[0]?.name ? `[附件] ${attachments[0].name}` : '新对话')
        let created = await apiJson<WebConversation>(transport, '/api/conversations', jsonRequest('POST', { title: titleCandidate.slice(0, 64), ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }))
        conversationId = created.id
        rememberMessage(conversationId, optimisticMessage)
        localMessages.current.set('new', (localMessages.current.get('new') ?? []).filter(message => message.id !== pendingId))
        if (selectedIdRef.current === initialSelection && sendEpoch === routeEpoch.current) {
          setDrafts(current => ({ ...current, [created.id]: { ...(current.new ?? emptyComposerDraft()) } }))
          submittedDrafts.current.get(requestId)?.keys.push(created.id)
          selectedIdRef.current = conversationId; setSelectedId(conversationId)
          window.localStorage.setItem(historyStorageKey, conversationId)
          adoptedRoute.current = conversationId
          go(workUrl(conversationId), true)
        }
        setConversations(items => [created, ...items])
        if (newApprovalPolicy === 'delegate') {
          created = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(created.id)}`, jsonRequest('PATCH', { approvalPolicy: 'delegate' }))
          setConversations(items => items.map(item => item.id === created.id ? created : item))
        }
      }
      const response = await apiJson<{ runId: string }>(
        transport,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        jsonRequest('POST', {
          text, requestId,
          ...(attachments?.length ? { attachments } : {}),
          ...(skills?.length ? { skills } : {}),
          ...(mentionedFiles?.length ? { mentionedFiles } : {}),
        })
      )
      patchLocalMessage(conversationId, pendingId, { deliveryState: 'replying', runId: response.runId })
      if (selectedIdRef.current === conversationId) {
        setMessages(current => current.map(message => message.id === pendingId ? { ...message, deliveryState: 'replying', runId: response.runId } : message))
        startRun(response.runId, conversationId)
      }
      setConversations(items => items.map(item => item.id === conversationId ? { ...item, activeRunId: response.runId } : item))
      clearSubmittedDraft(requestId)
      return true
    } catch (error) {
      patchLocalMessage(conversationId ?? 'new', pendingId, { deliveryState: 'failed' })
      if (selectedIdRef.current === conversationId) setMessages(current => current.map(message => message.id === pendingId ? { ...message, deliveryState: 'failed' } : message))
      if (selectedIdRef.current === conversationId && error instanceof ApiError && error.status === 401) setLoadError('此设备授权已失效，请重新配对。')
    } finally { sendLock.current = false; setSubmitting(false) }
    return false
  }

  const stopRunFor = async (runId: string, conversationId: string) => {
    if (stopping) return
    setStopping(true)
    try {
      await apiJson(transport, `/api/runs/${encodeURIComponent(runId)}/cancel`, jsonRequest('POST'))
      setToast('已发送停止请求。')
    } catch { setStopping(false); setToast('停止请求未送达，请检查连接。') }
  }

  const stopRun = async () => {
    if (!selected?.activeRunId || stopping) return
    setStopping(true)
    try { await apiJson(transport, surfaceMode === 'chat' ? `/api/assistant/runs/${encodeURIComponent(selected.activeRunId)}/cancel` : `/api/runs/${encodeURIComponent(selected.activeRunId)}/cancel`, jsonRequest('POST')) }
    catch { setStopping(false); setToast('停止请求未送达，请检查连接。') }
  }

  const retryWorkMessage = async (message: WebMessage) => {
    const conversationId = selectedId
    if (!message.requestId || submitting || sendLock.current) return
    if (!conversationId) { await send({ text: message.text, requestId: message.requestId, attachments: message.attachments, skills: message.skills, mentionedFiles: message.mentionedFiles }); return }
    sendLock.current = true; setSubmitting(true)
    try {
      const response = await apiJson<{ runId: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/messages`, jsonRequest('POST', { requestId: message.requestId, text: message.text, attachments: message.attachments, skills: message.skills, mentionedFiles: message.mentionedFiles }))
      patchLocalMessage(conversationId, message.id, { deliveryState: 'replying', runId: response.runId })
      if (selectedIdRef.current === conversationId) { setMessages(items => items.map(item => item.id === message.id ? { ...item, deliveryState: 'replying', runId: response.runId } : item)); setLoadError(''); startRun(response.runId, conversationId) }
      setConversations(items => items.map(item => item.id === conversationId ? { ...item, activeRunId: response.runId } : item))
      clearSubmittedDraft(message.requestId)
    } catch { if (selectedIdRef.current === conversationId) setToast('仍无法发送；原消息和附件已保留。') }
    finally { sendLock.current = false; setSubmitting(false) }
  }

  const retryAssistantMessage = async (message: WebMessage) => {
    if (!message.requestId || submitting || sendLock.current || !assistantConversation) return
    const conversationId = assistantConversation.id
    const retryEpoch = routeEpoch.current
    const isCurrent = () => selectedIdRef.current === conversationId && routeEpoch.current === retryEpoch
    sendLock.current = true; setSubmitting(true)
    try {
      const receipt = await apiJson<{ conversationId: string; messageId: string; runId: string; state: WebAssistantMessageReceipt['state'] }>(transport, '/api/assistant/messages', jsonRequest('POST', { requestId: message.requestId, text: message.text, retry: true, attachments: message.attachments, skills: message.skills, mentionedFiles: message.mentionedFiles }))
      const deliveryState = receipt.state === 'failed' ? 'failed' : receipt.state === 'interrupted' ? 'interrupted' : receipt.state === 'queued' ? 'queued' : receipt.state === 'replying' ? 'replying' : undefined
      const updateMessage = (item: WebMessage): WebMessage => {
        if (item.id !== message.id) return item
        const { deliveryState: _oldDeliveryState, ...rest } = item
        return { ...rest, runId: receipt.runId, ...(deliveryState ? { deliveryState } : {}) }
      }
      localMessages.current.set(conversationId, (localMessages.current.get(conversationId) ?? []).map(updateMessage))
      if (isCurrent()) setMessages(items => items.map(updateMessage))
      setAssistantReceipts(items => [...items.filter(item => item.messageId !== message.requestId), { messageId: message.requestId!, runId: receipt.runId, state: receipt.state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])
      clearSubmittedDraft(message.requestId)
      if (isCurrent() && receipt.state === 'replying') startRun(receipt.runId, conversationId)
    } catch { if (isCurrent()) setToast('仍无法发送；原消息和草稿已保留。') }
    finally { sendLock.current = false; setSubmitting(false) }
  }

  const openWorkNotice = (conversationId: string) => { go(workUrl(conversationId)) }

  const resumeInterruptedRun = async (runId: string) => {
    const conversation = selected
    if (!conversation || conversation.activeRunId !== runId || running || submitting || resumingRunId) return
    setResumingRunId(runId); setToast('')
    try {
      const response = await apiJson<{ runId: string }>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}/runs/${encodeURIComponent(runId)}/resume`, jsonRequest('POST'))
      setConversations(items => items.map(item => item.id === conversation.id ? { ...item, activeRunId: response.runId } : item))
      if (selectedIdRef.current === conversation.id) {
        setStatus([{ kind: 'status', label: '正在继续上次任务' }])
        startRun(response.runId, conversation.id)
      }
    } catch (error) {
      if (selectedIdRef.current !== conversation.id) return
      if (error instanceof ApiError && error.status === 410) {
        setConversations(items => items.map(item => item.id === conversation.id ? withoutActiveRun(item) : item))
        setToast('这轮任务没有可恢复的运行快照；原对话和记录已保留，可以发送新消息。')
      } else if (error instanceof ApiError && error.status === 409) {
        setToast('这轮任务状态已变化或仍被占用；请刷新对话状态后重试。')
      } else setToast('暂时无法继续任务；运行记录已保留，可以重试或结束这轮。')
    } finally { setResumingRunId(current => current === runId ? undefined : current) }
  }

  const endInterruptedRun = async (runId: string) => {
    const conversation = selected
    if (!conversation || conversation.activeRunId !== runId || running || resumingRunId) return
    if (!await dialogs.confirm('结束这轮任务？聊天和运行记录会保留，但不会继续执行。')) return
    try {
      const result = await apiJson<{ cleared: boolean; activeRunId?: string }>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}/runs/${encodeURIComponent(runId)}/reconcile`, jsonRequest('POST'))
      setConversations(items => items.map(item => {
        if (item.id !== conversation.id) return item
        return result.activeRunId ? { ...item, activeRunId: result.activeRunId } : withoutActiveRun(item)
      }))
      if (result.cleared) setStatus(current => replaceStatus(current, { kind: 'complete', outcome: 'interrupted', label: '本轮已结束，原始记录已保留' }))
      else setToast('这轮任务状态已变化，请刷新对话后重试。')
    } catch (error) {
      setToast(error instanceof ApiError && error.status === 409 ? '任务仍在运行，未结束本轮。' : '无法结束本轮任务，请检查连接后重试。')
    }
  }

  const answer = async (runId: string, groupId: string, answers: Array<{ effectId: string; value: Record<string, unknown> }>, conversationId = selected?.id): Promise<boolean> => {
    const requestKey = `pulse-web-interaction-request:${runId}:${groupId}`
    const requestId = window.localStorage.getItem(requestKey) ?? crypto.randomUUID()
    window.localStorage.setItem(requestKey, requestId)
    try {
      await apiJson(transport, `/api/runs/${encodeURIComponent(runId)}/replies`, jsonRequest('POST', { conversationId, groupId, requestId, answers }))
      window.localStorage.removeItem(requestKey)
      const interactionKind = [...status, ...workInteractions].find((item): item is Extract<RunStatus, { kind: 'interaction' }> => item.kind === 'interaction' && item.runId === runId && item.groupId === groupId)?.interactionKind
      setStatus(items => items.filter(item => item.kind !== 'interaction' || item.groupId !== groupId))
      setWorkInteractions(items => items.filter(item => item.runId !== runId || item.groupId !== groupId))
      setToast(interactionKind === 'ask' ? '答案已统一提交。' : '审批结果已提交。')
      window.setTimeout(() => setToast(''), 2200)
      return true
    } catch (error) { if (error instanceof ApiError && error.status >= 400 && error.status < 500) window.localStorage.removeItem(requestKey); setToast('提交失败，内容已保留，请检查连接后重试。'); return false }
  }

  const setApprovalPolicy = async (policy: 'manual' | 'delegate', conversationId = selected?.id) => {
    if (!conversationId) return false
    const current = conversationId === selected?.id ? selected.approvalPolicy : conversations.find(item => item.id === conversationId)?.approvalPolicy
    if ((current ?? 'manual') === policy) return true
    try {
      const updated = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(conversationId)}`, jsonRequest('PATCH', { approvalPolicy: policy }))
      setConversations(items => items.map(item => item.id === conversationId ? updated : item))
      setWorkInteractions(items => items.map(item => item.conversationId === conversationId ? { ...item, approvalPolicy: policy } : item))
      if (selected?.id === conversationId && selected.activeRunId) {
        const snapshot = await apiJson<WebRunSnapshot>(transport, `/api/runs/${encodeURIComponent(selected.activeRunId)}/state`)
        if (selectedIdRef.current === selected.id) { setStatus(snapshotStatus(snapshot)); setReviewNote(snapshot.reviewNote ?? '') }
      }
      return true
    } catch { setToast(policy === 'delegate' ? '无法启动本会话代审；请检查本地审核模型。' : '切回人工失败，请检查连接。'); return false }
  }

  const renameConversation = async (conversation: WebConversation) => {
    if (editingId !== conversation.id) { setEditingId(conversation.id); setEditingTitle(conversation.title); setMenuId(undefined); return }
    const title = editingTitle.trim()
    if (!title || title === conversation.title) { setEditingId(undefined); return }
    try {
      const updated = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}`, jsonRequest('PATCH', { title }))
      setConversations(items => items.map(item => item.id === conversation.id ? { ...item, title: updated.title } : item))
      setEditingId(undefined)
    } catch { setToast('标题更新失败，请重试。') }
  }

  const togglePinned = async (conversation: WebConversation) => {
    try {
      const updated = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}`, jsonRequest('PATCH', { pinned: !conversation.pinned }))
      setConversations(items => items.map(item => item.id === conversation.id ? updated : item))
      setMenuId(undefined)
    } catch { setToast('置顶状态更新失败。') }
  }

  const archiveConversation = async (conversation: WebConversation) => {
    if (conversation.activeRunId) { setToast('运行中或待恢复的对话不能归档。'); return }
    try {
      await apiJson(transport, `/api/conversations/${encodeURIComponent(conversation.id)}`, jsonRequest('PATCH', { archived: true }))
      const remaining = conversations.filter(item => item.id !== conversation.id)
      setConversations(remaining); setMenuId(undefined)
      if (selectedId === conversation.id) {
        window.localStorage.removeItem(historyStorageKey)
        if (remaining[0]) await openConversation(remaining[0])
        else createConversation()
      }
    } catch (error) { setToast(error instanceof ApiError && error.status === 409 ? '对话有待恢复任务，不能归档。' : '归档失败，请重试。') }
  }

  const refreshProjects = async () => {
    try { setProjects(await apiJson<WebProject[]>(transport, '/api/projects')) }
    catch { setToast('项目列表刷新失败。') }
  }

  const createProject = async () => {
    if (!sessionCapabilities.localAdmin) return
    let cwd = ''
    try {
      const selected = await apiJson<{ selected: boolean; cwd?: string; cancelled?: boolean; manualEntry?: boolean }>(transport, '/api/projects/select-directory', jsonRequest('POST'))
      if (selected.cancelled) return
      if (selected.selected && selected.cwd) cwd = selected.cwd
    } catch { /* Manual path entry remains available. */ }
    if (!cwd) cwd = (await dialogs.prompt('输入本机已有目录的绝对路径'))?.trim() ?? ''
    if (!cwd) return
    const fallback = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '新项目'
    const name = (await dialogs.prompt('项目名称', fallback))?.trim()
    if (!name) return
    try {
      const project = await apiJson<WebProject>(transport, '/api/projects', jsonRequest('POST', { name, cwd }))
      setProjects(items => [project, ...items.filter(item => item.id !== project.id)])
      setSelectedProjectId(project.id); window.localStorage.setItem('pulse-web-project', project.id)
      selectProject(project.id)
      setToast('项目已添加；磁盘目录保持不变。')
    } catch (error) { setToast(error instanceof ApiError && error.status === 409 ? '该目录已经登记。' : '项目添加失败，请检查目录路径。') }
  }

  const renameProject = async (project: WebProject) => {
    const name = (await dialogs.prompt('项目名称', project.name))?.trim()
    if (!name || name === project.name) return
    try {
      const updated = await apiJson<WebProject>(transport, `/api/projects/${encodeURIComponent(project.id)}`, jsonRequest('PATCH', { name }))
      setProjects(items => items.map(item => item.id === project.id ? updated : item))
    } catch { setToast('项目名称更新失败。') }
  }

  const toggleProjectPinned = async (project: WebProject) => {
    try {
      const updated = await apiJson<WebProject>(transport, `/api/projects/${encodeURIComponent(project.id)}`, jsonRequest('PATCH', { pinned: !project.pinned }))
      setProjects(items => items.map(item => item.id === project.id ? updated : item)); setMenuId(undefined)
    } catch { setToast('项目置顶状态更新失败。') }
  }

  const reorderProject = async (project: WebProject, direction: -1 | 1) => {
    const index = orderedProjects.findIndex(item => item.id === project.id)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= orderedProjects.length) return
    const next = [...orderedProjects]; [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!]
    try {
      await apiJson(transport, '/api/projects/order', jsonRequest('POST', { ids: next.map(item => item.id) }))
      setProjects(next); setMenuId(undefined)
    } catch { setToast('项目排序保存失败。') }
  }

  const removeProject = async (project: WebProject) => {
    if (!await dialogs.confirm(`移除项目“${project.name}”？对话会归档，目录和文件不会删除。`)) return
    try {
      await apiJson(transport, `/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })
      setProjects(items => items.filter(item => item.id !== project.id))
      setConversations(items => items.filter(item => item.projectId !== project.id))
      if (selectedProjectId === project.id || selected?.projectId === project.id) selectProject(undefined)
      setToast('项目已移除，对话已归档，目录文件仍保留。')
    } catch (error) { setToast(error instanceof ApiError && error.status === 409 ? '项目中有运行中或待恢复的对话，暂时不能移除。' : '项目移除失败。') }
  }

  const selectProject = (projectId?: string) => {
    setNewApprovalPolicy('manual')
    setSelectedProjectId(projectId)
    if (projectId) window.localStorage.setItem('pulse-web-project', projectId)
    else window.localStorage.removeItem('pulse-web-project')
    go(workUrl(undefined, projectId)); setDrawerOpen(false)
  }

  const deleteConversation = async (conversation: WebConversation) => {
    if (conversation.activeRunId) { setToast('运行中的对话不能删除。'); return }
    if (!await dialogs.confirm(`删除“${conversation.title}”？此操作无法撤销。`)) return
    try {
      await apiJson(transport, `/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' })
      const remaining = conversations.filter(item => item.id !== conversation.id)
      setConversations(remaining); setMenuId(undefined)
      if (selectedId === conversation.id) {
        window.localStorage.removeItem(historyStorageKey)
        if (remaining[0]) await openConversation(remaining[0])
        else createConversation()
      }
    } catch { setToast('删除失败；运行中的任务可能尚未结束。') }
  }

  const setProjectCollapsed = (projectId: string, collapsed: boolean) => {
    setCollapsedProjectIds(current => {
      const next = collapsed ? [...new Set([...current, projectId])] : current.filter(id => id !== projectId)
      window.localStorage.setItem('pulse-web-collapsed-projects', JSON.stringify(next))
      return next
    })
  }

  const moveConversation = async (conversation: WebConversation, project?: WebProject) => {
    if (conversation.activeRunId) { setToast('运行中或待恢复的对话不能移动。'); return }
    try {
      const updated = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}`, jsonRequest('PATCH', { projectId: project?.id ?? null }))
      setConversations(items => items.map(item => item.id === conversation.id ? updated : item)); setMenuId(undefined)
      if (updated.projectId) { setProjectCollapsed('projects', false); setProjectCollapsed(updated.projectId, false) }
      if (selectedId === conversation.id) { setSelectedProjectId(updated.projectId); if (updated.projectId) window.localStorage.setItem('pulse-web-project', updated.projectId); else window.localStorage.removeItem('pulse-web-project') }
      setToast(`对话已移动到${project?.name ?? '未分组'}。`)
    } catch (error) { setToast(error instanceof ApiError && error.status === 409 ? '对话仍有运行或待恢复任务，不能移动。' : '移动对话失败。') }
  }

  const activeInteraction = surfaceMode === 'chat'
    ? workInteractions[0] ?? [...status].reverse().find((item): item is Extract<RunStatus, { kind: 'interaction' }> => item.kind === 'interaction')
    : [...status].reverse().find((item): item is Extract<RunStatus, { kind: 'interaction' }> => item.kind === 'interaction')
  const visibleConversations = useMemo(() => conversations
    .filter(item => `${item.title} ${item.cwd} ${projects.find(project => project.id === item.projectId)?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt)), [conversations, projects, query])
  const orderedProjects = useMemo(() => [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))), [projects])
  const ungroupedConversations = visibleConversations.filter(item => !projects.some(project => project.id === item.projectId))
  const pinnedConversations = ungroupedConversations.filter(item => item.pinned)
  const groupedHistory = groupConversations(ungroupedConversations.filter(item => !item.pinned))
  const conversationRows = (items: WebConversation[]) => items.map(conversation => <div key={conversation.id} className={`history-row ${conversation.id === selectedId ? 'selected' : ''}`}>
    {editingId === conversation.id ? <form className="rename-form" onSubmit={event => { event.preventDefault(); void renameConversation(conversation) }}><PulseInput value={editingTitle} autoFocus maxLength={80} onChange={event => setEditingTitle(event.target.value)} aria-label="对话标题" /><PulseButton aria-label="保存标题">✓</PulseButton><PulseButton type="button" aria-label="取消重命名" onClick={() => setEditingId(undefined)}>×</PulseButton></form> : <>
      <PulseButton className="history-item" title={conversation.title} onClick={() => void openConversation(conversation)}><span>{conversation.title || '新对话'}</span>{conversation.pinned && <small className="history-pin" aria-label="已置顶">置顶</small>}{conversation.activeRunId && <i aria-label="运行状态待确认" />}</PulseButton>
      <Dropdown destroyOnHidden trigger={['click']} open={menuId === conversation.id} onOpenChange={open => setMenuId(open ? conversation.id : undefined)} menu={{
        triggerSubMenuAction: 'click',
        items: [
          { key: 'rename', label: '重命名', onClick: () => void renameConversation(conversation) },
          { key: 'pin', label: conversation.pinned ? '取消置顶' : '置顶', onClick: () => void togglePinned(conversation) },
          { key: 'move', label: '移动到项目', disabled: Boolean(conversation.activeRunId) || !projects.some(project => project.id !== conversation.projectId) && !conversation.projectId, children: [
            ...(conversation.projectId ? [{ key: 'ungrouped', label: '未分组', onClick: () => void moveConversation(conversation) }] : []),
            ...orderedProjects.filter(project => project.id !== conversation.projectId).map(project => ({ key: project.id, label: project.name, disabled: !project.available, onClick: () => void moveConversation(conversation, project) })),
          ] },
          { type: 'divider' },
          { key: 'archive', label: '归档', disabled: Boolean(conversation.activeRunId), onClick: () => void archiveConversation(conversation) },
          { key: 'delete', label: '删除', danger: true, disabled: Boolean(conversation.activeRunId), onClick: () => void deleteConversation(conversation) },
        ],
        onClick: () => setMenuId(undefined),
      }}><PulseButton className="row-menu-button" aria-label={`对话操作：${conversation.title}`} aria-expanded={menuId === conversation.id}><Icon name="more"/></PulseButton></Dropdown>
    </>}
  </div>)
  const switchInHistory = surfaceMode === 'work' && (drawerOpen || (!mobileLayout && !sidebarCollapsed))
  const modeSwitch = <div className="surface-switch" role="tablist" aria-label="Pulse 工作模式"><PulseButton role="tab" aria-selected={surfaceMode === 'chat'} className={surfaceMode === 'chat' ? 'active' : ''} onClick={() => switchMode('chat')}>聊天</PulseButton><PulseButton role="tab" aria-selected={surfaceMode === 'work'} className={surfaceMode === 'work' ? 'active' : ''} onClick={() => switchMode('work')}>工作</PulseButton></div>
  const history = <aside className="history" aria-label="历史对话">
    <div className={`history-head ${switchInHistory ? 'has-mode-switch' : ''}`}><strong>Pulse</strong>{switchInHistory && modeSwitch}<PulseButton className="new-button" onClick={createConversation} aria-label="新建对话" title="新建对话"><Icon name="plus"/> <span>新对话</span></PulseButton></div>
    <div className="history-primary"><PulseButton onClick={() => selectProject(undefined)}><Icon name="home"/> <span>全部对话</span></PulseButton></div>
    <label className="history-search"><Icon name="search"/><PulseInput ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索对话" /><kbd>⌘ K</kbd></label>
    <div className="history-list">
      <section className="project-nav-group"><header><PulseButton className="project-nav-heading" aria-expanded={!collapsedProjectIds.includes('projects') || Boolean(query.trim())} onClick={() => setProjectCollapsed('projects', !collapsedProjectIds.includes('projects'))}><Icon className={collapsedProjectIds.includes('projects') && !query.trim() ? 'is-collapsed' : ''} name="chevron"/> 项目</PulseButton><PulseButton className="project-add" disabled={!sessionCapabilities.localAdmin} title="添加本机项目" onClick={() => void createProject()}><Icon name="plus"/></PulseButton></header>{(!collapsedProjectIds.includes('projects') || query.trim()) && <>
        {orderedProjects.map((project, index) => {
          const items = visibleConversations.filter(item => item.projectId === project.id)
          if (query.trim() && !items.length && !project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return null
          const expanded = !collapsedProjectIds.includes(project.id) || Boolean(query.trim())
          return <section className="project-history" key={project.id} aria-label={`${project.name}项目对话`}>
            <div className={`project-nav-row ${selectedProjectId === project.id ? 'selected' : ''}`}>
              <PulseButton title={project.cwd} aria-label={`${expanded ? '折叠' : '展开'}项目：${project.name}`} aria-expanded={expanded} onClick={() => setProjectCollapsed(project.id, expanded)}><Icon className={`project-chevron ${expanded ? '' : 'is-collapsed'}`} name="chevron"/><span className="project-glyph"><Icon name="folder"/></span><span className="project-name">{project.name}</span>{!project.available && <small>不可用</small>}<small className="project-count">{items.length}</small></PulseButton>
              <PulseButton className="project-new-button" aria-label={`在${project.name}中新建对话`} disabled={!project.available} onClick={() => { setProjectCollapsed(project.id, false); selectProject(project.id) }}><Icon name="plus"/></PulseButton>
              <Dropdown destroyOnHidden trigger={['click']} open={menuId === project.id} onOpenChange={open => setMenuId(open ? project.id : undefined)} menu={{ items: [
                { key: 'rename', label: '重命名', onClick: () => void renameProject(project) },
                { key: 'pin', label: project.pinned ? '取消置顶' : '置顶项目', onClick: () => void toggleProjectPinned(project) },
                { key: 'up', label: '上移', disabled: index === 0, onClick: () => void reorderProject(project, -1) },
                { key: 'down', label: '下移', disabled: index === orderedProjects.length - 1, onClick: () => void reorderProject(project, 1) },
                { type: 'divider' },
                { key: 'remove', label: '移除并归档', danger: true, onClick: () => void removeProject(project) },
              ], onClick: () => setMenuId(undefined) }}><PulseButton className="project-menu-button" aria-label={`项目操作：${project.name}`} aria-expanded={menuId === project.id}><Icon name="more"/></PulseButton></Dropdown>
            </div>
            {expanded && <div className="project-conversations">{conversationRows(items)}{!items.length && <p className="project-empty">{query.trim() ? '没有匹配的对话' : '暂无对话'}</p>}</div>}
          </section>
        })}
        {projects.length === 0 && <p className="history-empty">还没有登记项目</p>}
      </>}</section>
      {ungroupedConversations.length > 0 && <section className="ungrouped-history" aria-label="未分组对话"><h2>未分组</h2>
        {pinnedConversations.length > 0 && <section className="history-group"><h2>已置顶</h2>{conversationRows(pinnedConversations)}</section>}
        {groupedHistory.map(group => <section className="history-group" key={group.label}><h2>{group.label}</h2>{conversationRows(group.items)}</section>)}
      </section>}
      {!loading && visibleConversations.length === 0 && <p className="history-empty">{query ? '没有匹配的对话' : '还没有对话'}</p>}
    </div>
    <div className="history-foot"><PulseButton onClick={() => { openPage('/archive'); setDrawerOpen(false) }}><Icon name="archive"/><span>归档对话</span></PulseButton><PulseButton onClick={() => { openPage('/settings'); setDrawerOpen(false) }}><Icon name="settings"/><span>设置</span></PulseButton></div>
  </aside>

  const detailsPanel = <section className="details-popover" role="dialog" aria-label="对话详情"><header><div><strong>对话详情</strong><small>当前会话与工作区信息</small></div><PulseButton className="icon-button" onClick={() => setDetailsOpen(false)} aria-label="关闭"><Icon name="close"/></PulseButton></header><div className="detail-group"><small>项目</small><strong>{projects.find(project => project.id === selected?.projectId)?.name ?? (selected?.projectId ? '项目不可用' : '未分组对话')}</strong></div><div className="detail-group"><small>工作目录</small><code title={selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd}>{selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd ?? '发送首条消息后确定'}</code><PulseButton className="detail-copy" onClick={() => void copyText(selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd ?? '')} disabled={!selected?.cwd && !selectedProjectId}><Icon name="copy"/>复制路径</PulseButton></div><div className="detail-group"><small>默认模型</small><strong>{effectiveModel ?? (sessionCapabilities.localAdmin ? '当前配置未返回实际模型' : '本机管理会话可查看')}</strong><span>这是服务端默认模型；单次任务若有独立路由，以任务路由为准。</span></div><div className="detail-group"><small>审批方式</small><strong>{selected?.approvalPolicy === 'delegate' ? '本会话代审中' : '由用户逐项审批'}</strong><span>审批设置仅影响当前会话。</span></div></section>

  if (isPairPage) return <PairingPage pairing={pairing} error={pairError} refresh={loadPairing} transport={transport} />
  if (!paired && (settingsOpen || archiveOpen)) return <main className="empty">{loading ? <p role="status">正在验证设备…</p> : <div role="alert"><p>{loadError}</p><PulseButton onClick={() => void bootstrap()}>重试</PulseButton></div>}</main>
  if (settingsOpen) return <SettingsPage transport={transport} canEditConfig={sessionCapabilities.localAdmin} category={route.category} onCategoryChange={category => { if (category) go(`/settings/${category}`, false, location.state); else backToSettings() }} onDirtyChange={setSettingsDirty} onClose={() => backToSource()} onOpenArchive={() => openPage('/archive')} />
  if (archiveOpen) return <ArchivePage transport={transport} onBack={() => backToSource()} onChanged={() => { void apiJson<ConversationList>(transport, '/api/conversations').then(setConversations); void refreshProjects() }} onOpen={conversation => { void openConversation(conversation) }} />

  if (route.page === 'missing') return <main className="empty"><h1>页面不存在</h1><PulseButton onClick={() => go('/chat', true)}>返回聊天</PulseButton></main>

  const activeRunId = selected?.activeRunId
  const renderMessages = () => {
    const shown = new Set<string>()
    const items = messages.flatMap(message => {
      const out: ReactElement[] = []
      const runId = message.runId
      if (surfaceMode === 'work' && message.role === 'assistant' && runId && !shown.has(runId)) {
        shown.add(runId)
        const live = traces[runId]
        if (live) out.push(<RunTraceView key={`trace:${runId}`} trace={live} running={running && activeRunId === runId} />)
        else if (persistedTraceFallback) out.push(<PersistedRunTrace key={`trace:${runId}`} runId={runId} transport={transport} />)
      }
      out.push(<MessageBubble key={`${selectedId}:${message.id}`} mode={surfaceMode} message={message} retry={() => void (surfaceMode === 'chat' ? retryAssistantMessage(message) : retryWorkMessage(message))} onOpenWork={openWorkNotice} onFileClick={path => { patchQuery({ workspace: 'files', file: path, details: undefined }) }} />)
      return out
    })
    if (surfaceMode === 'work') for (const [runId, live] of Object.entries(traces)) if (!shown.has(runId)) items.push(<RunTraceView key={`trace:${runId}`} trace={live} running={running && activeRunId === runId} />)
    if (surfaceMode === 'work' && selectedId) items.push(<ConversationArtifacts key={`artifacts:${selectedId}`} conversationId={selectedId} revision={`${selected?.updatedAt}:${messages.length}:${running}`} transport={transport} position={route.query} onNavigate={patchQuery} />)
    return items
  }
  return <main className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${workbenchOpen ? 'workbench-open' : ''}`}>
    {surfaceMode === 'work' && !drawerOpen && <div className="desktop-history">{history}</div>}
    {surfaceMode === 'work' && <Drawer className="pulse-history-drawer" placement="left" size="min(330px,86vw)" open={drawerOpen} onClose={() => { setDrawerOpen(false); drawerTrigger.current?.focus() }} closable={false} destroyOnHidden styles={{ body: { padding: 0 } }}>{drawerOpen && history}</Drawer>}
    <section className="chat">
      <header className={`navbar surface-${surfaceMode} ${detailsOpen ? 'details-open' : ''}`}>
        {surfaceMode === 'work' && <PulseButton ref={drawerTrigger} className="icon-button mobile-menu" onClick={() => setDrawerOpen(true)} aria-label="历史对话"><Icon name="menu"/></PulseButton>}
        {surfaceMode === 'work' && <PulseButton className="icon-button desktop-menu" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开历史对话' : '收起历史对话'}><Icon name="menu"/></PulseButton>}
        {!switchInHistory && modeSwitch}
        <div className="navbar-title"><span className={`status-dot ${paired ? '' : 'offline'}`} /><span className="title-text" title={surfaceMode === 'chat' ? 'Pulse 助理' : selected?.title ?? '新工作会话'}>{surfaceMode === 'chat' ? 'Pulse 助理' : selected?.title ?? '新工作会话'}</span></div>
        <div className="navbar-actions">{surfaceMode === 'chat' && <PulseButton className="details-button" aria-label="设置" title="设置" onClick={() => { openPage('/settings'); setDrawerOpen(false) }}><Icon name="settings"/><span>设置</span></PulseButton>}{selected?.approvalPolicy === 'delegate' && surfaceMode === 'work' && <PulseButton className="delegate-pill" onClick={() => void setApprovalPolicy('manual')} aria-label="切回人工审批">代审中 · 切回人工</PulseButton>}{running && <span className="running-pill"><i />{surfaceMode === 'chat' ? '正在回复' : '运行中'}</span>}{surfaceMode === 'work' && <><PulseButton className={`run-trigger ${running ? 'is-running' : ''} ${runPanelOpen ? 'active' : ''}`} onClick={() => { patchQuery({ task: !runPanelOpen, lane: undefined, details: undefined }) }} aria-expanded={runPanelOpen} aria-label="任务状态"><Icon name="activity"/><span>任务</span></PulseButton><PulseButton className={`workbench-trigger ${workbenchOpen ? 'active' : ''}`} onClick={() => { patchQuery({ workspace: workbenchOpen ? undefined : 'files', details: undefined }) }} aria-expanded={workbenchOpen} aria-label="工作区" title="工作区"><Icon name="folder"/><span>工作区</span></PulseButton></>}<Popover open={detailsOpen} onOpenChange={open => { patchQuery({ details: open, task: undefined, lane: undefined }) }} trigger="click" placement="bottomRight" content={detailsPanel} styles={{ container: { padding: 0 } }}><PulseButton className={`details-button ${detailsOpen ? 'active' : ''}`} aria-label="对话详情" aria-expanded={detailsOpen} title="对话详情"><Icon name="info"/><span>详情</span></PulseButton></Popover></div>

      </header>
      {runPanelOpen && <RunCard status={status} running={running} {...(selected?.activeRunId ? { runId: selected.activeRunId } : {})} resuming={Boolean(resumingRunId)} resume={resumeInterruptedRun} endInterrupted={endInterruptedRun} selectedLaneId={selectedLaneId} onSelectLane={setSelectedLaneId} onClose={() => setRunPanelOpen(false)} />}
      {loadError && <div className="alert" role="alert"><span>{loadError}</span><PulseButton onClick={() => { if (paired) setRouteRevision(value => value + 1); else void bootstrap() }}>重试</PulseButton></div>}
      <section ref={messagesEl} className={`messages ${messages.length === 0 ? 'is-empty' : ''}`} aria-live="polite" aria-label="聊天消息" onScroll={event => { const el = event.currentTarget; const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96; followBottom.current = bottom; setAtBottom(bottom) }}>
        {loading && <div className="empty"><span className="spinner" />正在加载对话…</div>}
        {!loading && messages.length === 0 && paired && <div className="empty"><div className="empty-mark"><Icon name="spark" size={27}/></div><h1>我们要做什么？</h1><p>在 Pulse 工作区中提问或交代任务。</p></div>}
      {renderMessages()}
      </section>
      {!atBottom && <PulseButton className="jump-bottom" onClick={() => { followBottom.current = true; setAtBottom(true); messagesEl.current?.scrollTo({ top: messagesEl.current.scrollHeight, behavior: 'smooth' }) }}>回到底部 ↓</PulseButton>}
      <footer className={`composer-wrap ${activeInteraction ? 'has-interaction' : ''} ${messages.length === 0 && !activeInteraction ? 'is-empty' : ''}`}>
        {activeInteraction ? <InteractionPanel key={`${activeInteraction.runId}:${activeInteraction.groupId}`} interaction={activeInteraction} context={activeInteraction.conversationId ? `${projects.find(project => project.id === activeInteraction.projectId)?.name ?? (activeInteraction.projectId ? '工作项目' : '未分组工作会话')} · ${activeInteraction.conversationTitle ?? '工作会话'}` : undefined} reviewNote={reviewNote} delegated={(activeInteraction.approvalPolicy ?? selected?.approvalPolicy) === 'delegate'} running={activeInteraction.conversationId ? true : running} stopping={stopping} stop={() => void (activeInteraction.conversationId ? stopRunFor(activeInteraction.runId, activeInteraction.conversationId) : stopRun())} submit={answers => answer(activeInteraction.runId, activeInteraction.groupId, answers, activeInteraction.conversationId ?? selected?.id)} setApprovalPolicy={policy => setApprovalPolicy(policy, activeInteraction.conversationId ?? selected?.id)} /> : <><RichComposer key={selectedId ?? 'new'} id="composer" draft={drafts[selectedId ?? 'new'] ?? emptyComposerDraft()} onChange={update => updateDraft(selectedId ?? 'new', update)} placeholder={paired ? '给 Pulse 发送消息…' : '请先授权此设备'} disabled={!paired || loading || Boolean(loadError)} submitting={submitting} running={running} stopping={stopping} surfaceMode={surfaceMode} projectId={selected?.projectId ?? selectedProjectId} transport={transport} onSend={async payload => await send(payload) === true} onStop={() => void stopRun()} />{route.newWork && <div className="new-chat-tools"><PulseButton type="button" className={`new-chat-approval ${newApprovalPolicy === 'delegate' ? 'active' : ''}`} aria-pressed={newApprovalPolicy === 'delegate'} title="开启后，本会话后续工具操作将持续代审；业务问题仍由你回答。" onClick={() => setNewApprovalPolicy(value => value === 'delegate' ? 'manual' : 'delegate')}><Icon name="shield"/><span>{newApprovalPolicy === 'delegate' ? '本会话代审中' : '替我审批'}</span></PulseButton><div className="new-conversation-project"><Icon name="folder"/><Select variant="borderless" aria-label="新对话所属项目" value={selectedProjectId ?? '__ungrouped__'} onChange={value => { const projectId = value === '__ungrouped__' ? undefined : value; patchQuery({ project: projectId }); setSelectedProjectId(projectId); if (projectId) window.localStorage.setItem('pulse-web-project', projectId); else window.localStorage.removeItem('pulse-web-project') }} options={[{ value: '__ungrouped__', label: '不归属项目' }, ...projects.map(project => ({ value: project.id, label: project.name }))]} popupMatchSelectWidth={false} /></div></div>}<div className="composer-hint">Pulse 可能会出错，请核对重要信息。</div></>}
      </footer>
    </section>
    {workbenchOpen && <Suspense fallback={<div className="workbench-loading" role="status">正在打开工作区…</div>}><WorkbenchPanel project={projects.find(project => project.id === (selected?.projectId ?? selectedProjectId))} transport={transport} localAdmin={sessionCapabilities.localAdmin} canUseTerminal={sessionCapabilities.canUseTerminal} tab={workbenchTab} setTab={setWorkbenchTab} position={route.query} onNavigate={patchQuery} onClose={() => setWorkbenchOpen(false)} /></Suspense>}
    {toast && <PulseToast text={toast} />}
  </main>
}

function snapshotStatus(snapshot: WebRunSnapshot): RunStatus[] {
  const items: RunStatus[] = []
  if (snapshot.status) items.push({ kind: 'status', label: snapshot.status.data.label ?? '正在处理' })
  if (snapshot.reviewNote) items.push({ kind: 'review', label: snapshot.reviewNote })
  for (const activity of snapshot.activities) items.push({ kind: 'tool', activityId: activity.data.activityId, label: readableTool(activity.data.tool), state: activity.data.status })
  if (snapshot.laneState) items.push({ kind: 'lanes', available: snapshot.laneState.available, lanes: snapshot.laneState.lanes })
  if (snapshot.interactions?.length) {
    for (const group of snapshot.interactions) items.push({ kind: 'interaction', runId: snapshot.runId, groupId: group.groupId, interactionKind: group.kind, items: group.items })
  } else if (snapshot.waiting) items.push({ kind: 'interaction', runId: snapshot.runId, groupId: `effect:${snapshot.waiting.data.effectId}`, interactionKind: snapshot.waiting.data.input.kind === 'ask' ? 'ask' : 'approval', items: [{ effectId: snapshot.waiting.data.effectId, input: snapshot.waiting.data.input }] })
  if (snapshot.complete) items.push(completeStatus(snapshot.complete.data.status, snapshot.complete.data.errorCode))
  else if (snapshot.state === 'interrupted') items.push({ kind: 'complete', outcome: 'interrupted', label: '任务已中断，没有自动恢复' })
  return items
}

function completeStatus(outcome: 'succeeded' | 'failed' | 'cancelled', errorCode?: string): Extract<RunStatus, { kind: 'complete' }> {
  return { kind: 'complete', outcome, label: outcome === 'succeeded' ? '已完成' : outcome === 'cancelled' ? '已停止' : errorCode ? `未完成 · ${errorCode}` : '任务未完成' }
}

function replaceStatus(items: RunStatus[], value: RunStatus): RunStatus[] {
  if (value.kind === 'tool') return [...items.filter(item => item.kind !== 'tool' || item.activityId !== value.activityId), value]
  if (value.kind === 'lanes') return [...items.filter(item => item.kind !== 'lanes'), value]
  if (value.kind === 'interaction') return [...items.filter(item => item.kind !== 'interaction' || item.groupId !== value.groupId), value]
  if (value.kind === 'complete') return [...items.filter(item => item.kind !== 'complete'), value]
  return [...items.filter(item => item.kind !== 'status'), value]
}

function withoutActiveRun(conversation: WebConversation): WebConversation {
  const { activeRunId: _activeRunId, ...rest } = conversation
  return rest
}

function replaceRunMessage(messages: WebMessage[], runId: string, text: string): WebMessage[] {
  if (!text) return messages
  const id = `stream-${runId}`
  const existing = messages.findIndex(message => message.id === id)
  const message: WebMessage = { id, role: 'assistant', text, runId, createdAt: new Date().toISOString() }
  return existing < 0 ? [...messages, message] : messages.map((item, index) => index === existing ? message : item)
}

function readableTool(name: string): string {
  const labels: Record<string, string> = { 'fs.list': '查看文件', 'fs.read': '读取文件', 'fs.search': '搜索内容', 'web.search': '搜索网页', 'web.fetch': '读取网页', 'shell.exec': '执行命令', 'fs.stage': '修改文件', 'fs.apply_patch': '修改文件', 'fs.apply_patches': '修改文件', 'artifact.record': '记录交付内容' }
  return labels[name] ?? '使用工具'
}

function groupConversations(items: WebConversation[]): Array<{ label: string; items: WebConversation[] }> {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const week = new Date(today); week.setDate(today.getDate() - 7)
  const groups = new Map<string, WebConversation[]>()
  for (const item of items) {
    const date = new Date(item.updatedAt)
    const label = date >= today ? '今天' : date >= yesterday ? '昨天' : date >= week ? '最近 7 天' : '更早'
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, conversations]) => ({ label, items: conversations }))
}

function RunCard({ status, running, runId, resuming, resume, endInterrupted, selectedLaneId, onSelectLane, onClose }: { status: RunStatus[]; running: boolean; runId?: string; resuming: boolean; resume: (runId: string) => void; endInterrupted: (runId: string) => void; selectedLaneId?: string | undefined; onSelectLane: (id: string) => void; onClose: () => void }) {
  const interrupted = status.some((item) => item.kind === 'complete' && item.outcome === 'interrupted')
  const current = [...status].reverse().find(item => item.kind === 'status' || item.kind === 'interaction' || item.kind === 'review' || item.kind === 'complete')
  const outcome = [...status].reverse().find((item): item is Extract<RunStatus, { kind: 'complete' }> => item.kind === 'complete')
  const tools = status.filter((item): item is Extract<RunStatus, { kind: 'tool' }> => item.kind === 'tool')
  const laneState = [...status].reverse().find((item): item is Extract<RunStatus, { kind: 'lanes' }> => item.kind === 'lanes')
  const selectedLane = laneState?.lanes.find(lane => lane.id === selectedLaneId)
  return <aside className="run-panel" aria-label="任务运行状态">
    <header><div><strong>{current?.kind === 'interaction' ? current.interactionKind === 'ask' ? '等待你的回答' : '等待审批' : current?.label ?? (running ? '正在处理' : '任务状态')}</strong><small>{runId ? `Run ${runId.slice(-8)}` : ''}{running ? ' · 运行中' : outcome?.label ? ` · ${outcome.label}` : ''}</small></div><PulseButton className="icon-button" onClick={onClose} aria-label="关闭任务状态"><Icon name="close"/></PulseButton></header>
    {status.length === 0 && <div className="run-empty"><Icon name="activity" size={26}/><strong>没有任务记录</strong><span>开始一个任务后，执行状态和工具活动会显示在这里。</span></div>}
    {status.some(item => item.kind === 'interaction') && <PulseButton className="run-panel-jump" onClick={onClose}>审批和回答位于底部交互面板</PulseButton>}
    {laneState && <section className="lane-tree"><h3>Lane · {laneState.available ? laneState.lanes.length : '—'}</h3>{laneState.available ? laneState.lanes.map((lane, index) => <PulseButton className={`lane-row ${selectedLaneId === lane.id ? 'selected' : ''}`} key={lane.id} style={{ '--lane-depth': lane.parentId ? 1 : 0 } as CSSProperties} onClick={() => onSelectLane(lane.id)}><span className={`lane-state lane-${lane.status}`}>{lane.status === 'succeeded' ? '✓' : lane.status === 'failed' ? '!' : lane.status === 'waiting' ? 'Ⅱ' : lane.status === 'running' ? '◌' : '·'}</span><span><strong>{lane.label}{lane.parentId && <small> · 子任务</small>}</strong><small>{lane.activity ?? laneStatusText(lane.status)}</small></span></PulseButton>) : <p className="lane-unavailable">此历史任务没有可用的 Lane 快照。</p>}
      {selectedLane && <div className="lane-activity-list"><strong>{selectedLane.label} · 活动</strong>{selectedLane.activities?.length ? selectedLane.activities.map(activity => <div key={activity.id}><span>{activity.label}</span><small>{laneStatusText(activity.status)}</small></div>) : <p>没有可展示的活动记录。</p>}</div>}
    </section>}
    {tools.length > 0 && <section className="run-tools"><h3>工具活动</h3>{tools.slice(-12).map(item => <div className="run-activity" key={item.activityId}><span className={item.state === 'succeeded' ? 'status-check' : item.state === 'failed' ? 'status-failed' : ''}>{item.state === 'succeeded' ? '✓' : item.state === 'failed' ? '!' : '·'}</span><span>{item.label}</span><small>{laneStatusText(item.state)}</small></div>)}</section>}
    {status.filter((item): item is Extract<RunStatus, { kind: 'complete' }> => item.kind === 'complete').map(item => <div className={`run-outcome ${item.outcome}`} key={item.outcome}>{item.label}</div>)}
    {interrupted && runId && !running && <div className="run-actions"><PulseButton type="button" className="resume-run" disabled={resuming} onClick={() => resume(runId)}>{resuming ? '正在继续…' : '▶ 继续任务'}</PulseButton><PulseButton type="button" className="end-run" disabled={resuming} onClick={() => endInterrupted(runId)}>结束这轮</PulseButton></div>}
    {status.filter((item): item is Extract<RunStatus, { kind: 'review' }> => item.kind === 'review').map(item => <div className="run-outcome interrupted" key={item.label}>{item.label}</div>)}
    {running && !status.some(item => item.kind === 'status' || item.kind === 'interaction') && <div className="run-status"><span className="spinner" />正在处理</div>}
  </aside>
}

function laneStatusText(status: string): string { return status === 'succeeded' ? '已完成' : status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : status === 'waiting' ? '等待中' : status === 'running' ? '进行中' : status === 'cancelling' ? '正在停止' : status === 'closing' ? '正在收尾' : '排队中' }

type InteractionAnswer = { value: string } | { values: string[] } | { text: string }

export function InteractionPanel({ interaction, context, reviewNote, delegated, running, stopping, stop, submit, setApprovalPolicy }: { interaction: Extract<RunStatus, { kind: 'interaction' }>; context?: string | undefined; reviewNote: string; delegated: boolean; running: boolean; stopping: boolean; stop: () => void; submit: (answers: Array<{ effectId: string; value: Record<string, unknown> }>) => Promise<boolean>; setApprovalPolicy: (policy: 'manual' | 'delegate') => Promise<boolean> }) {
  const key = `pulse-web-interaction:${interaction.runId}:${interaction.groupId}`
  const [answers, setAnswers] = useState<Record<string, InteractionAnswer>>(() => {
    let restored: Record<string, InteractionAnswer> = {}
    try { restored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, InteractionAnswer> } catch { /* Ignore corrupt local drafts and start empty. */ }
    for (const question of interaction.items) if (!restored[question.effectId] && question.input.type === 'input' && typeof question.input.defaultValue === 'string') restored[question.effectId] = { text: question.input.defaultValue }
    for (const question of interaction.items) if (!restored[question.effectId] && question.input.type === 'multi' && (typeof question.input.min !== 'number' || question.input.min === 0)) restored[question.effectId] = { values: [] }
    return restored
  })
  const [index, setIndex] = useState(0)
  const [review, setReview] = useState(false)
  const [sending, setSending] = useState(false)
  const [policyPending, setPolicyPending] = useState(false)
  const [error, setError] = useState('')
  const item = interaction.items[index]
  const input = item?.input ?? {}
  const options = Array.isArray(input.options) ? input.options as Array<string | { value: string; label?: string }> : []
  const selected = item ? answers[item.effectId] : undefined
  const persist = (next: Record<string, InteractionAnswer>) => { setAnswers(next); localStorage.setItem(key, JSON.stringify(next)); setError('') }
  const answerValid = (question: { effectId: string; input: Record<string, unknown> }) => {
    const answer = answers[question.effectId]
    if (question.input.type === 'choice') return Boolean(answer && 'value' in answer && answer.value.length > 0)
    if (question.input.type === 'multi') {
      const values = answer && 'values' in answer ? answer.values : []
      const min = typeof question.input.min === 'number' ? question.input.min : 0
      const max = typeof question.input.max === 'number' ? question.input.max : Number.POSITIVE_INFINITY
      return values.length >= min && values.length <= max
    }
    return Boolean(answer && 'text' in answer)
  }
  const updateCurrent = (value: InteractionAnswer) => { if (item) persist({ ...answers, [item.effectId]: value }) }
  const submitBatch = async (values: Array<{ effectId: string; value: Record<string, unknown> }>) => {
    if (sending) return
    setSending(true); setError('')
    try {
      if (await submit(values)) localStorage.removeItem(key)
      else setError('提交失败，答案已保留；请检查连接后重试。')
    } finally { setSending(false) }
  }
  if (interaction.interactionKind === 'approval') {
    const approvalItem = interaction.items[0]
    const approvalInput = approvalItem?.input ?? {}
    const tools = Array.isArray(approvalInput.tools) ? approvalInput.tools as Array<{ toolName?: string; details?: Record<string, unknown> }> : []
    const approve = () => void submitBatch([{ effectId: approvalItem!.effectId, value: { approved: true } }])
    const deny = () => void submitBatch([{ effectId: approvalItem!.effectId, value: { approved: false, reason: '用户拒绝' } }])
    return <section className="interaction-panel approval-panel" aria-label="待审批操作">
      <div className="interaction-heading"><strong>需要你的确认</strong>{delegated && <span className="delegate-state">本会话代审中</span>}</div>{context && <small className="interaction-context">{context}</small>}
      <p>{typeof approvalInput.prompt === 'string' ? approvalInput.prompt : 'Pulse 需要你确认以下操作。'}{typeof approvalInput.operationCount === 'number' ? ` 共 ${approvalInput.operationCount} 项操作。` : ''}</p>
      <div className="approval-operations">{tools.map((tool, i) => <div className="approval-operation" key={`${tool.toolName}-${i}`}><strong>{readableTool(tool.toolName ?? '')}</strong>{typeof tool.details?.path === 'string' && <code>{tool.details.path}</code>}{typeof tool.details?.command === 'string' && <code>{tool.details.command}</code>}</div>)}</div>
      {tools.some(tool => Object.keys(tool.details ?? {}).some(key => key !== 'path' && key !== 'command')) && <PulseDisclosure className="technical-details" label={"更多操作细节"}>{tools.map((tool, i) => <pre key={i}>{JSON.stringify(tool.details, null, 2)}</pre>)}</PulseDisclosure>}
      {reviewNote && <p className="review-note" role="status">{reviewNote}</p>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <div className="interaction-actions"><PulseButton type="button" className="primary" disabled={sending || policyPending} onClick={approve}>允许本次</PulseButton><PulseButton type="button" className="secondary" disabled={sending || policyPending} onClick={deny}>拒绝</PulseButton>{!delegated && <PulseButton type="button" className="delegate-action" disabled={sending || policyPending} onClick={async () => { setPolicyPending(true); try { if (!await setApprovalPolicy('delegate')) setError('代审暂不可用，请人工确认或稍后重试。') } finally { setPolicyPending(false) } }}>{policyPending ? '正在审查…' : '替我审批'}</PulseButton>}{running && <PulseButton type="button" className="stop-button" disabled={stopping || policyPending} onClick={stop}>{stopping ? '正在停止…' : '停止任务'}</PulseButton>}</div>
    </section>
  }
  const count = interaction.items.length
  const sendAsk = () => void submitBatch(interaction.items.map(question => ({ effectId: question.effectId, value: (answers[question.effectId] ?? (question.input.type === 'multi' ? { values: [] } : {})) as Record<string, unknown> })))
  return <section className="interaction-panel ask-panel" aria-label="待回答问题">
    <div className="interaction-heading"><strong>需要你的回答</strong><span>第 {review ? count : index + 1} / {count} 题{review ? ' · 答案确认' : ''}</span></div>{context && <small className="interaction-context">{context}</small>}
    <div className="question-scroll">
      {review ? <div className="answer-overview">{interaction.items.map((question, i) => <article key={question.effectId}><div><strong>{i + 1}. {String(question.input.prompt ?? '请回答')}</strong><PulseButton type="button" onClick={() => { setIndex(i); setReview(false) }}>修改</PulseButton></div><p>{formatInteractionAnswer(answers[question.effectId], question.input)}</p></article>)}</div> : <>
        <h3>{String(input.prompt ?? '请回答')}</h3>
        {input.type === 'choice' && <div className="question-options">{options.map(option => { const choice = typeof option === 'string' ? { value: option, label: option } : option; const active = Boolean(selected && 'value' in selected && selected.value === choice.value); return <PulseButton type="button" className={active ? 'selected' : ''} disabled={sending} key={choice.value} onClick={() => updateCurrent({ value: choice.value })}>{choice.label ?? choice.value}</PulseButton> })}</div>}
        {input.type === 'multi' && <><p className="question-hint">可多选{typeof input.min === 'number' && input.min > 0 ? `，至少 ${input.min} 项` : ''}{typeof input.max === 'number' ? `，最多 ${input.max} 项` : ''}</p><div className="question-options multi">{options.map(option => { const choice = typeof option === 'string' ? { value: option, label: option } : option; const current = selected && 'values' in selected ? selected.values : []; const max = typeof input.max === 'number' ? input.max : Number.POSITIVE_INFINITY; const atLimit = !current.includes(choice.value) && current.length >= max; return <div key={choice.value}><PulseCheckbox  disabled={sending || atLimit} checked={current.includes(choice.value)} onChange={() => updateCurrent({ values: current.includes(choice.value) ? current.filter(value => value !== choice.value) : [...current, choice.value] })}>{choice.label ?? choice.value}</PulseCheckbox></div> })}</div></>}
        {input.type === 'input' && <PulseTextArea className="question-input" value={selected && 'text' in selected ? selected.text : typeof input.defaultValue === 'string' ? input.defaultValue : ''} disabled={sending} placeholder={typeof input.placeholder === 'string' ? input.placeholder : '请输入'} onChange={event => updateCurrent({ text: event.target.value })} />}
      </>}
    </div>
    {error && <p className="interaction-error" role="alert">{error}</p>}
    <div className="interaction-actions ask-actions">{review ? <><PulseButton type="button" className="secondary" disabled={sending} onClick={() => { setReview(false); setIndex(count - 1) }}>返回修改</PulseButton><PulseButton type="button" className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={sendAsk}>{sending ? '正在提交…' : '统一提交'}</PulseButton></> : <><PulseButton type="button" className="secondary" disabled={sending || index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>上一题</PulseButton>{index < count - 1 ? <PulseButton type="button" className="primary" disabled={sending || !item || !answerValid(item)} onClick={() => setIndex(value => value + 1)}>下一题</PulseButton> : <PulseButton type="button" className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={() => setReview(true)}>检查答案</PulseButton>}{running && <PulseButton type="button" className="stop-button" disabled={stopping} onClick={stop}>{stopping ? '正在停止…' : '停止任务'}</PulseButton>}</>}</div>
  </section>
}

function formatInteractionAnswer(answer: InteractionAnswer | undefined, input: Record<string, unknown>): string {
  if (!answer) return '尚未填写'
  if ('text' in answer) return answer.text || '（空）'
  const options = Array.isArray(input.options) ? input.options as Array<string | { value: string; label?: string }> : []
  const label = (value: string) => { const option = options.find(item => (typeof item === 'string' ? item : item.value) === value); return typeof option === 'string' ? option : option?.label ?? value }
  return 'value' in answer ? label(answer.value) : answer.values.length ? answer.values.map(label).join('、') : '未选择'
}

export function PairingPage({ pairing, error, refresh, transport }: { pairing: { code: string; pairUrl: string; qrSvg: string; devices: Device[] } | undefined; error: string; refresh: () => Promise<void>; transport: PulseWebTransport }) {
  const [message, setMessage] = useState('')
  const revoke = async (device: Device) => {
    try { await apiJson(transport, `/api/devices/${encodeURIComponent(device.id)}/revoke`, jsonRequest('POST')); setMessage('设备授权已撤销。'); await refresh() }
    catch { setMessage('撤销失败，请检查本机连接。') }
  }
  return <main className="pair-page"><section className="pair-card"><div className="pair-header"><div className="brand-mark">✳</div><h1>连接 Pulse</h1><p>手机和电脑连接同一 Wi-Fi 后，扫描二维码即可开始聊天。</p></div>{pairing && <><img className="qr" src={`data:image/svg+xml,${encodeURIComponent(pairing.qrSvg)}`} alt="Pulse 手机配对二维码" /><div className="pair-code">{pairing.code.match(/.{1,4}/g)?.join(' ')}</div><p className="pair-url">{pairing.pairUrl}</p><PulseButton className="refresh-pair" onClick={() => void refresh()}>刷新二维码</PulseButton><div className="devices"><h2>已授权设备</h2>{pairing.devices.length === 0 ? <p>还没有已授权设备</p> : pairing.devices.map(device => <div className="device-row" key={device.id}><span>{device.name}</span><PulseButton onClick={() => void revoke(device)}>撤销</PulseButton></div>)}</div></>}{(error || message) && <p className="pair-error" role="status">{error || message}</p>}</section></main>
}
