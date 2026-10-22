import { z } from 'zod'

const point = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), point, button: z.enum(['left', 'right']).default('left'), count: z.number().int().min(1).max(2).default(1) }),
  z.object({ type: z.literal('drag'), from: point, to: point }),
  z.object({ type: z.literal('scroll'), point, dx: z.number().int().min(-2000).max(2000).default(0), dy: z.number().int().min(-2000).max(2000) }),
  z.object({ type: z.literal('type'), text: z.string().max(10000) }),
  z.object({ type: z.literal('key'), keys: z.array(z.string().min(1).max(32)).min(1).max(4) }),
  z.object({ type: z.literal('element'), ref: z.string().min(1).max(200), operation: z.enum(['click', 'fill', 'select']), value: z.string().max(10000).optional() }),
])
export type AutomationAction = z.infer<typeof automationActionSchema>
export interface AutomationConfig {
  browser?: { channel?: 'chromium' | 'chrome' | 'msedge'; mode?: 'dedicated' | 'existing'; profileDir?: string; command?: string; args?: string[] }
  computer?: { helperPath?: string; displayId?: string }
}
export interface BackendObservation {
  tabs?: NonNullable<AutomationSessionView['tabs']>
  title?: string
  url?: string
  text?: string
  width: number
  height: number
  image: { mediaType: 'image/png' | 'image/jpeg'; data: string }
  geometry?: string
}
export interface AutomationBackend {
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  observe(signal?: AbortSignal): Promise<BackendObservation>
  act(action: AutomationAction, observation: BackendObservation, signal?: AbortSignal): Promise<void>
  release(): Promise<void>
  close(): Promise<void>
}
export interface AutomationSessionView {
  id: string
  kind: 'browser' | 'computer'
  owner: string
  conversationId?: string
  projectId?: string
  reconnectRequired?: boolean
  tabs?: { revision: string; items: Array<{ index: number; title: string; url: string; active: boolean }> }
  workspace: string
  mode: string
  state: 'ai' | 'paused' | 'human' | 'closed' | 'unknown'
  controller?: string
  frameId?: string
  frameWidth?: number
  frameHeight?: number
  title?: string
  url?: string
  observedAt?: string
  actionCount: number
  error?: string
}
export function automationError(code: string): Error { return Object.assign(new Error(code), { code, retryable: false }) }
