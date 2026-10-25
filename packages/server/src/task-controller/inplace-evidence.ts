import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { within } from '../security.js'

type Entry = { path: string; beforeHash: string }
export type InPlaceSnapshot = { script: string; scriptHash: string; entries: Entry[] }
export type InPlaceChanges = { schemaVersion: 1; operation: 'in-place'; script: string; scriptHash: string; entries: Array<Entry & { hash: string }> }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const dataFile = (path: string) => /\.(?:json|txt|csv|tsv|yaml|yml|xml|dat)$/i.test(path) && !/^(?:package(?:-lock)?\.json|tsconfig(?:\.[^.]+)?\.json|pnpm-lock\.yaml)$/i.test(basename(path))
const boundedFile = async (root: string, path: string) => {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('INPLACE_INPUT_NOT_BOUNDED')
  const target = await within(root, path)
  const bytes = await readFile(target)
  if (bytes.length > 1024 * 1024) throw new Error('INPLACE_INPUT_NOT_BOUNDED')
  return digest(bytes)
}

/** Observe explicit data-file operands of an approved local Node --write invocation. */
export async function captureInPlace(root: string, cwd: string, command: string, args: string[]): Promise<InPlaceSnapshot | undefined> {
  if (!/^(?:node|nodejs)(?:\.exe)?$/i.test(basename(command)) || args.length > 40 || !args.includes('--write') || !/\.[cm]?js$/.test(args[0] ?? '')) return undefined
  try {
    const base = await realpath(root), directory = await within(base, await realpath(cwd))
    const script = resolve(directory, args[0]!), scriptHash = await boundedFile(base, script)
    const entries: Entry[] = []
    for (const operand of args.slice(1)) {
      if (operand.startsWith('-') || !dataFile(operand)) continue
      const path = resolve(directory, operand)
      entries.push({ path: relative(base, path).split(sep).join('/'), beforeHash: await boundedFile(base, path) })
    }
    if (!entries.length || entries.length > 16 || new Set(entries.map(entry => entry.path)).size !== entries.length) return undefined
    return { script: relative(base, script).split(sep).join('/'), scriptHash, entries }
  } catch { return undefined }
}

export async function finishInPlace(root: string, before: InPlaceSnapshot | undefined, result: { code: number | null; timedOut?: boolean; aborted?: boolean; truncated?: boolean }): Promise<InPlaceChanges | undefined> {
  if (!before || result.code !== 0 || result.timedOut || result.aborted || result.truncated) return undefined
  try {
    const base = await realpath(root)
    if (await boundedFile(base, resolve(base, before.script)) !== before.scriptHash) return undefined
    const entries: InPlaceChanges['entries'] = []
    for (const entry of before.entries) {
      const current = await boundedFile(base, resolve(base, entry.path))
      if (current !== entry.beforeHash) entries.push({ ...entry, hash: current })
    }
    return { schemaVersion: 1, operation: 'in-place', script: before.script, scriptHash: before.scriptHash, entries }
  } catch { return undefined }
}

/** Only Host-produced tool properties count; stdout cannot refresh evidence. */
export function inPlaceChanges(value: unknown): InPlaceChanges['entries'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const body = value as Record<string, any>, receipt = body.fileChanges
  if (body.code !== 0 || body.timedOut || body.aborted || body.truncated || receipt?.schemaVersion !== 1 || receipt.operation !== 'in-place' || !hash(receipt.scriptHash) || !Array.isArray(receipt.entries) || receipt.entries.length > 16) return []
  if (!receipt.entries.every((entry: any) => entry && typeof entry.path === 'string' && dataFile(entry.path) && hash(entry.beforeHash) && hash(entry.hash) && entry.hash !== entry.beforeHash)) return []
  return receipt.entries
}
