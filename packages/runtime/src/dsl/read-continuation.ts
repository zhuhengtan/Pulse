import { normalize } from 'node:path'
import type { JsonValue } from '../core/types.js'
import type { StepContext } from './program.js'

const pathKey = (value: unknown) => typeof value === 'string' ? normalize(value).replaceAll('\\', '/') : undefined
const limitBytes = 3000
const row = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** A bounded window must expose new bytes, rather than slide through already read text. */
export function isUnreadFileWindow(ctx: Pick<StepContext<unknown>, 'results'>, call: { toolName: JsonValue; input: JsonValue }, refs: readonly string[]): boolean {
  if (call.toolName !== 'fs.read') return false
  const { path, offset = 0, startLine, maxBytes = limitBytes } = row(call.input)
  if (typeof path !== 'string' || !integer(offset) || !integer(maxBytes) || maxBytes === 0) return false
  const size = Math.min(maxBytes, limitBytes)
  const ordered = [...new Set(refs)].sort((a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0))
  const observations = ordered.flatMap((ref, order) => {
    const meta = ctx.results.meta(ref), body = row(ctx.results.read(ref)), args = row(meta?.toolArguments)
    if (meta?.outcomeStatus !== 'succeeded' || !['fs.read', 'fs.write', 'fs.apply_patch', 'fs.apply_patches', 'fs.stage'].includes(meta.toolName ?? '')) return []
    if (pathKey(body.path) !== pathKey(path) && pathKey(body.target) !== pathKey(path) && pathKey(args.path) !== pathKey(path)) return []
    if (meta.toolName === 'fs.stage' && body.committed !== true) return []
    return [{ body, args, read: meta.toolName === 'fs.read', order }]
  })
  const latest = observations.at(-1)
  if (latest && typeof latest.body.hash !== 'string') return false
  const pages = observations.filter(o => o.read && o.body.hash === latest?.body.hash)
  if (startLine !== undefined) {
    if (!integer(startLine) || startLine < 1 || offset !== 0 || pages.some(p => integer(p.args.startLine) && startLine >= p.args.startLine && startLine <= p.args.startLine + (typeof p.body.content === 'string' ? p.body.content.split('\n').length - (p.body.content.endsWith('\n') ? 2 : 1) : 0))) return false
    // Search anchors are exact observed locations, not model-invented line numbers.
    // A later write invalidates older anchors, even when the read result was retained.
    const lastWrite = observations.filter(o => !o.read && o.body.changed !== false).at(-1)?.order ?? -1
    return ordered.some((ref, order) => {
      if (order <= lastWrite) return false
      const meta = ctx.results.meta(ref), body = row(ctx.results.read(ref))
      return meta?.toolName === 'fs.search' && meta.outcomeStatus === 'succeeded' && Array.isArray(body.matches) && body.matches.some(m => pathKey(row(m).path) === pathKey(path) && row(m).line === startLine)
    })
  }
  if (!latest || pages.length === 0) return offset === 0
  const ranges = pages.flatMap(({ body }) => {
    const start = body.offset ?? 0
    const end = integer(body.nextOffset) ? body.nextOffset : typeof body.content === 'string' ? start + Buffer.byteLength(body.content) : undefined
    return integer(start) && integer(end) && end > start ? [[start, end] as [number, number]] : []
  }).sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  const eof = pages.flatMap(({ body }) => body.nextOffset === null && typeof body.content === 'string' && integer(body.offset ?? 0) ? [(body.offset ?? 0) + Buffer.byteLength(body.content)] : [])
  const end = Math.min(offset + size, ...eof)
  if (!Number.isSafeInteger(end) || end <= offset) return false
  const covered = merged.reduce((n, [start, stop]) => n + Math.max(0, Math.min(stop, end) - Math.max(start, offset)), 0)
  if (covered >= end - offset) return false
  if (pages.some(({ body }) => body.nextOffset === offset)) return true
  // A little context overlap is useful, but 1-byte shifts cannot defeat the gate.
  return merged.some(([start, stop]) => offset >= start && offset < stop && end > stop) && covered <= Math.min(512, Math.floor((end - offset) / 4))
}

/** Count actual new windows/version changes, not arbitrary reads at positive offsets. */
export function isReadProgress(ctx: Pick<StepContext<unknown>, 'results'>, ref: string, priorRefs: readonly string[]): boolean {
  const meta = ctx.results.meta(ref), body = row(ctx.results.read(ref)), args = row(meta?.toolArguments)
  if (meta?.toolName !== 'fs.read' || meta.outcomeStatus !== 'succeeded') return false
  const path = body.path ?? args.path
  const priorFile = [...new Set(priorRefs)].sort((a, b) => Number(b.match(/\d+$/)?.[0] ?? 0) - Number(a.match(/\d+$/)?.[0] ?? 0)).find(prior => {
    const m = ctx.results.meta(prior), b = row(ctx.results.read(prior)), a = row(m?.toolArguments)
    return m?.outcomeStatus === 'succeeded' && ['fs.read', 'fs.write', 'fs.apply_patch', 'fs.apply_patches', 'fs.stage'].includes(m.toolName ?? '') && (m.toolName !== 'fs.stage' || b.committed === true) && pathKey(b.path ?? b.target ?? a.path) === pathKey(path)
  })
  if (priorFile && typeof body.hash === 'string' && typeof row(ctx.results.read(priorFile)).hash === 'string' && body.hash !== row(ctx.results.read(priorFile)).hash) return true
  if (!priorFile && args.startLine === undefined) return false
  return isUnreadFileWindow(ctx, { toolName: 'fs.read', input: { ...args, path, ...(args.startLine === undefined ? { offset: body.offset ?? args.offset ?? 0 } : {}) } }, priorRefs)
}
