import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceStateFile } from './atomic-file.js'
import { withConfigFileLock } from './config-write-lock.js'
import { pulseHomePath } from './paths.js'

/** Cap the global prompt so one settings value cannot fill every system prompt. */
export const MAX_GLOBAL_PROMPT_CHARS = 16_384

export interface GlobalPromptState {
  /** Verbatim prompt as stored; empty when unconfigured or cleared. */
  prompt: string
  /** False when unconfigured, cleared, or whitespace-only. */
  configured: boolean
  path: string
  updatedAt?: string
  /** Content identity for compare-and-set saves; changes only when the effective prompt changes. */
  version: string
}

export const globalPromptVersion = (prompt: string): string => createHash('sha256').update(prompt.trim() ? prompt : '').digest('hex')

const failure = (code: string, cause?: unknown) => Object.assign(new Error(code), { code, ...(cause === undefined ? {} : { cause }) })

const GLOBAL_PROMPT_VERSION = 1

/** The global prompt follows the user-level settings layout, not a workspace. */
export function globalPromptPath(): string {
  return join(pulseHomePath(), 'global-prompt.json')
}

const emptyState = (path: string): GlobalPromptState => ({ prompt: '', configured: false, path, version: globalPromptVersion('') })

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Missing, corrupt, or non-string values read as unconfigured so prompt building never breaks. */
const parseState = (text: string, path: string): GlobalPromptState => {
  const data = asRecord(JSON.parse(text))
  const prompt = typeof data.prompt === 'string' ? data.prompt : ''
  if (!prompt.trim()) return emptyState(path)
  return { prompt, configured: true, path, version: globalPromptVersion(prompt), ...(typeof data.updatedAt === 'string' ? { updatedAt: data.updatedAt } : {}) }
}

const writeState = async (path: string, prompt: string, updatedAt: string): Promise<void> => {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: GLOBAL_PROMPT_VERSION, prompt, updatedAt }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await replaceStateFile(tmp, path)
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw failure('GLOBAL_PROMPT_WRITE_FAILED', cause)
  }
}

/** Read the shared global prompt. Reads take the same lock as config writes. */
export async function readGlobalPrompt(path: string = globalPromptPath()): Promise<GlobalPromptState> {
  return withConfigFileLock(path, async () => {
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(path)
      throw cause
    }
    try { return parseState(text, path) } catch { return emptyState(path) }
  })
}

/**
 * Replace the shared global prompt under the config lock. Whitespace-only clears it.
 * With `expectedVersion` the write only lands when the stored prompt is still the
 * one the caller read; otherwise GLOBAL_PROMPT_CONFLICT and nothing changes.
 */
export async function writeGlobalPrompt(prompt: string, path: string = globalPromptPath(), expectedVersion?: string): Promise<GlobalPromptState> {
  if (typeof prompt !== 'string') throw failure('GLOBAL_PROMPT_INVALID')
  if (prompt.length > MAX_GLOBAL_PROMPT_CHARS) throw failure('GLOBAL_PROMPT_TOO_LONG')
  const updatedAt = new Date().toISOString()
  const configured = prompt.trim().length > 0
  return withConfigFileLock(path, async () => {
    if (expectedVersion !== undefined) {
      let current = emptyState(path)
      try { current = parseState(await readFile(path, 'utf8'), path) } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw failure('GLOBAL_PROMPT_WRITE_FAILED', cause)
      }
      if (current.version !== expectedVersion) throw failure('GLOBAL_PROMPT_CONFLICT')
    }
    await writeState(path, configured ? prompt : '', updatedAt)
    return configured ? { prompt, configured, path, updatedAt, version: globalPromptVersion(prompt) } : emptyState(path)
  })
}

/** Clear the stored global prompt; equivalent to writing an empty value. */
export async function clearGlobalPrompt(path: string = globalPromptPath()): Promise<GlobalPromptState> {
  return writeGlobalPrompt('', path)
}
