import { relative, resolve } from 'node:path'

const WRITE_TOOLS = new Set(['fs.write', 'fs.overwrite', 'fs.apply_patch', 'fs.apply_patches', 'fs.stage', 'fs.move', 'plan.write'])

export interface VisibleReadEffect {
  agentId?: string
  ownerLaneId?: string
  outcome?: { status?: string }
  input?: unknown
}

export interface VisibleReadResult {
  id: string
  effectId?: string
  producer?: { kind?: string; id?: string }
  value?: unknown
}

export interface VisibleReadRuntime {
  state: {
    lanes: { get(id: string): { visibleResultRefs?: { has(ref: string): boolean } | Iterable<string> | undefined } | undefined }
    results: { get(id: string): VisibleReadResult | undefined; values(): Iterable<VisibleReadResult> }
    effects: { get(id: string): VisibleReadEffect | undefined }
  }
}

function canonicalPath(root: string, path: string): string {
  const rel = relative(root, resolve(root, path)).replaceAll('\\', '/')
  if (rel === '' || rel === '.') return '.'
  if (rel.startsWith('..')) return ''
  return rel
}

function resultSeq(id: string): number {
  const match = /^result-(\d+)$/.exec(id)
  return match ? Number(match[1]) : -1
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function effectOf(runtime: VisibleReadRuntime, result: VisibleReadResult): VisibleReadEffect | undefined {
  const id = result.effectId ?? (result.producer?.kind === 'effect' ? result.producer.id : undefined)
  return id ? runtime.state.effects.get(id) : undefined
}

function toolName(effect: VisibleReadEffect | undefined): string {
  const input = asRecord(effect?.input)
  return typeof input?.name === 'string' ? input.name : ''
}

function visibleRefs(runtime: VisibleReadRuntime, laneId: string): string[] {
  const lane = runtime.state.lanes.get(laneId)
  if (!lane) return []
  const refs = lane.visibleResultRefs
  if (refs && typeof (refs as { has?: unknown }).has === 'function') return [...refs as Iterable<string>]
  if (refs === undefined) return [...runtime.state.results.values()].map((result) => result.id)
  return []
}

function owned(effect: VisibleReadEffect | undefined, laneId: string, agentId: string): boolean {
  return effect?.outcome?.status === 'succeeded' && effect.agentId === agentId && effect.ownerLaneId === laneId
}

function writePaths(name: string, body: Record<string, unknown>): string[] {
  if (!WRITE_TOOLS.has(name) || body.changed === false) return []
  if (name === 'fs.stage' && body.committed !== true) return []
  const paths = [body.path, body.target, body.source, body.destination].filter((path): path is string => typeof path === 'string' && path.length > 0)
  return paths
}

interface ReadWindow { seq: number; hash: string; start: number; end: number; reachedEnd: boolean; totalBytes?: number }

function windowsFor(runtime: VisibleReadRuntime, root: string, laneId: string, agentId: string, path: string): ReadWindow[] {
  const wanted = canonicalPath(root, path)
  if (!wanted) return []
  let latestWrite = -1
  const reads: ReadWindow[] = []
  for (const ref of visibleRefs(runtime, laneId)) {
    const result = runtime.state.results.get(ref)
    if (!result) continue
    const effect = effectOf(runtime, result)
    if (!owned(effect, laneId, agentId)) continue
    const body = asRecord(result.value)
    if (!body) continue
    const name = toolName(effect)
    const seq = resultSeq(result.id)
    if (writePaths(name, body).some((item) => canonicalPath(root, item) === wanted)) latestWrite = Math.max(latestWrite, seq)
    if (name !== 'fs.read' || typeof body.hash !== 'string' || typeof body.offset !== 'number' || typeof body.content !== 'string') continue
    if (canonicalPath(root, String(body.path ?? path)) !== wanted) continue
    const start = body.offset
    const end = start + Buffer.byteLength(body.content, 'utf8')
    const reachedEnd = body.nextOffset === null
    reads.push({ seq, hash: body.hash, start, end, reachedEnd, ...(reachedEnd ? { totalBytes: end } : {}) })
  }
  return reads.filter((read) => read.seq > latestWrite)
}

export function latestVisibleReadHash(runtime: VisibleReadRuntime, root: string, laneId: string, agentId: string, path: string): string | undefined {
  const reads = windowsFor(runtime, root, laneId, agentId, path)
  return reads.sort((a, b) => a.seq - b.seq).at(-1)?.hash
}

export function hasVisibleFullRead(runtime: VisibleReadRuntime, root: string, laneId: string, agentId: string, path: string, expectedHash: string): boolean {
  const reads = windowsFor(runtime, root, laneId, agentId, path).filter((read) => read.hash === expectedHash)
  if (!reads.some((read) => read.reachedEnd)) return false
  const total = Math.max(...reads.flatMap((read) => read.totalBytes === undefined ? [] : [read.totalBytes]))
  if (!Number.isFinite(total)) return false
  let covered = 0
  for (const read of [...reads].sort((a, b) => a.start - b.start)) {
    if (read.start > covered) return false
    if (read.end > covered) covered = read.end
  }
  return covered >= total
}
