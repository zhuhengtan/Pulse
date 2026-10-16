import { normalize, relative, resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
const fragmentHash = (text: string) => createHash('sha256').update(text).digest('hex')
import type { JsonValue } from '../core/types.js'
import type { StepContext } from './program.js'

const row = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const order = (ref: string) => Number(ref.match(/\d+$/)?.[0] ?? 0)
export interface PatchRecovery {
  path: string; workspaceRoot?: string; currentHash: string; reason: string; attempts: number; corrected: boolean; afterRef: number
  findHashes: string[]; missingFindHashes: string[]; readPending: boolean
  suggestedRead: { path: string; offset: number; maxBytes: number }
}
const pathMatches = (record: PatchRecovery, path: unknown) => typeof path === 'string' && (record.workspaceRoot ? relative(record.workspaceRoot, resolve(record.workspaceRoot, path)) : normalize(path)).replaceAll('\\', '/') === normalize(record.path).replaceAll('\\', '/')
export function readPatchRecoveries(value: unknown): PatchRecovery[] {
  return structuredClone(Array.isArray(value) ? value.filter(v => typeof v?.path === 'string' && hash(v?.currentHash) && Array.isArray(v?.findHashes) && v.findHashes.length <= 64 && v.findHashes.every(hash) && Array.isArray(v?.missingFindHashes) && v.missingFindHashes.every((h: unknown) => v.findHashes.includes(h)) && typeof v.corrected === 'boolean' && typeof v.readPending === 'boolean' && (v.workspaceRoot === undefined || typeof v.workspaceRoot === 'string' && isAbsolute(v.workspaceRoot)) && Number.isSafeInteger(v?.attempts) && Number.isSafeInteger(v?.afterRef) && v?.suggestedRead?.path === v.path && Number.isSafeInteger(v?.suggestedRead?.offset) && v.suggestedRead.offset >= 0 && Number.isSafeInteger(v.suggestedRead.maxBytes) && v.suggestedRead.maxBytes > 0 && v.suggestedRead.maxBytes <= 3000).slice(-8) : [])
}
export function rememberPatchFailures(prior: PatchRecovery[], failures: Array<{ code: string; details?: JsonValue | undefined }>, afterRef: number): PatchRecovery[] {
  const result = structuredClone(prior)
  for (const failure of failures) {
    const d = row(failure.details), read = row(d.suggestedRead)
    if (!['FILE_BASELINE_CONFLICT', 'PATCH_CONTEXT_NOT_FOUND', 'PATCH_CONTEXT_AMBIGUOUS', 'PATCH_RANGES_OVERLAP'].includes(failure.code) || d.kind !== 'patch-conflict' || !['fs.apply_patch', 'fs.apply_patches'].includes(d.toolName) || typeof d.path !== 'string' || !hash(d.currentHash) || !Array.isArray(d.findHashes) || !d.findHashes.length || d.findHashes.length > 16 || !d.findHashes.every(hash) || !Array.isArray(d.missingFindHashes) || !d.missingFindHashes.every(h => d.findHashes.includes(h)) || read.path !== d.path || !Number.isSafeInteger(read.offset) || read.offset < 0 || !Number.isSafeInteger(read.maxBytes) || read.maxBytes < 1 || read.maxBytes > 3000) continue
    const previous = result.find(r => r.path === d.path && r.currentHash === d.currentHash)
    const next: PatchRecovery = { path: d.path, ...(typeof d.workspaceRoot === 'string' && isAbsolute(d.workspaceRoot) ? { workspaceRoot: d.workspaceRoot } : previous?.workspaceRoot ? { workspaceRoot: previous.workspaceRoot } : {}), currentHash: d.currentHash, reason: failure.code, attempts: (previous?.attempts ?? 0) + 1, corrected: previous?.corrected ?? false, afterRef,
      findHashes: [...new Set([...(previous?.findHashes ?? []), ...d.findHashes])].slice(-64), missingFindHashes: [...new Set([...(previous?.missingFindHashes ?? []), ...d.missingFindHashes])].slice(-64), readPending: true, suggestedRead: { path: read.path, offset: read.offset, maxBytes: read.maxBytes } }
    const index = result.findIndex(r => r.path === d.path)
    if (index >= 0) result.splice(index, 1)
    result.push(next)
  }
  return result.slice(-8)
}
export function refreshPatchRecoveries(ctx: Pick<StepContext, 'results'>, records: PatchRecovery[], refs: string[]): PatchRecovery[] {
  return records.flatMap(record => {
    const newest = [...new Set(refs)].sort((a, b) => order(b) - order(a)).find(ref => {
      const meta = ctx.results.meta(ref), body = row(ctx.results.read(ref)), args = row(meta?.toolArguments)
      return order(ref) > record.afterRef && meta?.outcomeStatus === 'succeeded' && ['fs.read', 'fs.write', 'fs.apply_patch', 'fs.apply_patches', 'fs.stage'].includes(meta.toolName ?? '') && pathMatches(record, body.path ?? body.target ?? args.path) && hash(body.hash) && (meta.toolName !== 'fs.stage' || body.committed === true)
    })
    if (!newest) return [record]
    const body = row(ctx.results.read(newest)), meta = ctx.results.meta(newest)
    if (body.hash !== record.currentHash) return []
    return [{ ...record, afterRef: order(newest), readPending: meta?.toolName === 'fs.read' ? false : record.readPending }]
  })
}
export function isPatchRecoveryRead(call: { toolName: JsonValue; input: JsonValue }, records: PatchRecovery[]): boolean {
  const a = row(call.input)
  return call.toolName === 'fs.read' && a.startLine === undefined && records.some(r => r.readPending && pathMatches(r, a.path) && (a.offset ?? 0) === r.suggestedRead.offset && Math.min(a.maxBytes ?? 3000, 3000) === r.suggestedRead.maxBytes)
}
export function stalePatchRecord(call: { toolName: string; input: JsonValue }, records: PatchRecovery[]): PatchRecovery | undefined {
  if (!['fs.apply_patch', 'fs.apply_patches'].includes(call.toolName)) return undefined
  const a = row(call.input), patches = call.toolName === 'fs.apply_patch' ? [a] : Array.isArray(a.patches) ? a.patches.map(row) : []
  const finds = patches.filter(p => typeof p.find === 'string').map(p => fragmentHash(p.find))
  return records.find(r => pathMatches(r, a.path) && (finds.some(h => r.missingFindHashes.includes(h)) || a.expectedHash !== r.currentHash && finds.some(h => r.findHashes.includes(h))))
}
