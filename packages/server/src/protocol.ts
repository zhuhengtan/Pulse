import type { RichContent } from './rich-content.js'
/** Browser-safe DTOs shared by the H5 server and independent Web client. */
export interface WebConversation {
  id: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  activeRunId?: string
  approvalPolicy?: 'manual' | 'delegate'
  projectId?: string
  projectUnassigned?: boolean
  pinned?: boolean
  archivedAt?: string
  kind?: 'assistant' | 'work'
}

export interface WebProject {
  /** Registered source folders; cwd is the primary/default folder. */
  folders?: string[]
  id: string
  name: string
  cwd: string
  createdAt: string
  updatedAt: string
  pinned: boolean
  available: boolean
  previewUrl?: string
}

export interface WebLane {
  id: string
  parentId?: string
  label: string
  goal?: string
  status: 'ready' | 'running' | 'waiting' | 'closing' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  activity?: string
  activities?: Array<{ id: string; label: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting' }>
}

export interface WebRunLanes {
  runId: string
  available: boolean
  lanes: WebLane[]
}

export interface WebAttachment {
  id: string
  name: string
  type: 'image' | 'file'
  size: number
  mediaType: string
  url?: string
  data?: string
}

/** Exact navigation references; never an instruction or permission grant. */
export interface AssistantContextReference { projectId?: string; conversationId?: string }

export interface WebMessage {
  assistantContext?: AssistantContextReference
  sequence?: number
  bodyTruncated?: boolean
  bodyLength?: number
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  runId?: string
  createdAt: string
  legacy?: boolean
  restored?: boolean
  deliveryState?: 'queued' | 'replying' | 'failed' | 'interrupted'
  requestId?: string
  work?: { conversationId: string; projectId?: string; title: string; state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'pending' | 'conflict' | 'running' | 'waiting'; progress?: string; laneCount?: number }
  attachments?: WebAttachment[]
  skills?: string[]
  mentionedFiles?: string[]
  richContent?: RichContent
}

export interface WebAssistantMessageReceipt {
  messageId: string
  runId: string
  state: 'queued' | 'replying' | 'failed' | 'interrupted' | 'completed'
  error?: string
  createdAt: string
  updatedAt: string
}

/** Lane-attributed model, reasoning and note events shown in the work-mode execution block. */
export type WebTraceData =
  | { kind: 'model'; effectId?: string; laneId?: string; attemptId?: string; task: string; modelId: string; providerId?: string; attemptNo: number; fallback: boolean }
  | { kind: 'reasoning' | 'note'; effectId?: string; laneId?: string; attemptId?: string; attemptNo?: number; task: string; modelId?: string; text: string }

type WebRunEventPayload =
  | { type: 'resync'; runId: string; seq: number; data: WebRunSnapshot }
  | { type: 'status'; runId: string; seq: number; data: { kind: 'working' | 'context'; label?: string } }
  | { type: 'input_response'; runId: string; seq: number; data: { messageId: string; text: string } }
  | { type: 'text'; runId: string; seq: number; data: string; activityId?: string }
  | { type: 'tool'; runId: string; seq: number; data: { activityId: string; effectId: string; attemptId?: string; laneId?: string; tool: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; args?: Record<string, unknown>; preview?: Record<string, unknown>; error?: Record<string, unknown> } }
  | { type: 'trace'; runId: string; seq: number; data: WebTraceData }
  | { type: 'waiting'; runId: string; seq: number; data: { effectId: string; input: Record<string, unknown> } }
  | { type: 'interactions'; runId: string; seq: number; data: { interactions: WebPendingInteraction[]; reviewNote?: string } }
  | { type: 'lanes'; runId: string; seq: number; data: WebRunLanes }
  | { type: 'complete'; runId: string; seq: number; data: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode?: string } }
  | { type: 'gap'; runId: string; seq: number; data: { fromSeq: number; toSeq: number } }
  | { type: 'error'; runId: string; seq: number; data: { message: string } }
  | { type: 'run_finished'; runId: string; seq: number }

export type WebRunEvent = WebRunEventPayload & { conversationId?: string; timestamp?: number; runStartedAt?: number }

export interface WebPendingInteraction {
  groupId: string
  kind: 'ask' | 'approval'
  items: Array<{ effectId: string; input: Record<string, unknown> }>
}

/** A work-session interaction projected into the persistent assistant chat. */
export interface WebAssistantWorkInteraction extends WebPendingInteraction {
  runId: string
  conversationId: string
  title: string
  projectId?: string
  approvalPolicy: 'manual' | 'delegate'
}

export interface WebRunSnapshot {
  runId: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  seq: number
  status?: Extract<WebRunEvent, { type: 'status' }>
  activities: Array<Extract<WebRunEvent, { type: 'tool' }>>
  waiting?: Extract<WebRunEvent, { type: 'waiting' }>
  interactions?: WebPendingInteraction[]
  reviewNote?: string
  complete?: Extract<WebRunEvent, { type: 'complete' }>
  laneState?: WebRunLanes
}

export type { AutomationSessionView as WebAutomationSession } from './automation/types.js'

/** Canonical paths from the machine running Pulse, independent of the browser OS. */
export type HostPathMode = 'file' | 'directory' | 'both'
export interface HostPathEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  symlink?: boolean
  unavailable?: string
}
export interface HostPathRoots { home: string; roots: Array<{ name: string; path: string }> }
export interface HostPathListing {
  path: string
  name: string
  parent: string | null
  breadcrumbs: Array<{ name: string; path: string }>
  entries: HostPathEntry[]
  nextOffset: number | null
}
