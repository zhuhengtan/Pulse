import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export interface WindowsPtyFrame { type: 'ready' | 'input' | 'ack' | 'nack' | 'exit' | 'exitUnknown'; scope: string; id: string; data?: string; code?: number }
export const windowsPtyProtocol = require(fileURLToPath(new URL('./windows-pty-protocol.cjs', import.meta.url))) as {
  encodeFrame(message: { type: WindowsPtyFrame['type']; scope: string; id?: string; data?: string; code?: number }): Buffer
  createParser(onFrame: (message: WindowsPtyFrame) => void): (chunk: Buffer) => Buffer
  isWindowsExitCode(code: unknown): code is number
}
