import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react'
import { ApiError, apiJson, browserTransport, jsonRequest } from './transport.js'
import type { ConversationList, MessageList, PulseWebTransport, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from './transport.js'
import { Dropdown, Select } from 'antd'
import { MessageBubble } from './MessageBubble.js'
import { copyText } from './clipboard.js'
import { SettingsPage } from './SettingsPage.js'
import { ArchivePage } from './ArchivePage.js'
import { Icon } from './Icon.js'
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
  const [surfaceMode, setSurfaceMode] = useState<'chat' | 'work'>('chat')
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
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [status, setStatus] = useState<RunStatus[]>([])
  const [reviewNote, setReviewNote] = useState('')
  const [draft, setDraft] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newApprovalPolicy, setNewApprovalPolicy] = useState<'manual' | 'delegate'>('manual')
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [editingTitle, setEditingTitle] = useState('')
  const [menuId, setMenuId] = useState<string>()
  const menuIdRef = useRef(menuId)
  menuIdRef.current = menuId
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [effectiveModel, setEffectiveModel] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [workbenchTab, setWorkbenchTab] = useState<'files' | 'git' | 'preview' | 'terminal'>('files')
  const [runPanelOpen, setRunPanelOpen] = useState(false)
  const [selectedLaneId, setSelectedLaneId] = useState<string>()
  const [sessionCapabilities, setSessionCapabilities] = useState<{ localAdmin: boolean; canUseTerminal: boolean }>({ localAdmin: false, canUseTerminal: false })
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(() => { try { return JSON.parse(window.localStorage.getItem('pulse-web-collapsed-projects') ?? '[]') as string[] } catch { return [] } })
  const [atBottom, setAtBottom] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [resumingRunId, setResumingRunId] = useState<string>()
  const [pairing, setPairing] = useState<{ code: string; pairUrl: string; qrSvg: string; devices: Device[] }>()
  const [pairError, setPairError] = useState('')
  const [toast, setToast] = useState('')
  const eventClose = useRef<(() => void) | undefined>(undefined)
  const streamRunRef = useRef<string | undefined>(undefined)
  const assistantIdRef = useRef<string | undefined>(undefined)
  const requestId = useRef(0)
  const bootstrapStarted = useRef(false)
  const sendLock = useRef(false)
  const messagesEl = useRef<HTMLElement>(null)
  const composerEl = useRef<HTMLTextAreaElement>(null)
  const drawerTrigger = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedIdRef = useRef<string | undefined>(undefined)
  selectedIdRef.current = selectedId
  const selected = surfaceMode === 'chat' ? assistantConversation : conversations.find(item => item.id === selectedId)
  const isPairPage = window.location.pathname === '/pair'
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

  const openConversation = useCallback(async (conversation: WebConversation, saveSelection = true) => {
    setSurfaceMode('work')
    window.localStorage.setItem('pulse-web-surface', 'work')
    const id = ++requestId.current
    eventClose.current?.(); eventClose.current = undefined
    selectedIdRef.current = conversation.id
    setSelectedId(conversation.id)
    setSelectedProjectId(conversation.projectId)
    if (conversation.projectId) window.localStorage.setItem('pulse-web-project', conversation.projectId)
    else window.localStorage.removeItem('pulse-web-project')
    setDrawerOpen(false); setMenuId(undefined); setLoadError(''); setStatus([]); setReviewNote('')
    setRunPanelOpen(false); setSelectedLaneId(undefined)
    setRunning(false); setStopping(false); setResumingRunId(undefined)
    if (saveSelection) window.localStorage.setItem(historyStorageKey, conversation.id)
    setDraft(drafts[conversation.id] ?? '')
    try {
      const result = await apiJson<MessageList>(transport, `/api/web/conversations/${encodeURIComponent(conversation.id)}/messages`)
      if (requestId.current !== id || selectedIdRef.current !== conversation.id) return
      setMessages(result.filter(message => message.role !== 'system'))
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
  }, [drafts, transport])

  const loadAssistant = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setLoadError('')
    try {
      const [view, projectList] = await Promise.all([
        apiJson<{ conversation: WebConversation; messages: MessageList; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[] }>(transport, '/api/assistant'),
        apiJson<WebProject[]>(transport, '/api/projects').catch(() => [] as WebProject[]),
      ])
      assistantIdRef.current = view.conversation.id
      const active = [...view.receipts].reverse().find(item => item.state === 'replying')
      const { activeRunId: _storedActiveRunId, ...assistantSummary } = view.conversation
      setAssistantConversation({ ...assistantSummary, ...(active ? { activeRunId: active.runId } : {}), kind: 'assistant' })
      setAssistantReceipts(view.receipts)
      setWorkInteractions(view.workInteractions.map(interaction => ({ kind: 'interaction', runId: interaction.runId, conversationId: interaction.conversationId, conversationTitle: interaction.title, ...(interaction.projectId ? { projectId: interaction.projectId } : {}), approvalPolicy: interaction.approvalPolicy, groupId: interaction.groupId, interactionKind: interaction.kind, items: interaction.items })))
      setProjects(projectList)
      selectedIdRef.current = view.conversation.id
      setSelectedId(view.conversation.id)
      setMessages(view.messages.filter(message => message.role !== 'system'))
      setDraft(drafts[view.conversation.id] ?? '')
      if (active) setConversations(items => items.map(item => item.id === view.conversation.id ? { ...item, activeRunId: active.runId } : item))
      else setRunning(false)
      window.localStorage.setItem('pulse-web-surface', 'chat')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setPaired(false); setLoadError('此浏览器尚未授权。请在本机重试，或用手机扫码配对。') }
      else setLoadError('Pulse 助理聊天暂时无法加载，请检查连接后重试。')
    } finally { if (showLoading) setLoading(false) }
  }, [drafts, transport])

  const loadHistory = useCallback(async (preferred?: string) => {
    setLoading(true); setLoadError('')
    try {
      const list = await apiJson<ConversationList>(transport, '/api/conversations')
      setConversations(list)
      try {
        const projectList = await apiJson<WebProject[]>(transport, '/api/projects')
        setProjects(projectList)
        const savedProject = window.localStorage.getItem('pulse-web-project') ?? undefined
        setSelectedProjectId(projectList.some(project => project.id === savedProject) ? savedProject : undefined)
      } catch { setProjects([]) }
      const saved = preferred ?? window.localStorage.getItem(historyStorageKey) ?? undefined
      const next = list.find(item => item.id === saved) ?? list[0]
      if (next) {
        if (saved !== next.id) window.localStorage.setItem(historyStorageKey, next.id)
        await openConversation(next, false)
      }
      else {
        requestId.current++
        selectedIdRef.current = undefined
        setSelectedId(undefined); setMessages([]); setStatus([]); setRunning(false)
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setPaired(false); setLoadError('此浏览器尚未授权。请在本机重试，或用手机扫码配对。') }
      else setLoadError('聊天记录暂时无法加载，请检查 Pulse 服务后重试。')
    } finally { setLoading(false) }
  }, [openConversation, transport])

  const refreshDirectory = useCallback(async () => {
    try {
      const [conversationList, projectList] = await Promise.all([
        apiJson<ConversationList>(transport, '/api/conversations'),
        apiJson<WebProject[]>(transport, '/api/projects'),
      ])
      setConversations(conversationList)
      setProjects(projectList)
    } catch { /* Keep the last known directory while the service is temporarily offline. */ }
  }, [transport])

  const bootstrap = useCallback(async () => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    try {
      if (code) {
        await apiJson(transport, '/api/pair', jsonRequest('POST', { code, name: navigator.userAgent.slice(0, 50) }))
        window.history.replaceState({}, '', window.location.pathname)
      } else if (localHost) await apiJson(transport, '/api/session/local', jsonRequest('POST'))
      const session = await apiJson<{ localAdmin?: boolean; canUseTerminal?: boolean }>(transport, '/api/session')
      setSessionCapabilities({ localAdmin: session.localAdmin === true, canUseTerminal: session.canUseTerminal === true })
      setPaired(true)
      await loadAssistant()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setPaired(false); setLoadError('设备尚未授权。请在本机打开 Pulse，或重新扫码配对。') }
      else { setPaired(false); setLoadError('无法连接或验证 Pulse，请检查服务和配对码后重试。') }
    }
  }, [localHost, loadAssistant, transport])

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
    const closePanels = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setDetailsOpen(false); setRunPanelOpen(false) } }
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
    const element = messagesEl.current
    if (element && atBottom) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [atBottom, messages, status])
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
    setSurfaceMode('work')
    window.localStorage.setItem('pulse-web-surface', 'work')
    requestId.current++
    eventClose.current?.(); eventClose.current = undefined
    selectedIdRef.current = undefined
    setSelectedId(undefined); setMessages([]); setStatus([]); setRunning(false); setStopping(false)
    setNewApprovalPolicy('manual')
    setDraft(drafts.new ?? ''); setDrawerOpen(false); setLoadError('')
    window.localStorage.removeItem(historyStorageKey)
    window.setTimeout(() => composerEl.current?.focus(), 0)
  }

  const switchMode = (mode: 'chat' | 'work') => {
    if (surfaceMode === mode) return
    eventClose.current?.(); eventClose.current = undefined; streamRunRef.current = undefined
    setSurfaceMode(mode); window.localStorage.setItem('pulse-web-surface', mode)
    setDrawerOpen(false); setRunPanelOpen(false); setDetailsOpen(false); setWorkbenchOpen(false); setStatus([]); setRunning(false); setStopping(false)
    if (mode === 'chat') void loadAssistant()
    else void loadHistory()
  }

  const startRun = useCallback((runId: string, conversationId: string, after = 0) => {
    eventClose.current?.()
    streamRunRef.current = runId
    if (selectedIdRef.current === conversationId) setRunning(true)
    let lastSeq = after
    const onEvent = (event: WebRunEvent) => {
      if ((event.conversationId && event.conversationId !== conversationId) || event.runId !== runId || event.seq <= lastSeq) return
      lastSeq = event.seq
      if (selectedIdRef.current !== conversationId) return
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
            if (selectedIdRef.current === conversationId) setMessages(view.messages.filter(message => message.role !== 'system'))
          }).catch(() => undefined)
        } else void apiJson<MessageList>(transport, `/api/web/conversations/${encodeURIComponent(conversationId)}/messages`).then(result => {
          if (selectedIdRef.current === conversationId) setMessages(result.filter(message => message.role !== 'system'))
        }).catch(() => undefined)
        if (selectedIdRef.current === conversationId) { setRunning(false); setStopping(false) }
      }
    }
    eventClose.current = transport.subscribe(`/api/runs/${encodeURIComponent(runId)}/events?after=${lastSeq}`, onEvent, () => {
      setToast('连接中断，正在尝试恢复…')
      window.setTimeout(() => setToast(''), 3000)
    })
  }, [transport])

  useEffect(() => {
    if (!paired || surfaceMode !== 'chat') return
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
            const persisted = view.messages.filter(message => message.role !== 'system')
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
  }, [paired, surfaceMode, startRun, transport])

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (surfaceMode === 'chat') {
      if (!text || submitting || sendLock.current || !paired || !assistantConversation) return
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const optimisticId = `msg-${id}`
      sendLock.current = true; setSubmitting(true); setLoadError('')
      setMessages(current => [...current.filter(message => message.id !== optimisticId), { id: optimisticId, role: 'user', text, requestId: id, deliveryState: 'queued', createdAt: new Date().toISOString() }])
      try {
        const receipt = await apiJson<{ conversationId: string; messageId: string; runId: string; state: WebAssistantMessageReceipt['state'] }>(transport, '/api/assistant/messages', jsonRequest('POST', { requestId: id, text }))
        setMessages(current => current.map(message => {
          if (message.id !== optimisticId) return message
          const { deliveryState: _oldDeliveryState, ...rest } = message
          const deliveryState = receipt.state === 'completed' ? undefined : receipt.state === 'failed' ? 'failed' : receipt.state === 'interrupted' ? 'interrupted' : receipt.state === 'queued' ? 'queued' : 'replying'
          return { ...rest, runId: receipt.runId, ...(deliveryState ? { deliveryState } : {}) }
        }))
        setAssistantReceipts(current => [...current.filter(item => item.messageId !== id), { messageId: id, runId: receipt.runId, state: receipt.state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])
        setDraft(''); setDrafts(current => ({ ...current, [assistantConversation.id]: '' }))
        if (receipt.state === 'replying') startRun(receipt.runId, assistantConversation.id)
      } catch (error) {
        setMessages(current => current.map(message => message.id === optimisticId ? { ...message, deliveryState: 'failed' } : message))
        setLoadError(error instanceof ApiError && error.status === 401 ? '此设备授权已失效，请重新配对。' : '消息发送失败，草稿已保留；可从消息旁明确重试。')
      } finally { sendLock.current = false; setSubmitting(false) }
      return
    }
    if (!text || running || submitting || resumingRunId || selected?.activeRunId || sendLock.current || !paired) {
      if (selected?.activeRunId && !running && !resumingRunId) setToast('请先继续任务或结束这轮，再发送新消息。')
      return
    }
    sendLock.current = true; setSubmitting(true); setLoadError('')
    let conversationId = selectedId
    const initialSelection = selectedIdRef.current
    let pendingId = ''
    try {
      if (!conversationId) {
        let created = await apiJson<WebConversation>(transport, '/api/conversations', jsonRequest('POST', { title: text.slice(0, 64), ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }))
        conversationId = created.id
        if (selectedIdRef.current === initialSelection) {
          selectedIdRef.current = conversationId; setSelectedId(conversationId)
          window.localStorage.setItem(historyStorageKey, conversationId)
        }
        setConversations(items => [created, ...items])
        if (newApprovalPolicy === 'delegate') {
          created = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(created.id)}`, jsonRequest('PATCH', { approvalPolicy: 'delegate' }))
          setConversations(items => items.map(item => item.id === created.id ? created : item))
        }
      }
      pendingId = `pending-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
      if (selectedIdRef.current === conversationId) setMessages(current => [...current, { id: pendingId, role: 'user', text, createdAt: new Date().toISOString() }])
      const response = await apiJson<{ runId: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/messages`, jsonRequest('POST', { text }))
      if (selectedIdRef.current === conversationId) {
        setDraft('')
        setDrafts(current => ({ ...current, [conversationId!]: '', new: '' }))
        startRun(response.runId, conversationId)
      }
      setConversations(items => items.map(item => item.id === conversationId ? { ...item, activeRunId: response.runId } : item))
    } catch (error) {
      if (conversationId && selectedIdRef.current === conversationId) setMessages(current => current.filter(message => message.id !== pendingId))
      if (selectedIdRef.current === conversationId) setLoadError(error instanceof ApiError && error.status === 401 ? '此设备授权已失效，请重新配对。' : '消息发送失败，草稿已保留；请检查状态后再试。')
    } finally { sendLock.current = false; setSubmitting(false) }
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

  const retryAssistantMessage = async (message: WebMessage) => {
    if (!message.requestId || submitting || !assistantConversation) return
    setSubmitting(true)
    try {
      const receipt = await apiJson<{ conversationId: string; messageId: string; runId: string; state: WebAssistantMessageReceipt['state'] }>(transport, '/api/assistant/messages', jsonRequest('POST', { requestId: message.requestId, text: message.text, retry: true }))
      setMessages(items => items.map(item => {
        if (item.id !== message.id) return item
        const { deliveryState: _oldDeliveryState, ...rest } = item
        const deliveryState = receipt.state === 'failed' ? 'failed' : receipt.state === 'interrupted' ? 'interrupted' : receipt.state === 'queued' ? 'queued' : receipt.state === 'replying' ? 'replying' : undefined
        return { ...rest, runId: receipt.runId, ...(deliveryState ? { deliveryState } : {}) }
      }))
      setAssistantReceipts(items => [...items.filter(item => item.messageId !== message.requestId), { messageId: message.requestId!, runId: receipt.runId, state: receipt.state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])
      setDraft(current => current === message.text ? '' : current)
      setDrafts(current => ({ ...current, [assistantConversation.id]: current[assistantConversation.id] === message.text ? '' : current[assistantConversation.id] ?? '' }))
      if (receipt.state === 'replying') startRun(receipt.runId, assistantConversation.id)
    } catch { setToast('仍无法发送；原消息和草稿已保留。') }
    finally { setSubmitting(false) }
  }

  const openWorkNotice = async (conversationId: string) => {
    try {
      const list = await apiJson<ConversationList>(transport, '/api/conversations')
      const conversation = list.find(item => item.id === conversationId)
      if (!conversation) { setToast('工作会话暂时不可用，记录仍保留在助理聊天中。'); return }
      setConversations(list)
      await openConversation(conversation)
    } catch { setToast('暂时无法打开工作会话。') }
  }

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
    if (!window.confirm('结束这轮任务？聊天和运行记录会保留，但不会继续执行。')) return
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
    if (!cwd) cwd = window.prompt('输入本机已有目录的绝对路径')?.trim() ?? ''
    if (!cwd) return
    const fallback = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '新项目'
    const name = window.prompt('项目名称', fallback)?.trim()
    if (!name) return
    try {
      const project = await apiJson<WebProject>(transport, '/api/projects', jsonRequest('POST', { name, cwd }))
      setProjects(items => [project, ...items.filter(item => item.id !== project.id)])
      setSelectedProjectId(project.id); window.localStorage.setItem('pulse-web-project', project.id)
      createConversation()
      setToast('项目已添加；磁盘目录保持不变。')
    } catch (error) { setToast(error instanceof ApiError && error.status === 409 ? '该目录已经登记。' : '项目添加失败，请检查目录路径。') }
  }

  const renameProject = async (project: WebProject) => {
    const name = window.prompt('项目名称', project.name)?.trim()
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
    if (!window.confirm(`移除项目“${project.name}”？对话会归档，目录和文件不会删除。`)) return
    try {
      await apiJson(transport, `/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })
      setProjects(items => items.filter(item => item.id !== project.id))
      setConversations(items => items.filter(item => item.projectId !== project.id))
      if (selectedProjectId === project.id) { setSelectedProjectId(undefined); window.localStorage.removeItem('pulse-web-project'); createConversation() }
      setToast('项目已移除，对话已归档，目录文件仍保留。')
    } catch (error) { setToast(error instanceof ApiError && error.status === 409 ? '项目中有运行中或待恢复的对话，暂时不能移除。' : '项目移除失败。') }
  }

  const selectProject = (projectId?: string) => {
    setSelectedProjectId(projectId)
    if (projectId) window.localStorage.setItem('pulse-web-project', projectId)
    else window.localStorage.removeItem('pulse-web-project')
    createConversation()
  }

  const deleteConversation = async (conversation: WebConversation) => {
    if (conversation.activeRunId) { setToast('运行中的对话不能删除。'); return }
    if (!window.confirm(`删除“${conversation.title}”？此操作无法撤销。`)) return
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
  const visibleConversations = useMemo(() => conversations.filter(item => `${item.title} ${item.cwd} ${projects.find(project => project.id === item.projectId)?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [conversations, projects, query])
  const orderedProjects = useMemo(() => [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))), [projects])
  const ungroupedConversations = visibleConversations.filter(item => !projects.some(project => project.id === item.projectId))
  const pinnedConversations = ungroupedConversations.filter(item => item.pinned)
  const groupedHistory = groupConversations(ungroupedConversations.filter(item => !item.pinned))
  const conversationRows = (items: WebConversation[]) => items.map(conversation => <div key={conversation.id} className={`history-row ${conversation.id === selectedId ? 'selected' : ''}`}>
    {editingId === conversation.id ? <form className="rename-form" onSubmit={event => { event.preventDefault(); void renameConversation(conversation) }}><input value={editingTitle} autoFocus maxLength={80} onChange={event => setEditingTitle(event.target.value)} aria-label="对话标题" /><button aria-label="保存标题">✓</button><button type="button" aria-label="取消重命名" onClick={() => setEditingId(undefined)}>×</button></form> : <>
      <button className="history-item" title={conversation.title} onClick={() => void openConversation(conversation)}><span>{conversation.title || '新对话'}</span>{conversation.pinned && <small className="history-pin" aria-label="已置顶">置顶</small>}{conversation.activeRunId && <i aria-label="运行状态待确认" />}</button>
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
      }}><button className="row-menu-button" aria-label={`对话操作：${conversation.title}`} aria-expanded={menuId === conversation.id}><Icon name="more"/></button></Dropdown>
    </>}
  </div>)
  const history = <aside className="history" aria-label="历史对话">
    <div className="history-head"><strong>Pulse</strong><button className="new-button" onClick={createConversation} aria-label="新建对话"><Icon name="plus"/> <span>新对话</span></button></div>
    <div className="history-primary"><button onClick={() => selectProject(undefined)}><Icon name="home"/> <span>全部对话</span></button></div>
    <label className="history-search"><Icon name="search"/><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索对话" /><kbd>⌘ K</kbd></label>
    <div className="history-list">
      <section className="project-nav-group"><header><button className="project-nav-heading" aria-expanded={!collapsedProjectIds.includes('projects') || Boolean(query.trim())} onClick={() => setProjectCollapsed('projects', !collapsedProjectIds.includes('projects'))}><Icon className={collapsedProjectIds.includes('projects') && !query.trim() ? 'is-collapsed' : ''} name="chevron"/> 项目</button><button className="project-add" disabled={!sessionCapabilities.localAdmin} title="添加本机项目" onClick={() => void createProject()}><Icon name="plus"/></button></header>{(!collapsedProjectIds.includes('projects') || query.trim()) && <>
        {orderedProjects.map((project, index) => {
          const items = visibleConversations.filter(item => item.projectId === project.id).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
          if (query.trim() && !items.length && !project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return null
          const expanded = !collapsedProjectIds.includes(project.id) || Boolean(query.trim())
          return <section className="project-history" key={project.id} aria-label={`${project.name}项目对话`}>
            <div className={`project-nav-row ${selectedProjectId === project.id ? 'selected' : ''}`}>
              <button title={project.cwd} aria-label={`${expanded ? '折叠' : '展开'}项目：${project.name}`} aria-expanded={expanded} onClick={() => setProjectCollapsed(project.id, expanded)}><Icon className={`project-chevron ${expanded ? '' : 'is-collapsed'}`} name="chevron"/><span className="project-glyph"><Icon name="folder"/></span><span className="project-name">{project.name}</span>{!project.available && <small>不可用</small>}<small className="project-count">{items.length}</small></button>
              <button className="project-new-button" aria-label={`在${project.name}中新建对话`} disabled={!project.available} onClick={() => { setProjectCollapsed(project.id, false); selectProject(project.id) }}><Icon name="plus"/></button>
              <Dropdown destroyOnHidden trigger={['click']} open={menuId === project.id} onOpenChange={open => setMenuId(open ? project.id : undefined)} menu={{ items: [
                { key: 'rename', label: '重命名', onClick: () => void renameProject(project) },
                { key: 'pin', label: project.pinned ? '取消置顶' : '置顶项目', onClick: () => void toggleProjectPinned(project) },
                { key: 'up', label: '上移', disabled: index === 0, onClick: () => void reorderProject(project, -1) },
                { key: 'down', label: '下移', disabled: index === orderedProjects.length - 1, onClick: () => void reorderProject(project, 1) },
                { type: 'divider' },
                { key: 'remove', label: '移除并归档', danger: true, onClick: () => void removeProject(project) },
              ], onClick: () => setMenuId(undefined) }}><button className="project-menu-button" aria-label={`项目操作：${project.name}`} aria-expanded={menuId === project.id}><Icon name="more"/></button></Dropdown>
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
    <div className="history-foot"><button onClick={() => { setArchiveOpen(true); setSettingsOpen(false); setDrawerOpen(false) }}><Icon name="archive"/><span>归档对话</span></button><button onClick={() => { setSettingsOpen(true); setArchiveOpen(false); setDrawerOpen(false) }}><Icon name="settings"/><span>设置</span></button></div>
  </aside>

  if (isPairPage) return <PairingPage pairing={pairing} error={pairError} refresh={loadPairing} transport={transport} />
  if (settingsOpen) return <SettingsPage transport={transport} canEditConfig={sessionCapabilities.localAdmin} onClose={() => setSettingsOpen(false)} onOpenArchive={() => { setSettingsOpen(false); setArchiveOpen(true) }} />
  if (archiveOpen) return <ArchivePage transport={transport} onBack={() => setArchiveOpen(false)} onChanged={() => { void apiJson<ConversationList>(transport, '/api/conversations').then(setConversations); void refreshProjects() }} onOpen={conversation => { setConversations(items => [conversation, ...items.filter(item => item.id !== conversation.id)]); setArchiveOpen(false); void openConversation(conversation) }} />

  return <main className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${workbenchOpen ? 'workbench-open' : ''}`}>
    {surfaceMode === 'work' && !drawerOpen && <div className="desktop-history">{history}</div>}
    {surfaceMode === 'work' && drawerOpen && <button className="scrim" aria-label="关闭历史对话" onClick={() => { setDrawerOpen(false); drawerTrigger.current?.focus() }} />}
    {surfaceMode === 'work' && drawerOpen && <div className="drawer">{history}</div>}
    <section className="chat">
      <header className={`navbar surface-${surfaceMode} ${detailsOpen ? 'details-open' : ''}`}>
        {surfaceMode === 'work' && <button ref={drawerTrigger} className="icon-button mobile-menu" onClick={() => setDrawerOpen(true)} aria-label="历史对话"><Icon name="menu"/></button>}
        {surfaceMode === 'work' && <button className="icon-button desktop-menu" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开历史对话' : '收起历史对话'}><Icon name="menu"/></button>}
        <div className="surface-switch" role="tablist" aria-label="Pulse 工作模式"><button role="tab" aria-selected={surfaceMode === 'chat'} className={surfaceMode === 'chat' ? 'active' : ''} onClick={() => switchMode('chat')}>聊天</button><button role="tab" aria-selected={surfaceMode === 'work'} className={surfaceMode === 'work' ? 'active' : ''} onClick={() => switchMode('work')}>工作</button></div>
        <div className="navbar-title"><span className={`status-dot ${paired ? '' : 'offline'}`} /><span className="title-text" title={surfaceMode === 'chat' ? 'Pulse 助理' : selected?.title ?? '新工作会话'}>{surfaceMode === 'chat' ? 'Pulse 助理' : selected?.title ?? '新工作会话'}</span></div>
        <div className="navbar-actions">{selected?.approvalPolicy === 'delegate' && surfaceMode === 'work' && <button className="delegate-pill" onClick={() => void setApprovalPolicy('manual')} aria-label="切回人工审批">代审中 · 切回人工</button>}{running && <span className="running-pill"><i />{surfaceMode === 'chat' ? '正在回复' : '运行中'}</span>}{surfaceMode === 'work' && <><button className={`run-trigger ${running ? 'is-running' : ''} ${runPanelOpen ? 'active' : ''}`} onClick={() => { setRunPanelOpen(value => !value); setDetailsOpen(false) }} aria-expanded={runPanelOpen} aria-label="任务状态"><Icon name="activity"/><span>任务</span></button><button className={`workbench-trigger ${workbenchOpen ? 'active' : ''}`} onClick={() => { setWorkbenchOpen(value => !value); setDetailsOpen(false) }} aria-expanded={workbenchOpen}><Icon name="folder"/><span>工作区</span></button></>}<button className={`details-button ${detailsOpen ? 'active' : ''}`} onClick={() => { setDetailsOpen(value => !value); setRunPanelOpen(false) }} aria-label="对话详情" aria-expanded={detailsOpen} title="对话详情"><Icon name="info"/><span>详情</span></button></div>
        {detailsOpen && <><button className="popover-scrim" aria-label="关闭对话详情" onClick={() => setDetailsOpen(false)} /><section className="details-popover" role="dialog" aria-label="对话详情"><header><div><strong>对话详情</strong><small>当前会话与工作区信息</small></div><button className="icon-button" onClick={() => setDetailsOpen(false)} aria-label="关闭"><Icon name="close"/></button></header><div className="detail-group"><small>项目</small><strong>{projects.find(project => project.id === selected?.projectId)?.name ?? (selected?.projectId ? '项目不可用' : '未分组对话')}</strong></div><div className="detail-group"><small>工作目录</small><code title={selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd}>{selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd ?? '发送首条消息后确定'}</code><button className="detail-copy" onClick={() => void copyText(selected?.cwd ?? projects.find(project => project.id === selectedProjectId)?.cwd ?? '')} disabled={!selected?.cwd && !selectedProjectId}><Icon name="copy"/>复制路径</button></div><div className="detail-group"><small>默认模型</small><strong>{effectiveModel ?? (sessionCapabilities.localAdmin ? '当前配置未返回实际模型' : '本机管理会话可查看')}</strong><span>这是服务端默认模型；单次任务若有独立路由，以任务路由为准。</span></div><div className="detail-group"><small>审批方式</small><strong>{selected?.approvalPolicy === 'delegate' ? '本会话代审中' : '由用户逐项审批'}</strong><span>审批设置仅影响当前会话。</span></div></section></>}
      </header>
      {runPanelOpen && <RunCard status={status} running={running} {...(selected?.activeRunId ? { runId: selected.activeRunId } : {})} resuming={Boolean(resumingRunId)} resume={resumeInterruptedRun} endInterrupted={endInterruptedRun} selectedLaneId={selectedLaneId} onSelectLane={setSelectedLaneId} onClose={() => setRunPanelOpen(false)} />}
      {loadError && <div className="alert" role="alert"><span>{loadError}</span><button onClick={() => void bootstrap()}>重试</button></div>}
      <section ref={messagesEl} className={`messages ${messages.length === 0 ? 'is-empty' : ''}`} aria-live="polite" aria-label="聊天消息" onScroll={event => { const el = event.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 96) }}>
        {loading && <div className="empty"><span className="spinner" />正在加载对话…</div>}
        {!loading && messages.length === 0 && paired && <div className="empty"><div className="empty-mark"><Icon name="spark" size={27}/></div><h1>我们要做什么？</h1><p>在 Pulse 工作区中提问或交代任务。</p></div>}
      {messages.map(message => <MessageBubble key={`${selectedId}:${message.id}`} mode={surfaceMode} message={message} retry={() => void retryAssistantMessage(message)} onOpenWork={openWorkNotice} />)}
      </section>
      {!atBottom && <button className="jump-bottom" onClick={() => { setAtBottom(true); messagesEl.current?.scrollTo({ top: messagesEl.current.scrollHeight, behavior: 'smooth' }) }}>回到底部 ↓</button>}
      <footer className={`composer-wrap ${activeInteraction ? 'has-interaction' : ''} ${messages.length === 0 && !activeInteraction ? 'is-empty' : ''}`}>
        {activeInteraction ? <InteractionPanel key={`${activeInteraction.runId}:${activeInteraction.groupId}`} interaction={activeInteraction} context={activeInteraction.conversationId ? `${projects.find(project => project.id === activeInteraction.projectId)?.name ?? (activeInteraction.projectId ? '工作项目' : '未分组工作会话')} · ${activeInteraction.conversationTitle ?? '工作会话'}` : undefined} reviewNote={reviewNote} delegated={(activeInteraction.approvalPolicy ?? selected?.approvalPolicy) === 'delegate'} running={activeInteraction.conversationId ? true : running} stopping={stopping} stop={() => void (activeInteraction.conversationId ? stopRunFor(activeInteraction.runId, activeInteraction.conversationId) : stopRun())} submit={answers => answer(activeInteraction.runId, activeInteraction.groupId, answers, activeInteraction.conversationId ?? selected?.id)} setApprovalPolicy={policy => setApprovalPolicy(policy, activeInteraction.conversationId ?? selected?.id)} /> : <><form className="composer" onSubmit={event => void send(event)}><textarea ref={composerEl} id="composer" value={draft} onChange={event => { setDraft(event.target.value); setDrafts(current => ({ ...current, [selectedId ?? 'new']: event.target.value })); const el = event.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 176)}px` }} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { const mobile = window.matchMedia('(max-width: 767px)').matches; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !mobile) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={paired ? '给 Pulse 发送消息…' : '请先授权此设备'} rows={1} disabled={!paired} />{running && surfaceMode === 'work' ? <button type="button" className="stop-button" disabled={stopping} onClick={() => void stopRun()}>{stopping ? '…' : '■'}<span>{stopping ? '正在停止' : '停止'}</span></button> : <button type="submit" disabled={!draft.trim() || submitting || !paired} aria-label="发送">{submitting ? <span className="spinner" /> : <Icon name="send" size={17}/>}</button>}</form>{surfaceMode === 'work' && !selectedId && <div className="new-chat-tools"><button type="button" className={`new-chat-approval ${newApprovalPolicy === 'delegate' ? 'active' : ''}`} aria-pressed={newApprovalPolicy === 'delegate'} title="开启后，本会话后续工具操作将持续代审；业务问题仍由你回答。" onClick={() => setNewApprovalPolicy(value => value === 'delegate' ? 'manual' : 'delegate')}><Icon name="shield"/><span>{newApprovalPolicy === 'delegate' ? '本会话代审中' : '替我审批'}</span></button><div className="new-conversation-project"><Icon name="folder"/><Select aria-label="新对话所属项目" value={selectedProjectId ?? '__ungrouped__'} onChange={value => { const projectId = value === '__ungrouped__' ? undefined : value; setSelectedProjectId(projectId); if (projectId) window.localStorage.setItem('pulse-web-project', projectId); else window.localStorage.removeItem('pulse-web-project') }} options={[{ value: '__ungrouped__', label: '不归属项目' }, ...projects.map(project => ({ value: project.id, label: project.name }))]} popupMatchSelectWidth={false} /></div></div>}<div className="composer-hint">Pulse 可能会出错，请核对重要信息。</div></>}
      </footer>
    </section>
    {workbenchOpen && <Suspense fallback={<div className="workbench-loading" role="status">正在打开工作区…</div>}><WorkbenchPanel project={projects.find(project => project.id === (selected?.projectId ?? selectedProjectId))} transport={transport} localAdmin={sessionCapabilities.localAdmin} canUseTerminal={sessionCapabilities.canUseTerminal} tab={workbenchTab} setTab={setWorkbenchTab} onClose={() => setWorkbenchOpen(false)} /></Suspense>}
    {toast && <div className="toast" role="status">{toast}</div>}
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
    <header><div><strong>{current?.kind === 'interaction' ? current.interactionKind === 'ask' ? '等待你的回答' : '等待审批' : current?.label ?? (running ? '正在处理' : '任务状态')}</strong><small>{runId ? `Run ${runId.slice(-8)}` : ''}{running ? ' · 运行中' : outcome?.label ? ` · ${outcome.label}` : ''}</small></div><button className="icon-button" onClick={onClose} aria-label="关闭任务状态"><Icon name="close"/></button></header>
    {status.length === 0 && <div className="run-empty"><Icon name="activity" size={26}/><strong>没有任务记录</strong><span>开始一个任务后，执行状态和工具活动会显示在这里。</span></div>}
    {status.some(item => item.kind === 'interaction') && <button className="run-panel-jump" onClick={onClose}>审批和回答位于底部交互面板</button>}
    {laneState && <section className="lane-tree"><h3>Lane · {laneState.available ? laneState.lanes.length : '—'}</h3>{laneState.available ? laneState.lanes.map((lane, index) => <button className={`lane-row ${selectedLaneId === lane.id ? 'selected' : ''}`} key={lane.id} style={{ '--lane-depth': lane.parentId ? 1 : 0 } as CSSProperties} onClick={() => onSelectLane(lane.id)}><span className={`lane-state lane-${lane.status}`}>{lane.status === 'succeeded' ? '✓' : lane.status === 'failed' ? '!' : lane.status === 'waiting' ? 'Ⅱ' : lane.status === 'running' ? '◌' : '·'}</span><span><strong>{lane.label}{lane.parentId && <small> · 子任务</small>}</strong><small>{lane.activity ?? laneStatusText(lane.status)}</small></span></button>) : <p className="lane-unavailable">此历史任务没有可用的 Lane 快照。</p>}
      {selectedLane && <div className="lane-activity-list"><strong>{selectedLane.label} · 活动</strong>{selectedLane.activities?.length ? selectedLane.activities.map(activity => <div key={activity.id}><span>{activity.label}</span><small>{laneStatusText(activity.status)}</small></div>) : <p>没有可展示的活动记录。</p>}</div>}
    </section>}
    {tools.length > 0 && <section className="run-tools"><h3>工具活动</h3>{tools.slice(-12).map(item => <div className="run-activity" key={item.activityId}><span className={item.state === 'succeeded' ? 'status-check' : item.state === 'failed' ? 'status-failed' : ''}>{item.state === 'succeeded' ? '✓' : item.state === 'failed' ? '!' : '·'}</span><span>{item.label}</span><small>{laneStatusText(item.state)}</small></div>)}</section>}
    {status.filter((item): item is Extract<RunStatus, { kind: 'complete' }> => item.kind === 'complete').map(item => <div className={`run-outcome ${item.outcome}`} key={item.outcome}>{item.label}</div>)}
    {interrupted && runId && !running && <div className="run-actions"><button type="button" className="resume-run" disabled={resuming} onClick={() => resume(runId)}>{resuming ? '正在继续…' : '▶ 继续任务'}</button><button type="button" className="end-run" disabled={resuming} onClick={() => endInterrupted(runId)}>结束这轮</button></div>}
    {status.filter((item): item is Extract<RunStatus, { kind: 'review' }> => item.kind === 'review').map(item => <div className="run-outcome interrupted" key={item.label}>{item.label}</div>)}
    {running && !status.some(item => item.kind === 'status' || item.kind === 'interaction') && <div className="run-status"><span className="spinner" />正在处理</div>}
  </aside>
}

function laneStatusText(status: string): string { return status === 'succeeded' ? '已完成' : status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : status === 'waiting' ? '等待中' : status === 'running' ? '进行中' : status === 'cancelling' ? '正在停止' : status === 'closing' ? '正在收尾' : '排队中' }

type InteractionAnswer = { value: string } | { values: string[] } | { text: string }

function InteractionPanel({ interaction, context, reviewNote, delegated, running, stopping, stop, submit, setApprovalPolicy }: { interaction: Extract<RunStatus, { kind: 'interaction' }>; context?: string | undefined; reviewNote: string; delegated: boolean; running: boolean; stopping: boolean; stop: () => void; submit: (answers: Array<{ effectId: string; value: Record<string, unknown> }>) => Promise<boolean>; setApprovalPolicy: (policy: 'manual' | 'delegate') => Promise<boolean> }) {
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
      {tools.some(tool => Object.keys(tool.details ?? {}).some(key => key !== 'path' && key !== 'command')) && <details className="technical-details"><summary>更多操作细节</summary>{tools.map((tool, i) => <pre key={i}>{JSON.stringify(tool.details, null, 2)}</pre>)}</details>}
      {reviewNote && <p className="review-note" role="status">{reviewNote}</p>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <div className="interaction-actions"><button type="button" className="primary" disabled={sending || policyPending} onClick={approve}>允许本次</button><button type="button" className="secondary" disabled={sending || policyPending} onClick={deny}>拒绝</button>{!delegated && <button type="button" className="delegate-action" disabled={sending || policyPending} onClick={async () => { setPolicyPending(true); try { if (!await setApprovalPolicy('delegate')) setError('代审暂不可用，请人工确认或稍后重试。') } finally { setPolicyPending(false) } }}>{policyPending ? '正在审查…' : '替我审批'}</button>}{running && <button type="button" className="stop-button" disabled={stopping || policyPending} onClick={stop}>{stopping ? '正在停止…' : '停止任务'}</button>}</div>
    </section>
  }
  const count = interaction.items.length
  const sendAsk = () => void submitBatch(interaction.items.map(question => ({ effectId: question.effectId, value: (answers[question.effectId] ?? (question.input.type === 'multi' ? { values: [] } : {})) as Record<string, unknown> })))
  return <section className="interaction-panel ask-panel" aria-label="待回答问题">
    <div className="interaction-heading"><strong>需要你的回答</strong><span>第 {review ? count : index + 1} / {count} 题{review ? ' · 答案确认' : ''}</span></div>{context && <small className="interaction-context">{context}</small>}
    <div className="question-scroll">
      {review ? <div className="answer-overview">{interaction.items.map((question, i) => <article key={question.effectId}><div><strong>{i + 1}. {String(question.input.prompt ?? '请回答')}</strong><button type="button" onClick={() => { setIndex(i); setReview(false) }}>修改</button></div><p>{formatInteractionAnswer(answers[question.effectId], question.input)}</p></article>)}</div> : <>
        <h3>{String(input.prompt ?? '请回答')}</h3>
        {input.type === 'choice' && <div className="question-options">{options.map(option => { const choice = typeof option === 'string' ? { value: option, label: option } : option; const active = Boolean(selected && 'value' in selected && selected.value === choice.value); return <button type="button" className={active ? 'selected' : ''} disabled={sending} key={choice.value} onClick={() => updateCurrent({ value: choice.value })}>{choice.label ?? choice.value}</button> })}</div>}
        {input.type === 'multi' && <><p className="question-hint">可多选{typeof input.min === 'number' && input.min > 0 ? `，至少 ${input.min} 项` : ''}{typeof input.max === 'number' ? `，最多 ${input.max} 项` : ''}</p><div className="question-options multi">{options.map(option => { const choice = typeof option === 'string' ? { value: option, label: option } : option; const current = selected && 'values' in selected ? selected.values : []; const max = typeof input.max === 'number' ? input.max : Number.POSITIVE_INFINITY; const atLimit = !current.includes(choice.value) && current.length >= max; return <label key={choice.value}><input type="checkbox" disabled={sending || atLimit} checked={current.includes(choice.value)} onChange={() => updateCurrent({ values: current.includes(choice.value) ? current.filter(value => value !== choice.value) : [...current, choice.value] })} />{choice.label ?? choice.value}</label> })}</div></>}
        {input.type === 'input' && <textarea className="question-input" value={selected && 'text' in selected ? selected.text : typeof input.defaultValue === 'string' ? input.defaultValue : ''} disabled={sending} placeholder={typeof input.placeholder === 'string' ? input.placeholder : '请输入'} onChange={event => updateCurrent({ text: event.target.value })} />}
      </>}
    </div>
    {error && <p className="interaction-error" role="alert">{error}</p>}
    <div className="interaction-actions ask-actions">{review ? <><button type="button" className="secondary" disabled={sending} onClick={() => { setReview(false); setIndex(count - 1) }}>返回修改</button><button type="button" className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={sendAsk}>{sending ? '正在提交…' : '统一提交'}</button></> : <><button type="button" className="secondary" disabled={sending || index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>上一题</button>{index < count - 1 ? <button type="button" className="primary" disabled={sending || !item || !answerValid(item)} onClick={() => setIndex(value => value + 1)}>下一题</button> : <button type="button" className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={() => setReview(true)}>检查答案</button>}{running && <button type="button" className="stop-button" disabled={stopping} onClick={stop}>{stopping ? '正在停止…' : '停止任务'}</button>}</>}</div>
  </section>
}

function formatInteractionAnswer(answer: InteractionAnswer | undefined, input: Record<string, unknown>): string {
  if (!answer) return '尚未填写'
  if ('text' in answer) return answer.text || '（空）'
  const options = Array.isArray(input.options) ? input.options as Array<string | { value: string; label?: string }> : []
  const label = (value: string) => { const option = options.find(item => (typeof item === 'string' ? item : item.value) === value); return typeof option === 'string' ? option : option?.label ?? value }
  return 'value' in answer ? label(answer.value) : answer.values.length ? answer.values.map(label).join('、') : '未选择'
}

function PairingPage({ pairing, error, refresh, transport }: { pairing: { code: string; pairUrl: string; qrSvg: string; devices: Device[] } | undefined; error: string; refresh: () => Promise<void>; transport: PulseWebTransport }) {
  const [message, setMessage] = useState('')
  const revoke = async (device: Device) => {
    try { await apiJson(transport, `/api/devices/${encodeURIComponent(device.id)}/revoke`, jsonRequest('POST')); setMessage('设备授权已撤销。'); await refresh() }
    catch { setMessage('撤销失败，请检查本机连接。') }
  }
  return <main className="pair-page"><section className="pair-card"><div className="pair-header"><div className="brand-mark">✳</div><h1>连接 Pulse</h1><p>手机和电脑连接同一 Wi-Fi 后，扫描二维码即可开始聊天。</p></div>{pairing && <><img className="qr" src={`data:image/svg+xml,${encodeURIComponent(pairing.qrSvg)}`} alt="Pulse 手机配对二维码" /><div className="pair-code">{pairing.code.match(/.{1,4}/g)?.join(' ')}</div><p className="pair-url">{pairing.pairUrl}</p><button className="refresh-pair" onClick={() => void refresh()}>刷新二维码</button><div className="devices"><h2>已授权设备</h2>{pairing.devices.length === 0 ? <p>还没有已授权设备</p> : pairing.devices.map(device => <div className="device-row" key={device.id}><span>{device.name}</span><button onClick={() => void revoke(device)}>撤销</button></div>)}</div></>}{(error || message) && <p className="pair-error" role="status">{error || message}</p>}</section></main>
}
