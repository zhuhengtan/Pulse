import { AsyncLocalStorage } from 'node:async_hooks'
import { ToolError } from '@hunterzhu/pulse-tool-sdk'

export interface OfficeBinaryWriteRequest {
  path: string
  bytes: Uint8Array
  expectedHash: string | null
  signal: AbortSignal
}

export interface OfficeBinaryWriteResult {
  path: string
  hash: string
  bytes: number
}

/** Host-injected compare-and-swap writer. Document tools never open files themselves. */
export interface OfficeBinaryWriter {
  write(request: OfficeBinaryWriteRequest): Promise<OfficeBinaryWriteResult>
}

export const officeBinaryWriter = new AsyncLocalStorage<OfficeBinaryWriter>()

export function requireOfficeBinaryWriter(): OfficeBinaryWriter {
  const writer = officeBinaryWriter.getStore()
  if (!writer) throw new ToolError('OFFICE_WRITE_CHANNEL_REQUIRED', 'Office output requires the host binary file channel.')
  return writer
}
