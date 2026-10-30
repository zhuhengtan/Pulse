import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolError } from '@hunterzhu/pulse-tool-sdk'

export const MAX_INPUT_BYTES = 20 * 1024 * 1024
export const MAX_OUTPUT_CHARS = 50_000
export const MAX_PDF_PAGES = 2_000
export const MAX_PDF_PAGE_RANGE = 50

export function docError(code: string, retryable = false, cause?: unknown): ToolError {
  return new ToolError(code, code, { retryable: retryable || isRetryable(cause) })
}

function isRetryable(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false
  const code = (cause as NodeJS.ErrnoException).code
  return code === 'EAGAIN' || code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE' || code === 'ETIMEDOUT'
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Read one regular workspace file. Symlinks and paths outside the root are rejected. */
export async function readWorkspaceFile(rootInput: string, path: string, signal: AbortSignal): Promise<{ absolutePath: string; data: Buffer }> {
  if (signal.aborted) throw docError('ABORTED')
  if (isAbsolute(path) || path.includes('\0')) throw docError('PATH_OUTSIDE_WORKSPACE')
  const root = await realpath(rootInput).catch((cause) => { throw docError('WORKSPACE_UNAVAILABLE', false, cause) })
  const candidate = resolve(root, path)
  if (!within(root, candidate)) throw docError('PATH_OUTSIDE_WORKSPACE')
  const candidateEntry = await lstat(candidate).catch((cause) => { throw docError((cause as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_READ_FAILED', false, cause) })
  if (candidateEntry.isSymbolicLink()) throw docError('PATH_OUTSIDE_WORKSPACE')
  const absolutePath = await realpath(candidate).catch((cause) => { throw docError((cause as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_READ_FAILED', false, cause) })
  if (!within(root, absolutePath)) throw docError('PATH_OUTSIDE_WORKSPACE')
  const entry = await lstat(absolutePath).catch((cause) => { throw docError('DOCUMENT_READ_FAILED', false, cause) })
  if (!entry.isFile()) throw docError('DOCUMENT_NOT_A_FILE')
  if (entry.size > MAX_INPUT_BYTES) throw docError('DOCUMENT_TOO_LARGE')
  const data = await readFile(absolutePath, { signal }).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).name === 'AbortError') throw docError('ABORTED')
    throw docError('DOCUMENT_READ_FAILED', false, cause)
  })
  if (signal.aborted) throw docError('ABORTED')
  if (data.byteLength > MAX_INPUT_BYTES) throw docError('DOCUMENT_TOO_LARGE')
  return { absolutePath, data }
}
