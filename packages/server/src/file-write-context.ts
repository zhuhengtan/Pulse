import { AsyncLocalStorage } from 'node:async_hooks'

export interface FileWriteIdentity {
  effectId: string
  runId: string
  laneId: string
  agentId: string
  conversationId: string
  replay?: boolean
}

export const fileWriteContext = new AsyncLocalStorage<FileWriteIdentity>()
