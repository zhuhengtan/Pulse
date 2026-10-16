import type { JsonValue } from '../core/types.js'
import type { StepContext } from './program.js'
const row = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
export interface ProposedEvidenceCall { toolName: string; input: JsonValue }
/** Pure proposal filter. Host freshness checks remain mandatory at verification. */
export function reusableEvidence(ctx: Pick<StepContext, 'results'>, calls: ProposedEvidenceCall[], refs: string[]): { refs: string[]; checksOnly: boolean } | undefined {
  if (!calls.length || calls.some(c => !['fs.read', 'shell.exec'].includes(c.toolName))) return undefined
  const ordered = [...new Set(refs)].sort((a, b) => Number(a.match(/\d+$/)?.[0] ?? 0) - Number(b.match(/\d+$/)?.[0] ?? 0))
  const latestAnswer = [...ordered].reverse().find(ref => ctx.results.meta(ref)?.effectKind === 'human')
  const versions = new Map<string, string | undefined>()
  for (const ref of ordered) {
    const meta = ctx.results.meta(ref), v = row(ctx.results.read(ref)), args = row(meta?.toolArguments)
    if (!meta?.toolName?.startsWith('fs.')) continue
    if (meta.toolName === 'fs.stage' && v.committed !== true) continue
    const path = v.path ?? v.target ?? args.path
    if (typeof path === 'string' && ['fs.read', 'fs.write', 'fs.apply_patch', 'fs.apply_patches', 'fs.stage'].includes(meta.toolName)) versions.set(path, typeof v.hash === 'string' ? v.hash : undefined)
  }
  const matched: string[] = []
  for (const call of calls) {
    const input = row(call.input)
    const newestCheck = call.toolName === 'shell.exec' ? [...ordered].reverse().find(ref => {
      const meta = ctx.results.meta(ref), args = row(meta?.toolArguments)
      return meta?.toolName === call.toolName && args.command === input.command && JSON.stringify(args.args ?? []) === JSON.stringify(input.args ?? []) && (args.cwd ?? '.') === (input.cwd ?? '.')
    }) : undefined
    const ref = [...ordered].reverse().find(ref => {
      const meta = ctx.results.meta(ref), v = row(ctx.results.read(ref)), args = row(meta?.toolArguments)
      if (meta?.toolName !== call.toolName || meta.outcomeStatus !== 'succeeded') return false
      if (latestAnswer && ordered.indexOf(ref) < ordered.indexOf(latestAnswer)) return false
      if (call.toolName === 'fs.read') return typeof v.hash === 'string' && v.path === input.path && (v.offset ?? 0) === (input.offset ?? 0) && versions.get(v.path) === v.hash
      if (ref !== newestCheck) return false // A later failure cannot fall back to an old pass.
      const receipt = row(v.checkReceipt)
      if (v.code !== 0 || v.timedOut || v.aborted || v.truncated || receipt.stable !== true || receipt.definitionChanged !== false) return false
      if (args.command !== input.command || JSON.stringify(args.args ?? []) !== JSON.stringify(input.args ?? []) || (args.cwd ?? '.') !== (input.cwd ?? '.')) return false
      if (!receipt.files || !Object.keys(receipt.files).length) return false
      return Object.entries(receipt.files).every(([path, hash]) => !versions.has(path) || versions.get(path) === hash)
    })
    if (!ref) return undefined
    matched.push(ref)
  }
  return { refs: [...new Set(matched)], checksOnly: calls.every(c => c.toolName === 'shell.exec') }
}
