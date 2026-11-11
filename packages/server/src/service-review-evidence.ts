import type { JsonValue, ResultMeta } from '@hunterzhu/pulse-runtime'

export interface ServiceEvidence { ref: string; meta: ResultMeta | undefined; value: JsonValue | undefined }
const object = (value: JsonValue | undefined): Record<string, JsonValue> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const localOrigin = (text: string): string | undefined => {
  try { const url = new URL(text); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined } catch { return undefined }
}
/** Exempt only explicitly requested local services with a matching native HTTP receipt. */
export function readyServiceProcesses(objective: string, evidence: ServiceEvidence[]): Set<string> {
  if (!/(?:启动|开启|运行|打开).{0,30}(?:服务|预览)|(?:start|launch|keep running).{0,35}(?:server|service|preview)/i.test(objective)) return new Set()
  const starts = new Map<string, number>(), latest = new Map<string, Record<string, JsonValue>>()
  const observed = new Map<string, number>(), announced = new Map<string, Set<string>>()
  for (const [index, { meta, value }] of evidence.entries()) {
    if (meta?.outcomeStatus !== 'succeeded' || meta.effectKind !== 'tool') continue
    const body = object(value)
    if (!body) continue
    if (meta.toolName === 'web.fetch' && typeof body.url === 'string' && typeof body.fetchedAt === 'string' && typeof body.text === 'string' && body.sourceTruncated !== true) {
      const origin = localOrigin(body.url); if (origin) observed.set(origin, index)
    }
    if (!['shell.start', 'shell.poll'].includes(meta.toolName ?? '') || typeof body.processId !== 'string') continue
    const id = body.processId
    latest.set(id, body)
    const args = object(meta.toolArguments)
    const command = args ? [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ') : ''
    if (meta.toolName === 'shell.start' && object(body.command)?.lifetime === 'service' && /\b(?:dev|serve|server|start|preview)\b/i.test(command) && !/\b(?:test|vitest|pytest|jest)\b|--test/i.test(command)) starts.set(id, index)
    const origins = announced.get(id) ?? new Set<string>()
    for (const match of String(body.output ?? '').matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/g)) { const origin = localOrigin(match[0]); if (origin) origins.add(origin) }
    announced.set(id, origins)
  }
  return new Set([...starts.keys()].filter(id => latest.get(id)?.status === 'running' && [...(announced.get(id) ?? [])].some(origin => (observed.get(origin) ?? -1) > starts.get(id)!)))
}
