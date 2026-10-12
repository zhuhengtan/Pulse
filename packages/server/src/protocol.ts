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
  pinned?: boolean
  archivedAt?: string
  kind?: 'assistant' | 'work'
}

export interface WebProject {
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
  status: 'ready' | 'running' | 'waiting' | 'closing' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  activity?: string
  activities?: Array<{ id: string; label: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting' }>
}

export interface WebRunLanes {
  runId: string
  available: boolean
  lanes: WebLane[]
}

export interface WebMessage {
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
}

export interface WebAssistantMessageReceipt {
  messageId: string
  runId: string
  state: 'queued' | 'replying' | 'failed' | 'interrupted' | 'completed'
  error?: string
  createdAt: string
  updatedAt: string
}

type WebRunEventPayload =
  | { type: 'status'; runId: string; seq: number; data: { kind: 'working' | 'context'; label?: string } }
  | { type: 'text'; runId: string; seq: number; data: string; activityId?: string }
  | { type: 'tool'; runId: string; seq: number; data: { activityId: string; effectId: string; attemptId?: string; tool: string; status: 'succeeded' | 'failed' | 'cancelled' } }
  | { type: 'waiting'; runId: string; seq: number; data: { effectId: string; input: Record<string, unknown> } }
  | { type: 'interactions'; runId: string; seq: number; data: { interactions: WebPendingInteraction[]; reviewNote?: string } }
  | { type: 'lanes'; runId: string; seq: number; data: WebRunLanes }
  | { type: 'complete'; runId: string; seq: number; data: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode?: string } }
  | { type: 'gap'; runId: string; seq: number; data: { fromSeq: number; toSeq: number } }
  | { type: 'error'; runId: string; seq: number; data: { message: string } }
  | { type: 'run_finished'; runId: string; seq: number }

export type WebRunEvent = WebRunEventPayload & { conversationId?: string }

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
