import { ConversationCache } from './ConversationCache.js'
import { WindowedMessages } from './WindowedMessages.js'
import { RunRecoveryCard, type RunRecovery } from './RunRecoveryCard.js'
import { useConversationTransfer, transferError } from './ConversationTransfer.js'
import { createRequestId } from './requestId.js'
import { HostPathPicker } from './HostPathPicker.js'
import { PulseButton, PulseCheckbox, PulseDisclosure, PulseInput, PulseTextArea, PulseToast, usePulseDialogs } from './PulseControls.js'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactElement } from 'react'
import { ApiError, apiJson, readLatestMessages, browserTransport, getWebConversation, jsonRequest } from './transport.js'
import { ConversationArtifacts, useConversationArtifacts } from './ConversationArtifacts.js'
import type { ConversationList, MessageList, PulseWebTransport, WebAttachment, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from './transport.js'
import { Drawer, Dropdown, Popover, Select } from 'antd'
import { MessageBubble } from './MessageBubble.js'
import { RichComposer, emptyComposerDraft, type ComposerDraft } from './RichComposer.js'
import { emptyTrace, isTraceEvent, PersistedRunTrace, reduceTrace, RunTraceView } from './RunTrace.js'
import type { TraceState } from './RunTrace.js'
import { copyText } from './clipboard.js'
import { SettingsPage } from './SettingsPage.js'
import { ArchivePage } from './ArchivePage.js'
import { Icon } from './Icon.js'
import { ApprovalPolicySelect, useApprovalPolicy } from './ApprovalPolicyMenu.js'
import { useBlocker } from 'react-router'
import { usePulseNavigation, workUrl, parsePulseRoute, type WorkspaceTab } from './routing.js'
const WorkbenchPanel = lazy(() => import('./WorkbenchPanel.js').then(module => ({ default: module.WorkbenchPanel })))

interface Device { id: string; name: string; createdAt: string; lastUsedAt: string }
type RunStatus =
  | { kind: 'status'; label: string }
  | { kind: 'review'; label: string }
  | { kind: 'tool'; activityId: string; label: string; state: string }
  | { kind: 'interaction'; runId: string; groupId: string; interactionKind: 'ask' | 'approval'; items: Array<{ effectId: string; input: Record<string, unknown> }>; conversationId?: string; conversationTitle?: string; projectId?: string; approvalPolicy?: 'manual' | 'delegate' }
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
  const historyCache = useRef(new ConversationCache())
  const historyAbort = useRef<AbortController | undefined>(undefined)
  const [olderCursor, setOlderCursor] = useState<string>()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [messages, setMessages] = useState<WebMessage[]>([])
  const messagesRef = useRef(messages); messagesRef.current = messages
  const [selectedId, setSelectedId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [serviceConnected, setServiceConnected] = useState(true)
  useEffect(() => transport.onConnection?.(setServiceConnected), [transport])
  const [paired, setPaired] = useState(false)
  const { policy: approvalPolicy, ready: approvalReady, pending: approvalSaving, save: saveApprovalPolicy, retry: retryApprovalPolicy } = useApprovalPolicy(transport, paired)
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
    const flush = () => {
      traceTimer.current = undefined
      const batch = traceQueue.current.splice(0)
      setTraces(current => {
        const next = { ...current }
        for (const item of batch) next[item.runId] = reduceTrace(next[item.runId] ?? emptyTrace, item.event)
        return next
      })
    }
    if (event.type === 'complete' || event.type === 'error') {
      if (traceTimer.current !== undefined) clearTimeout(traceTimer.current)
      flush()
    } else if (traceTimer.current === undefined) traceTimer.current = setTimeout(flush, 100)

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
    const previous = selectedIdRef.current === key ? messagesRef.current : historyCache.current.get(key)?.messages ?? []
    const byId = new Map(previous.map(message => [message.id, message]))
    const first = persisted.find(message => message.sequence !== undefined)?.sequence
    const older = first !== undefined ? previous.filter(message => message.sequence !== undefined && message.sequence < first) : []
    return [...older, ...persisted, ...pending].map(message => { const old = byId.get(message.id); return old && JSON.stringify(old) === JSON.stringify(message) ? old : message })
  }
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({})
  const submittedDrafts = useRef(new Map<string, { keys: string[]; draft: ComposerDraft; clearedRevision: number; restoredDraft?: ComposerDraft }>())
  const interactionRequests = useRef(new Map<string, string>())
  const draft = drafts[selectedId ?? 'new']?.markdown ?? ''
  const updateDraft = (key: string, update: (current: ComposerDraft) => ComposerDraft) => setDrafts(current => {
    const previous = current[key] ?? emptyComposerDraft()
    const next = update(previous)
    if (next === previous) return current
    return { ...current, [key]: next }
  })
  const rememberSubmittedDraft = (requestId: string, key: string) => {
    const source = drafts[key]
    if (!source || source.processing) return
    const clearedRevision = source.revision + 1
    submittedDrafts.current.set(requestId, { keys: [key], draft: source, clearedRevision })
    updateDraft(key, current => current === source ? { ...emptyComposerDraft(), revision: clearedRevision } : current)
  }
  const restoreSubmittedDraft = (requestId: string) => {
    const sent = submittedDrafts.current.get(requestId)
    if (!sent) return
    const restored = { ...sent.draft, revision: sent.clearedRevision + 1 }
    sent.restoredDraft = restored
    for (const key of sent.keys) updateDraft(key, current => current.revision === sent.clearedRevision && current.processing === 0
      ? restored : current)
  }
  const clearSubmittedDraft = (requestId: string) => {
    const sent = submittedDrafts.current.get(requestId)
    if (!sent) return
    // A successful retry can clear only the actual rollback, never a newer edit
    // that happens to have reached the same revision number.
    for (const key of sent.keys) updateDraft(key, current => current === sent.restoredDraft && current.processing === 0
      ? { ...emptyComposerDraft(), revision: current.revision + 1 } : current)
    submittedDrafts.current.delete(requestId)
  }
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [editingTitle, setEditingTitle] = useState('')
  const [menuId, setMenuId] = useState<string>()
  const menuIdRef = useRef(menuId)
  menuIdRef.current = menuId
  const detailsOpen = route.query.get('details') === '1'
  const setDetailsOpen = (open: boolean) => patchQuery({ details: open })
  const [effectiveModel, setEffectiveModel] = useState<string>()
  const settingsOpen = route.page === 'settings'
  const archiveOpen = route.page === 'archive'
  const workbenchOpen = route.page === 'work' && route.query.has('workspace')
  const workbenchTab = (route.query.get('workspace') ?? 'files') as WorkspaceTab
  const setWorkbenchOpen = (open: boolean) => patchQuery({ workspace: open ? workbenchTab : undefined })
  const setWorkbenchTab = (tab: WorkspaceTab) => patchQuery({ workspace: tab })
  const [sessionCapabilities, setSessionCapabilities] = useState({ localAdmin: false, canUseTerminal: false, canBrowseHostPaths: false, canRegisterProject: false })
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(() => { try { return JSON.parse(window.localStorage.getItem('pulse-web-collapsed-projects') ?? '[]') as string[] } catch { return [] } })
  const [atBottom, setAtBottom] = useState(true)
  const followBottom = useRef(true)
  const scrollView = useRef<{ key: string; element: HTMLElement | null }>({ key: '', element: null })
  const [submitting, setSubmitting] = useState(false)
  const [recoveryRun, setRecoveryRun] = useState<RunRecovery>()
  const [runActions, setRunActions] = useState<Record<string, 'resume' | 'end'>>({})
  const runActionLocks = useRef(new Map<string, symbol>())
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
  const artifactIndex = useConversationArtifacts(surfaceMode === 'work' && route.conversationId === selectedId ? selectedId : undefined, `${selected?.updatedAt}:${messages.length}:${running}`, transport)
  const selectedRunRef = useRef<{ conversationId?: string | undefined; runId?: string | undefined }>({})
  selectedRunRef.current = { conversationId: surfaceMode === 'work' ? selected?.id : undefined, runId: selected?.activeRunId }
  const runActionKey = selected?.activeRunId ? `${selected.id}:${selected.activeRunId}` : undefined
  const pendingRunAction = runActionKey ? runActions[runActionKey] : undefined
  const resumingRunId = pendingRunAction ? selected?.activeRunId : undefined
  const transfer = useConversationTransfer({ transport, selected: surfaceMode === 'work' ? selected : undefined, projects,
    unavailable: surfaceMode !== 'work' || running || submitting || loading || !paired || Boolean(resumingRunId),
    onImported: conversation => { setConversations(items => [conversation, ...items.filter(item => item.id !== conversation.id)]); setDrawerOpen(false); go(workUrl(conversation.id)) },
    notice: setToast,
  })
  const isPairPage = route.page === 'pair'
  const routeRef = useRef(route); routeRef.current = route
  const localHost = Boolean(window.pulseDesktop) || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

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
    const cached = historyCache.current.get(conversation.id)
    if (cached) { setMessages(cached.messages); setOlderCursor(cached.before); setLoading(false) }
    historyAbort.current?.abort(); const controller = new AbortController(); historyAbort.current = controller
    setMenuId(undefined); setLoadError(''); setStatus([]); setReviewNote('')
    setRunning(false); setStopping(false); setRecoveryRun(undefined)
    if (saveSelection) window.localStorage.setItem(historyStorageKey, conversation.id)
    try {
      const page = transport.messages ? await transport.messages(conversation.id, undefined, controller.signal) : { before: undefined, items: await apiJson<MessageList>(transport, `/api/web/conversations/${encodeURIComponent(conversation.id)}/messages`, { signal: controller.signal }) }
      const result = page.items
      if (requestId.current !== id || selectedIdRef.current !== conversation.id) return
      setMessages(mergeMessages(conversation.id, result.filter(message => message.role !== 'system')))
      setOlderCursor(page.before)
      historyCache.current.set(conversation.id, { messages: result, ...(page.before ? { before: page.before } : {}), ...(cached?.scrollTop !== undefined ? { scrollTop: cached.scrollTop } : {}) })
      if (!conversation.activeRunId) return
      let snapshot: WebRunSnapshot
      try { snapshot = await apiJson<WebRunSnapshot>(transport, `/api/runs/${encodeURIComponent(conversation.activeRunId)}/state`) }
      catch {
        if (requestId.current === id && selectedIdRef.current === conversation.id) setRecoveryRun({ conversationId: conversation.id, runId: conversation.activeRunId, state: 'unknown' })
        return
      }
      if (requestId.current !== id || selectedIdRef.current !== conversation.id) return
      const restored = snapshotStatus(snapshot)
      setStatus(restored)
      setReviewNote(snapshot.reviewNote ?? '')
      if (snapshot.state === 'interrupted') setRecoveryRun({ conversationId: conversation.id, runId: conversation.activeRunId, state: 'interrupted' })
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
      void apiJson<WebProject[]>(transport, '/api/projects').then(projectList => { if (id === requestId.current) setProjects(projectList) }).catch(() => undefined)
      const view = await apiJson<{ conversation: WebConversation; messages: MessageList; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[]; before?: string }>(transport, '/api/assistant')
      if (id !== requestId.current) return
      assistantIdRef.current = view.conversation.id
      const active = [...view.receipts].reverse().find(item => item.state === 'replying')
      const { activeRunId: _storedActiveRunId, ...assistantSummary } = view.conversation
      setAssistantConversation({ ...assistantSummary, ...(active ? { activeRunId: active.runId } : {}), kind: 'assistant' })
      setAssistantReceipts(view.receipts)
      setWorkInteractions(view.workInteractions.map(interaction => ({ kind: 'interaction', runId: interaction.runId, conversationId: interaction.conversationId, conversationTitle: interaction.title, ...(interaction.projectId ? { projectId: interaction.projectId } : {}), approvalPolicy: interaction.approvalPolicy, groupId: interaction.groupId, interactionKind: interaction.kind, items: interaction.items })))
      setOlderCursor(view.before)
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
      const [list, projectList] = await Promise.all([apiJson<ConversationList>(transport, '/api/conversations'), apiJson<WebProject[]>(transport, '/api/projects')])
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
      const session = await apiJson<{ connected?: boolean; localAdmin?: boolean; canUseTerminal?: boolean; canBrowseHostPaths?: boolean; canRegisterProject?: boolean }>(transport, '/api/session')
      setServiceConnected(session.connected !== false)
      setSessionCapabilities({ localAdmin: session.localAdmin === true, canUseTerminal: session.canUseTerminal === true, canBrowseHostPaths: session.canBrowseHostPaths ?? session.localAdmin === true, canRegisterProject: session.canRegisterProject ?? session.localAdmin === true })
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
    if (!detailsOpen) return
    const closePanels = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { patchQuery({ details: undefined }) } }
    window.addEventListener('keydown', closePanels)
    return () => window.removeEventListener('keydown', closePanels)
  }, [detailsOpen])

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
    const previousId = selectedIdRef.current
    if (previousId) historyCache.current.set(previousId, { messages, ...(olderCursor ? { before: olderCursor } : {}), ...(messagesEl.current ? { scrollTop: messagesEl.current.scrollTop, atBottom: followBottom.current } : {}) })
    historyAbort.current?.abort()
    const target = route.page === 'chat' ? assistantIdRef.current : route.conversationId
    const cached = target ? historyCache.current.get(target) : undefined
    selectedIdRef.current = undefined; setSelectedId(undefined)
    setOlderCursor(cached?.before)
    setDrawerOpen(false); setMessages(cached?.messages ?? []); setStatus([]); setReviewNote(''); setRunning(false); setStopping(false); setRecoveryRun(undefined)
    if (route.page === 'chat') void loaders.current.loadAssistant()
    else if (route.page === 'work') void loaders.current.loadHistory(route.conversationId)
    else setLoading(false)
  }, [paired, documentKey, routeRevision])

  useLayoutEffect(() => {
    const ready = route.page === 'chat'
      ? Boolean(selectedId) && selectedId === assistantConversation?.id
      : route.page === 'work' && (route.newWork ? selectedId === undefined : Boolean(route.conversationId) && selectedId === route.conversationId)
    if (!ready) return
    const element = messagesEl.current
    const key = `${documentKey}:${routeRevision}`
    if (scrollView.current.key !== key || scrollView.current.element !== element) {
      scrollView.current = { key, element }
      const cached = selectedId ? historyCache.current.get(selectedId) : undefined
      const position = cached?.scrollTop
      followBottom.current = cached?.atBottom ?? position === undefined
      setAtBottom(cached?.atBottom ?? position === undefined)
      if (element && position !== undefined) element.scrollTop = position
    }
    // Position loaded history before paint. Automatic following must not animate
    // across the history; only the explicit "back to bottom" action is smooth.
    if (element && !loading && ready && followBottom.current) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
  }, [documentKey, routeRevision, loading, selectedId, messages, status, traces, artifactIndex.artifacts])

  const startRun = useCallback((runId: string, conversationId: string, after = 0) => {
    eventClose.current?.()
    streamRunRef.current = runId
    if (selectedIdRef.current === conversationId) { setRunning(true); setRecoveryRun(undefined) }
    let lastSeq = after
    let traceSeq = 0
    let closed = false
    let unsubscribe: (() => void) | undefined
    eventClose.current = () => { closed = true; unsubscribe?.() }
    const onEvent = (event: WebRunEvent) => {
      if (event.type === 'resync' && event.runId === runId && selectedIdRef.current === conversationId) {
        lastSeq = event.seq
        if (event.data.laneState) queueTrace(runId, { type: 'lanes', runId, seq: event.seq, data: event.data.laneState })
        if (event.data.complete) queueTrace(runId, event.data.complete)
        setStatus(snapshotStatus(event.data)); setRunning(event.data.state === 'running')
        setReviewNote(event.data.reviewNote ?? '')
        if (event.data.state === 'interrupted') setRecoveryRun({ conversationId, runId, state: 'interrupted' })
        if (conversationId !== assistantIdRef.current) void readLatestMessages(transport, conversationId).then(items => { if (selectedIdRef.current === conversationId) setMessages(mergeMessages(conversationId, items)) }).catch(() => undefined)
        return
      }
      if ((event.conversationId && event.conversationId !== conversationId) || event.runId !== runId || event.seq <= lastSeq) return
      lastSeq = event.seq
      if (selectedIdRef.current !== conversationId) return
      if (isTraceEvent(event) && event.seq > traceSeq) queueTrace(runId, event)
      // The state snapshot already rendered these. Replaying them after a trace
      // rewind would put answered approvals and stale tool rows back on screen.
      if (event.seq <= after && (event.type === 'status' || event.type === 'tool' || event.type === 'lanes' || event.type === 'waiting' || event.type === 'interactions' || event.type === 'text')) return
      if (event.type === 'status') setStatus(current => replaceStatus(current, { kind: 'status', label: event.data.label ?? (event.data.kind === 'context' ? '正在整理上下文' : '正在处理') }))
      if (event.type === 'tool') setStatus(current => replaceStatus(current, { kind: 'tool', activityId: event.data.activityId, label: readableTool(event.data.tool), state: event.data.status }))
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
        } else void readLatestMessages(transport, conversationId).then(result => {
          if (selectedIdRef.current === conversationId) setMessages(mergeMessages(conversationId, result.filter(message => message.role !== 'system')))
        }).catch(() => undefined)
        if (selectedIdRef.current === conversationId) { setRunning(false); setStopping(false) }
      }
    }
    const subscribe = (cursor: number) => {
      if (closed || selectedIdRef.current !== conversationId) return
      lastSeq = cursor
      const onError = () => {
        setToast('连接中断，正在尝试恢复…')
        window.setTimeout(() => setToast(''), 3000)
      }
      unsubscribe = conversationId === assistantIdRef.current && transport.subscribeChat ? transport.subscribeChat(runId, cursor, onEvent, onError) : transport.subscribe(`/api/runs/${encodeURIComponent(runId)}/events?after=${cursor}`, onEvent, () => {
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

  const historicalTraceKey = selectedId
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
    let stopped = false, inFlight = false, again = false
    const controller = new AbortController()
    const refreshAssistantQueue = async () => {
      if (stopped) return
      if (inFlight) { again = true; return }
      inFlight = true
      try {
        const view = await apiJson<{ conversation: WebConversation; messages: MessageList; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[] }>(transport, '/api/assistant', { signal: controller.signal })
        if (stopped || routeRef.current.page !== 'chat') return
        setAssistantReceipts(view.receipts)
        setWorkInteractions(view.workInteractions.map(interaction => ({ kind: 'interaction', runId: interaction.runId, conversationId: interaction.conversationId, conversationTitle: interaction.title, ...(interaction.projectId ? { projectId: interaction.projectId } : {}), approvalPolicy: interaction.approvalPolicy, groupId: interaction.groupId, interactionKind: interaction.kind, items: interaction.items })))
        const active = [...view.receipts].reverse().find(item => item.state === 'replying')
        const { activeRunId: _storedActiveRunId, ...assistantSummary } = view.conversation
        setAssistantConversation({ ...assistantSummary, ...(active ? { activeRunId: active.runId } : {}), kind: 'assistant' })
        if (selectedIdRef.current === view.conversation.id) {
          setMessages(current => {
            const streaming = current.filter(message => message.id.startsWith('stream-') && message.runId)
            const persisted = mergeMessages(view.conversation.id, view.messages.filter(message => message.role !== 'system'))
            return [...persisted.filter(message => message.role !== 'assistant' || message.id.startsWith('ask-') || !streaming.some(item => item.runId === message.runId)), ...streaming]
          })
        }
        if (active && streamRunRef.current !== active.runId && selectedIdRef.current === view.conversation.id) {
          const snapshot = await apiJson<WebRunSnapshot>(transport, `/api/runs/${encodeURIComponent(active.runId)}/state`).catch(() => ({ runId: active.runId, state: 'running' as const, seq: 0, activities: [] }))
          setStatus(snapshotStatus(snapshot))
          startRun(active.runId, view.conversation.id, snapshot.seq)
        } else if (!active && selectedIdRef.current === view.conversation.id) setRunning(false)
      } catch { /* Retain cached messages during a reconnect. */ }
      finally { inFlight = false; if (again && !stopped) { again = false; void refreshAssistantQueue() } }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void refreshAssistantQueue() }, 100) }
    const off = transport.onChange?.(changed)
    const poll = transport.onChange ? undefined : window.setInterval(changed, 2500)
    void refreshAssistantQueue()
    return () => { stopped = true; controller.abort(); off?.(); clearTimeout(timer); if (poll !== undefined) window.clearInterval(poll) }
  }, [paired, route.page, startRun, transport])

  const loadOlderMessages = async () => {
    const conversationId = selectedIdRef.current
    if (!conversationId || !olderCursor || loadingOlder || !transport.messages) return
    setLoadingOlder(true)
    const element = messagesEl.current, height = element?.scrollHeight ?? 0
    try {
      const page = await transport.messages(conversationId, olderCursor)
      if (selectedIdRef.current !== conversationId) return
      followBottom.current = false
      setMessages(current => [...page.items.filter(item => !current.some(existing => existing.id === item.id)), ...current])
      setOlderCursor(page.before)
      requestAnimationFrame(() => { if (element && selectedIdRef.current === conversationId) element.scrollTop += element.scrollHeight - height })
    } finally { setLoadingOlder(false) }
  }

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
      const id = createRequestId('send')
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
        restoreSubmittedDraft(id)
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
    const requestId = payload && 'text' in payload && payload.requestId ? payload.requestId : createRequestId('send')
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
      restoreSubmittedDraft(requestId)
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

  const recoverRun = async (runId: string, action: 'resume' | 'end') => {
    const conversation = surfaceMode === 'work' ? selected : undefined
    if (!conversation || conversation.activeRunId !== runId || running || submitting || recoveryRun?.conversationId !== conversation.id || recoveryRun.runId !== runId) return
    const key = `${conversation.id}:${runId}`
    if (runActionLocks.current.has(key)) return
    const token = Symbol(key), epoch = routeEpoch.current
    runActionLocks.current.set(key, token)
    setRunActions(current => ({ ...current, [key]: action }))
    const isCurrent = () => selectedIdRef.current === conversation.id && selectedRunRef.current.runId === runId && routeEpoch.current === epoch
    const updateConversation = (nextRunId?: string) => setConversations(items => items.map(item => item.id !== conversation.id || item.activeRunId !== runId ? item : nextRunId ? { ...item, activeRunId: nextRunId } : withoutActiveRun(item)))
    try {
      if (action === 'end' && (!await dialogs.confirm('结束这轮任务？聊天和运行记录会保留，但不会继续执行。') || !isCurrent())) return
      if (isCurrent()) setToast('')
      if (action === 'resume') {
        const result = await apiJson<{ runId: string }>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}/runs/${encodeURIComponent(runId)}/resume`, jsonRequest('POST'))
        const current = isCurrent()
        updateConversation(result.runId)
        if (current) {
          setRecoveryRun(undefined); setStatus([{ kind: 'status', label: '正在继续上次任务' }])
          startRun(result.runId, conversation.id)
        } else if (selectedIdRef.current === conversation.id && selectedRunRef.current.runId === runId) setRouteRevision(value => value + 1)
      } else {
        const result = await apiJson<{ cleared: boolean; activeRunId?: string }>(transport, `/api/conversations/${encodeURIComponent(conversation.id)}/runs/${encodeURIComponent(runId)}/reconcile`, jsonRequest('POST'))
        const current = isCurrent()
        if (result.cleared) {
          updateConversation()
          if (current) { setRecoveryRun(undefined); setToast('本轮已结束，原始记录已保留') }
        } else if (result.activeRunId) {
          updateConversation(result.activeRunId)
          if (current) setRouteRevision(value => value + 1)
        } else if (current) setToast('这轮任务状态已变化，请刷新对话后重试。')
      }
    } catch (error) {
      const current = isCurrent()
      if (error instanceof ApiError && error.status === 410) {
        updateConversation()
        if (current) { setRecoveryRun(undefined); setToast(action === 'resume' ? '这轮任务没有可恢复的运行快照；原对话和记录已保留，可以发送新消息。' : '本轮已结束，原始记录已保留') }
      } else if (current) {
        if (error instanceof ApiError && error.status === 409) setToast(error.detail ? transferError(error) : action === 'resume' ? '这轮任务状态已变化或仍被占用；请刷新对话状态后重试。' : '任务仍在运行，未结束本轮。')
        else setToast(action === 'resume' ? '暂时无法继续任务；运行记录已保留，可以重试或结束这轮。' : '无法结束本轮任务，请检查连接后重试。')
      }
    } finally {
      if (runActionLocks.current.get(key) === token) {
        runActionLocks.current.delete(key)
        setRunActions(current => { const next = { ...current }; delete next[key]; return next })
      }
    }
  }

  const answer = async (runId: string, groupId: string, answers: Array<{ effectId: string; value: Record<string, unknown> }>, conversationId = selected?.id): Promise<boolean> => {
    const requestKey = `pulse-web-interaction-request:${runId}:${groupId}`
    let storedId: string | null = null
    try { storedId = window.localStorage.getItem(requestKey) } catch { /* Browser storage can be blocked. */ }
    const requestId = interactionRequests.current.get(requestKey) ?? storedId ?? createRequestId('reply')
    interactionRequests.current.set(requestKey, requestId)
    try { window.localStorage.setItem(requestKey, requestId) } catch { /* In-memory idempotency remains available. */ }
    const forgetRequest = () => {
      interactionRequests.current.delete(requestKey)
      try { window.localStorage.removeItem(requestKey) } catch { /* Storage must not prevent an approval. */ }
    }
    try {
      await apiJson(transport, `/api/runs/${encodeURIComponent(runId)}/replies`, jsonRequest('POST', { conversationId, groupId, requestId, answers }))
      forgetRequest()
      const interactionKind = [...status, ...workInteractions].find((item): item is Extract<RunStatus, { kind: 'interaction' }> => item.kind === 'interaction' && item.runId === runId && item.groupId === groupId)?.interactionKind
      setStatus(items => items.filter(item => item.kind !== 'interaction' || item.groupId !== groupId))
      setWorkInteractions(items => items.filter(item => item.runId !== runId || item.groupId !== groupId))
      if (interactionKind === 'ask' && conversationId) {
        void readLatestMessages(transport, conversationId).then(result => {
          if (selectedIdRef.current !== conversationId) return
          setMessages(current => {
            // The run can continue while this fetch is in flight. Merge only
            // the accepted Q&A, so an older snapshot cannot erase a new reply.
            const additions = result.filter(message => message.id.startsWith('ask-') && !current.some(item => item.id === message.id))
            const streaming = current.findIndex(message => message.id === `stream-${runId}`)
            return streaming < 0 ? [...current, ...additions] : [...current.slice(0, streaming), ...additions, ...current.slice(streaming)]
          })
        }).catch(() => undefined)
      }
      setToast(interactionKind === 'ask' ? '答案已统一提交。' : '审批结果已提交。')
      window.setTimeout(() => setToast(''), 2200)
      return true
    } catch (error) { if (error instanceof ApiError && error.status >= 400 && error.status < 500) forgetRequest(); setToast('提交失败，内容已保留，请检查连接后重试。'); return false }
  }

  const setApprovalPolicy = async (policy: 'manual' | 'delegate') => {
    try {
      return await saveApprovalPolicy(policy)
    } catch { setToast('审核方式保存失败，请检查连接后重试。'); return false }
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

  const createProject = async (cwd: string) => {
    if (!sessionCapabilities.canRegisterProject) return
    setProjectPickerOpen(false)
    const fallback = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '新项目'
    const name = (await dialogs.prompt('项目名称', fallback))?.trim()
    if (!name) return
    try {
      const project = await apiJson<WebProject>(transport, '/api/projects', jsonRequest('POST', { name, cwd }))
      setProjects(items => [project, ...items.filter(item => item.id !== project.id)])
      setSelectedProjectId(project.id); window.localStorage.setItem('pulse-web-project', project.id)
      selectProject(project.id)
      setToast('项目已添加；磁盘目录保持不变。')
    } catch (error) { setToast(error instanceof ApiError && (error.status === 409 || error.detail === 'PROJECT_ALREADY_REGISTERED') ? '该目录已经登记。' : '项目添加失败，请检查目录路径。') }
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
    <div className="history-primary">{!mobileLayout && transfer.importButton}<PulseButton onClick={() => selectProject(undefined)}><Icon name="home"/><span>全部对话</span></PulseButton></div>
    <label className="history-search"><Icon name="search"/><PulseInput ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索对话" /><kbd>⌘ K</kbd></label>
    <div className="history-list">
      <section className="project-nav-group"><header><PulseButton className="project-nav-heading" aria-expanded={!collapsedProjectIds.includes('projects') || Boolean(query.trim())} onClick={() => setProjectCollapsed('projects', !collapsedProjectIds.includes('projects'))}><Icon className={collapsedProjectIds.includes('projects') && !query.trim() ? 'is-collapsed' : ''} name="chevron"/> 项目</PulseButton><PulseButton className="project-add" disabled={!sessionCapabilities.canRegisterProject || !sessionCapabilities.canBrowseHostPaths} title="添加电脑项目" aria-label="添加电脑项目" onClick={() => setProjectPickerOpen(true)}><Icon name="plus"/></PulseButton></header>{(!collapsedProjectIds.includes('projects') || query.trim()) && <>
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

  const detailsPanel = <section className="details-popover" role="dialog" aria-label="对话详情"><header><div><strong>对话详情</strong><small>当前会话与工作区信息</small></div><PulseButton className="icon-button" onClick={() => setDetailsOpen(false)} aria-label="关闭"><Icon name="close"/></PulseButton></header><div className="detail-group"><small>项目</small><strong>{projects.find(project => project.id === selected?.projectId)?.name ?? (selected?.projectId ? '项目不可用' : '未分组对话')}</strong></div><div className="detail-group"><small>工作目录</small><code title={selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd}>{selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd ?? '发送首条消息后确定'}</code><PulseButton className="detail-copy" onClick={() => void copyText(selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd ?? '')} disabled={!selected?.cwd && !selectedProjectId}><Icon name="copy"/>复制路径</PulseButton></div><div className="detail-group"><small>默认模型</small><strong>{effectiveModel ?? (sessionCapabilities.localAdmin ? '当前配置未返回实际模型' : '本机管理会话可查看')}</strong><span>这是服务端默认模型；单次任务若有独立路由，以任务路由为准。</span></div><div className="detail-group"><small>审批方式</small><strong>{approvalPolicy === 'delegate' ? '自动审核' : '人工审核'}</strong><span>全局生效，聊天、工作与新会话统一使用此设置。</span></div></section>

  const messageHandlers = useRef({ retryAssistantMessage, retryWorkMessage, openWorkNotice, patchQuery })
  messageHandlers.current = { retryAssistantMessage, retryWorkMessage, openWorkNotice, patchQuery }
  const retryBubble = useCallback((message: WebMessage, mode: 'chat' | 'work') => { void (mode === 'chat' ? messageHandlers.current.retryAssistantMessage(message) : messageHandlers.current.retryWorkMessage(message)) }, [])
  const openBubbleWork = useCallback((id: string) => messageHandlers.current.openWorkNotice(id), [])
  const openBubbleFile = useCallback((path: string) => messageHandlers.current.patchQuery({ workspace: 'files', file: path, details: undefined }), [])

  if (isPairPage) return <PairingPage pairing={pairing} error={pairError} refresh={loadPairing} transport={transport} />
  if (!paired && (settingsOpen || archiveOpen)) return <main className="empty">{loading ? <p role="status">正在验证设备…</p> : <div role="alert"><p>{loadError}</p><PulseButton onClick={() => void bootstrap()}>重试</PulseButton></div>}</main>
  if (settingsOpen) return <SettingsPage transport={transport} canEditConfig={sessionCapabilities.localAdmin} category={route.category} onCategoryChange={category => { if (category) go(`/settings/${category}`, false, location.state); else backToSettings() }} onDirtyChange={setSettingsDirty} onClose={() => backToSource()} onOpenArchive={() => openPage('/archive')} />
  if (archiveOpen) return <ArchivePage transport={transport} onBack={() => backToSource()} onChanged={() => { void apiJson<ConversationList>(transport, '/api/conversations').then(setConversations); void refreshProjects() }} onOpen={conversation => { void openConversation(conversation) }} />

  if (route.page === 'missing') return <main className="empty"><h1>页面不存在</h1><PulseButton onClick={() => go('/chat', true)}>返回聊天</PulseButton></main>

  const activeRunId = selected?.activeRunId
  const recoveryVisible = Boolean(surfaceMode === 'work' && !running && recoveryRun && activeRunId && recoveryRun.conversationId === selected?.id && recoveryRun.runId === activeRunId)
  const emptyConversation = messages.length === 0 && !recoveryVisible && !(surfaceMode === 'work' && (artifactIndex.artifacts.length > 0 || route.query.has('artifactRun')))
  const composerApproval = <ApprovalPolicySelect borderless value={approvalPolicy} unavailable={!approvalReady} onRetry={retryApprovalPolicy} disabled={approvalSaving} onChange={policy => { void setApprovalPolicy(policy) }} />
  const renderMessages = () => {
    const shown = new Set<string>()
    let recoveryShown = false
    const recoveryCard = (runId?: string) => {
      if (!recoveryVisible || !recoveryRun || recoveryShown || runId !== recoveryRun.runId) return null
      recoveryShown = true
      return <RunRecoveryCard key={`recovery:${runId}`} state={recoveryRun.state} pending={pendingRunAction} resume={() => void recoverRun(recoveryRun.runId, 'resume')} end={() => void recoverRun(recoveryRun.runId, 'end')} />
    }
    const lastMessage = new Map<string, number>()
    messages.forEach((message, index) => { if (message.runId) lastMessage.set(message.runId, index) })
    const deliveriesShown = new Set<string>()
    const deliveries = (runId: string) => {
      deliveriesShown.add(runId)
      return selectedId ? <ConversationArtifacts key={`artifacts:${selectedId}:${runId}`} conversationId={selectedId} runId={runId} artifacts={artifactIndex.artifacts.filter(artifact => artifact.runId === runId)} transport={transport} position={route.query} onNavigate={patchQuery} /> : null
    }
    const items = messages.flatMap((message, index) => {
      const out: ReactElement[] = []
      const runId = message.runId
      if (message.role === 'assistant' && runId && !shown.has(runId)) {
        shown.add(runId)
        const live = traces[runId]
        if (live) out.push(<RunTraceView key={`trace:${runId}`} trace={live} running={running && activeRunId === runId} />)
        else if (persistedTraceFallback) out.push(<PersistedRunTrace key={`trace:${runId}`} runId={runId} transport={transport} />)
        const card = recoveryCard(runId); if (card) out.push(card)
      }
      out.push(<MessageBubble key={`${selectedId}:${message.id}`} mode={surfaceMode} message={message} retry={retryBubble} onOpenWork={openBubbleWork} onFileClick={openBubbleFile} transport={transport} conversationId={selectedId} />)
      if (surfaceMode === 'work' && runId && lastMessage.get(runId) === index) { const card = deliveries(runId); if (card) out.push(card) }
      return out
    })
    for (const [runId, live] of Object.entries(traces)) if (!shown.has(runId)) {
      items.push(<RunTraceView key={`trace:${runId}`} trace={live} running={running && activeRunId === runId} />)
      const card = recoveryCard(runId); if (card) items.push(card)
      if (!deliveriesShown.has(runId)) { const card = deliveries(runId); if (card) items.push(card) }
    }
    const fallback = recoveryCard(activeRunId); if (fallback) items.push(fallback)
    if (surfaceMode === 'work') {
      // Legacy/imported runs can have a delivery but no remaining transcript.
      const runIds = new Set(artifactIndex.artifacts.map(artifact => artifact.runId))
      const linkedRun = route.query.get('artifactRun'); if (linkedRun) runIds.add(linkedRun)
      for (const runId of runIds) if (!deliveriesShown.has(runId)) { const card = deliveries(runId); if (card) items.push(card) }
      if (artifactIndex.error) items.push(<p key="artifact-error" role="alert">{artifactIndex.error}</p>)
    }
    return items
  }
  return <main className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${workbenchOpen ? 'workbench-open' : ''}`}>
    {surfaceMode === 'work' && !drawerOpen && <div className="desktop-history">{history}</div>}
    <HostPathPicker open={projectPickerOpen} mode="directory" allowCreateDirectory transport={transport} onCancel={() => setProjectPickerOpen(false)} onConfirm={selection => void createProject(selection.path)} />
    {surfaceMode === 'work' && <Drawer className="pulse-history-drawer" placement="left" size="min(330px,86vw)" open={drawerOpen} onClose={() => { setDrawerOpen(false); drawerTrigger.current?.focus() }} closable={false} destroyOnHidden styles={{ body: { padding: 0 } }}>{drawerOpen && history}</Drawer>}
    <section className="chat">
      <header className={`navbar surface-${surfaceMode} ${detailsOpen ? 'details-open' : ''}`}>
        {surfaceMode === 'work' && <PulseButton ref={drawerTrigger} className="icon-button mobile-menu" onClick={() => setDrawerOpen(true)} aria-label="历史对话"><Icon name="menu"/></PulseButton>}
        {surfaceMode === 'work' && <PulseButton className="icon-button desktop-menu" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开历史对话' : '收起历史对话'}><Icon name="menu"/></PulseButton>}
        {!switchInHistory && modeSwitch}
        <div className="navbar-title"><span className={`status-dot ${paired ? '' : 'offline'}`} /><span className="title-text" title={surfaceMode === 'chat' ? 'Pulse 助理' : selected?.title ?? '新工作会话'}>{surfaceMode === 'chat' ? 'Pulse 助理' : selected?.title ?? '新工作会话'}</span></div>
        <div className="navbar-actions">{surfaceMode === 'work' && !mobileLayout && transfer.exportButton}{surfaceMode === 'chat' && <PulseButton className="details-button" aria-label="设置" title="设置" onClick={() => { openPage('/settings'); setDrawerOpen(false) }}><Icon name="settings"/><span>设置</span></PulseButton>}{running && <span className="running-pill"><i />{surfaceMode === 'chat' ? '正在回复' : '运行中'}</span>}{surfaceMode === 'work' && <><PulseButton className={`workbench-trigger ${workbenchOpen ? 'active' : ''}`} onClick={() => { patchQuery({ workspace: workbenchOpen ? undefined : 'files', details: undefined }) }} aria-expanded={workbenchOpen} aria-label="工作区" title="工作区"><Icon name="folder"/><span>工作区</span></PulseButton></>}<Popover open={detailsOpen} onOpenChange={open => { patchQuery({ details: open }) }} trigger="click" placement="bottomRight" content={detailsPanel} styles={{ container: { padding: 0 } }}><PulseButton className={`details-button ${detailsOpen ? 'active' : ''}`} aria-label="对话详情" aria-expanded={detailsOpen} title="对话详情"><Icon name="info"/><span>详情</span></PulseButton></Popover></div>

      </header>
      {!serviceConnected && window.pulseDesktop && <div className="alert" role="status"><span>后台服务未连接，仍可浏览本地记录。</span><PulseButton onClick={() => { void apiJson(transport, '/api/desktop/reconnect', jsonRequest('POST')).then(() => bootstrap()).catch(() => setToast('暂时无法连接后台服务')) }}>重新连接</PulseButton></div>}
      {loadError && <div className="alert" role="alert"><span>{loadError}</span><PulseButton onClick={() => { if (paired) setRouteRevision(value => value + 1); else void bootstrap() }}>重试</PulseButton></div>}
      <section ref={messagesEl} className={`messages ${emptyConversation ? 'is-empty' : ''}`} aria-live="polite" aria-label="聊天消息" onScroll={event => { const el = event.currentTarget; const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96; followBottom.current = bottom; setAtBottom(bottom) }}>
        {loading && <div className="empty"><span className="spinner" />正在加载对话…</div>}
        {!loading && emptyConversation && paired && <div className="empty"><div className="empty-mark"><Icon name="spark" size={27}/></div><h1>我们要做什么？</h1><p>在 Pulse 工作区中提问或交代任务。</p></div>}
      {olderCursor && <PulseButton onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? '加载中…' : '加载更早消息'}</PulseButton>}
      <WindowedMessages items={renderMessages()} container={messagesEl} follow={followBottom} />
      </section>
      {!atBottom && <PulseButton className="jump-bottom" onClick={() => { followBottom.current = true; setAtBottom(true); messagesEl.current?.scrollTo({ top: messagesEl.current.scrollHeight, behavior: 'smooth' }) }}>回到底部 ↓</PulseButton>}
      <footer className={`composer-wrap ${activeInteraction ? 'has-interaction' : ''} ${emptyConversation && !activeInteraction ? 'is-empty' : ''}`}>
        {activeInteraction ? <InteractionPanel key={`${activeInteraction.runId}:${activeInteraction.groupId}`} interaction={activeInteraction} context={activeInteraction.conversationId ? `${projects.find(project => project.id === activeInteraction.projectId)?.name ?? (activeInteraction.projectId ? '工作项目' : '未分组工作会话')} · ${activeInteraction.conversationTitle ?? '工作会话'}` : undefined} reviewNote={reviewNote} delegated={approvalPolicy === 'delegate'} running={activeInteraction.conversationId ? true : running} stopping={stopping} stop={() => void (activeInteraction.conversationId ? stopRunFor(activeInteraction.runId, activeInteraction.conversationId) : stopRun())} submit={answers => answer(activeInteraction.runId, activeInteraction.groupId, answers, activeInteraction.conversationId ?? selected?.id)} setApprovalPolicy={setApprovalPolicy} /> : <><RichComposer key={selectedId ?? 'new'} id="composer" draft={drafts[selectedId ?? 'new'] ?? emptyComposerDraft()} onChange={update => updateDraft(selectedId ?? 'new', update)} placeholder={paired ? '给 Pulse 发送消息…' : '请先授权此设备'} disabled={!paired || !serviceConnected || loading || Boolean(loadError)} submitting={submitting} running={running} stopping={stopping} surfaceMode={surfaceMode} projectId={selected?.projectId ?? selectedProjectId} transport={transport} onSend={async payload => await send(payload) === true} onStop={() => void stopRun()} toolbarExtra={composerApproval} /></>}
        <div className={`composer-meta ${route.newWork ? 'new-chat-tools' : ''}`}>
          {activeInteraction && composerApproval}
          {route.newWork ? <div className="new-conversation-project"><Icon name="folder"/><Select variant="borderless" aria-label="新对话所属项目" value={selectedProjectId ?? '__ungrouped__'} onChange={value => { const projectId = value === '__ungrouped__' ? undefined : value; patchQuery({ project: projectId }); setSelectedProjectId(projectId); if (projectId) window.localStorage.setItem('pulse-web-project', projectId); else window.localStorage.removeItem('pulse-web-project') }} options={[{ value: '__ungrouped__', label: '不归属项目' }, ...projects.map(project => ({ value: project.id, label: project.name }))]} popupMatchSelectWidth={false} /></div> : !activeInteraction && <div className="composer-hint">Pulse 可能会出错，请核对重要信息。</div>}
        </div>
      </footer>
    </section>
    {workbenchOpen && <Suspense fallback={<div className="workbench-loading" role="status">正在打开工作区…</div>}><WorkbenchPanel project={projects.find(project => project.id === (selected?.projectId ?? selectedProjectId))} transport={transport} localAdmin={sessionCapabilities.localAdmin} canUseTerminal={sessionCapabilities.canUseTerminal} tab={workbenchTab} setTab={setWorkbenchTab} position={route.query} onNavigate={patchQuery} onClose={() => setWorkbenchOpen(false)} /></Suspense>}
    {surfaceMode === 'work' && transfer.dialog}
    {toast && <PulseToast text={toast} />}
  </main>
}

function snapshotStatus(snapshot: WebRunSnapshot): RunStatus[] {
  const items: RunStatus[] = []
  if (snapshot.status) items.push({ kind: 'status', label: snapshot.status.data.label ?? '正在处理' })
  if (snapshot.reviewNote) items.push({ kind: 'review', label: snapshot.reviewNote })
  for (const activity of snapshot.activities) items.push({ kind: 'tool', activityId: activity.data.activityId, label: readableTool(activity.data.tool), state: activity.data.status })
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
  const options = (Array.isArray(input.options) ? input.options as Array<string | { value: string; label?: string; description?: string }> : []).filter(option => typeof option === 'string' ? option.trim() : option.value?.trim() && (option.label ?? option.value).trim())
  const selected = item ? answers[item.effectId] : undefined
  const persist = (next: Record<string, InteractionAnswer>) => { setAnswers(next); localStorage.setItem(key, JSON.stringify(next)); setError('') }
  const answerValid = (question: { effectId: string; input: Record<string, unknown> }) => {
    const answer = answers[question.effectId]
    if (answer && 'text' in answer) return Boolean(answer.text.trim()) && answer.text.length <= 4000
    if (question.input.type === 'choice') return Boolean(answer && 'value' in answer && answer.value.length > 0)
    if (question.input.type === 'multi') {
      const values = answer && 'values' in answer ? answer.values : []
      const min = typeof question.input.min === 'number' ? question.input.min : 0
      const max = typeof question.input.max === 'number' ? question.input.max : Number.POSITIVE_INFINITY
      return values.length >= min && values.length <= max
    }
    return false
  }
  const updateCurrent = (value: InteractionAnswer) => { if (item) persist({ ...answers, [item.effectId]: value }) }
  const submitBatch = async (values: Array<{ effectId: string; value: Record<string, unknown> }>) => {
    if (sending) return
    setSending(true); setError('')
    try {
      if (await submit(values)) localStorage.removeItem(key)
      else setError('提交失败，答案已保留；请检查连接后重试。')
    } catch { setError('提交失败，内容已保留；请检查连接后重试。') } finally { setSending(false) }
  }
  if (interaction.interactionKind === 'approval') {
    const approvalItem = interaction.items[0]
    const approvalInput = approvalItem?.input ?? {}
    const tools = Array.isArray(approvalInput.tools) ? approvalInput.tools as Array<{ toolName?: string; details?: Record<string, unknown> }> : []
    const approve = () => void submitBatch([{ effectId: approvalItem!.effectId, value: { approved: true } }])
    const deny = () => void submitBatch([{ effectId: approvalItem!.effectId, value: { approved: false, reason: '用户拒绝' } }])
    return <section className="interaction-panel approval-panel" aria-label="待审批操作">
      <div className="interaction-heading"><strong>需要你的确认</strong>{delegated && <span className="delegate-state">全局自动审核</span>}</div>{context && <small className="interaction-context">{context}</small>}
      <p>{typeof approvalInput.prompt === 'string' ? approvalInput.prompt : 'Pulse 需要你确认以下操作。'}{typeof approvalInput.operationCount === 'number' ? ` 共 ${approvalInput.operationCount} 项操作。` : ''}</p>
      <div className="approval-operations">{tools.map((tool, i) => <div className="approval-operation" key={`${tool.toolName}-${i}`}><strong>{readableTool(tool.toolName ?? '')}</strong>{typeof tool.details?.path === 'string' && <code>{tool.details.path}</code>}{typeof tool.details?.command === 'string' && <code>{tool.details.command}</code>}</div>)}</div>
      {tools.some(tool => Object.keys(tool.details ?? {}).some(key => key !== 'path' && key !== 'command')) && <PulseDisclosure className="technical-details" label={"更多操作细节"}>{tools.map((tool, i) => <pre key={i}>{JSON.stringify(tool.details, null, 2)}</pre>)}</PulseDisclosure>}
      {reviewNote && <p className="review-note" role="status">{reviewNote}</p>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <div className="interaction-actions"><PulseButton type="button" className="primary" disabled={sending || policyPending} onClick={approve}>允许本次</PulseButton><PulseButton type="button" className="secondary" disabled={sending || policyPending} onClick={deny}>拒绝</PulseButton><ApprovalPolicySelect value={delegated ? 'delegate' : 'manual'} disabled={sending || policyPending} onChange={async policy => { setPolicyPending(true); try { if (!await setApprovalPolicy(policy)) setError('审核模式切换失败，请重试。') } finally { setPolicyPending(false) } }} />{running && <PulseButton type="button" className="stop-button" disabled={stopping || policyPending} onClick={stop}>{stopping ? '正在停止…' : '停止任务'}</PulseButton>}</div>
    </section>
  }
  const count = interaction.items.length
  const sendAsk = () => void submitBatch(interaction.items.map(question => ({ effectId: question.effectId, value: (answers[question.effectId] ?? (question.input.type === 'multi' ? { values: [] } : {})) as Record<string, unknown> })))
  return <section className="interaction-panel ask-panel" aria-label="待回答问题">
    <div className="interaction-heading"><strong>需要你的回答</strong><span>第 {review ? count : index + 1} / {count} 题{review ? ' · 答案确认' : ''}</span></div>{context && <small className="interaction-context">{context}</small>}
    <div className="question-scroll">
      {review ? <div className="answer-overview">{interaction.items.map((question, i) => <article key={question.effectId}><div><strong>{i + 1}. {String(question.input.prompt ?? '请回答')}</strong><PulseButton type="button" onClick={() => { setIndex(i); setReview(false) }}>修改</PulseButton></div><p>{formatInteractionAnswer(answers[question.effectId], question.input)}</p></article>)}</div> : <>
        <h3>{String(input.prompt ?? '请回答')}</h3>
        {typeof input.context === 'string' && input.context && <p className="question-background">{input.context}</p>}
        {input.type === 'choice' && <div className="question-options">{options.map(option => { const choice = typeof option === 'string' ? { value: option, label: option } : option; const active = Boolean(selected && 'value' in selected && selected.value === choice.value); return <PulseButton type="button" className={active ? 'selected' : ''} disabled={sending} key={choice.value} onClick={() => updateCurrent({ value: choice.value })}><strong>{choice.label ?? choice.value}</strong>{choice.description && <span className="question-option-description">{choice.description}</span>}</PulseButton> })}</div>}
        {input.type === 'multi' && <><p className="question-hint">可多选{typeof input.min === 'number' && input.min > 0 ? `，至少 ${input.min} 项` : ''}{typeof input.max === 'number' ? `，最多 ${input.max} 项` : ''}</p><div className="question-options multi">{options.map(option => { const choice = typeof option === 'string' ? { value: option, label: option } : option; const current = selected && 'values' in selected ? selected.values : []; const max = typeof input.max === 'number' ? input.max : Number.POSITIVE_INFINITY; const atLimit = !current.includes(choice.value) && current.length >= max; return <div key={choice.value}><PulseCheckbox  disabled={sending || atLimit} checked={current.includes(choice.value)} onChange={() => updateCurrent({ values: current.includes(choice.value) ? current.filter(value => value !== choice.value) : [...current, choice.value] })}><strong>{choice.label ?? choice.value}</strong>{choice.description && <span className="question-option-description">{choice.description}</span>}</PulseCheckbox></div> })}</div></>}
        {(input.type === 'choice' || input.type === 'multi') && <label className="question-custom"><span>自行回答</span><PulseTextArea aria-label="自行回答" maxLength={4000} rows={3} value={selected && 'text' in selected ? selected.text : ''} disabled={sending} placeholder="也可以直接输入你的答案…" onChange={event => updateCurrent({ text: event.target.value })} /></label>}
        {input.type === 'input' && <PulseTextArea aria-label="你的答案" maxLength={4000} rows={4} className="question-input" value={selected && 'text' in selected ? selected.text : typeof input.defaultValue === 'string' ? input.defaultValue : ''} disabled={sending} placeholder={typeof input.placeholder === 'string' ? input.placeholder : '请输入'} onChange={event => updateCurrent({ text: event.target.value })} />}
      </>}
    </div>
    {error && <p className="interaction-error" role="alert">{error}</p>}
    <div className="interaction-actions ask-actions">{review ? <><PulseButton type="button" className="secondary" disabled={sending} onClick={() => { setReview(false); setIndex(count - 1) }}>返回修改</PulseButton><PulseButton type="button" className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={sendAsk}>{sending ? '正在提交…' : '统一提交'}</PulseButton></> : <><PulseButton type="button" className="secondary" disabled={sending || index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>上一题</PulseButton>{index < count - 1 ? <PulseButton type="button" className="primary" disabled={sending || !item || !answerValid(item)} onClick={() => setIndex(value => value + 1)}>下一题</PulseButton> : <PulseButton type="button" className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={() => setReview(true)}>检查答案</PulseButton>}{running && <PulseButton type="button" className="stop-button" disabled={stopping} onClick={stop}>{stopping ? '正在停止…' : '停止任务'}</PulseButton>}</>}</div>
  </section>
}

function formatInteractionAnswer(answer: InteractionAnswer | undefined, input: Record<string, unknown>): string {
  if (!answer) return '尚未填写'
  if ('text' in answer) return answer.text || '（空）'
  const options = (Array.isArray(input.options) ? input.options as Array<string | { value: string; label?: string; description?: string }> : []).filter(option => typeof option === 'string' ? option.trim() : option.value?.trim() && (option.label ?? option.value).trim())
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
