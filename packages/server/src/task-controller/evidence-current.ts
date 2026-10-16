import { captureCheck } from '../check-receipt.js'
import { resolve } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import type { PulseRuntime } from '@hunterzhu/pulse-runtime'

/** Host-side I/O, outside pure Runtime steps. Earlier edits remain historical evidence. */
export async function staleFileEvidence(root: string, refs: string[], runtime: PulseRuntime): Promise<string[]> {
  const paths = new Map<string, { hash: string; refs: string[]; order: number }>()
  for (const ref of refs) {
    const result = runtime.state.results.get(ref), value = result?.value
    const effect = result?.producer?.kind === 'effect' ? runtime.state.effects.get(result.producer.id) : undefined
    if (effect?.outcome?.status !== 'succeeded' || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const path = value.path ?? value.destination ?? (value.committed === true ? value.target : undefined), hash = value.hash ?? value.contentHash
    if (typeof path !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) continue
    const key = resolve(root, path), previous = paths.get(key), order = Number(ref.match(/(\d+)$/)?.[1] ?? 0)
    paths.set(key, { hash: previous && previous.order > order ? previous.hash : hash, order: Math.max(previous?.order ?? 0, order), refs: [...(previous?.refs ?? []), ref] })
  }
  const files = new FilesystemTool(root), stale: string[] = []
  const checks = new Map<string, { ref: string; receipt: Record<string, any> }>()
  for (const ref of [...refs].sort((a, b) => Number(a.match(/(\d+)$/)?.[1] ?? 0) - Number(b.match(/(\d+)$/)?.[1] ?? 0))) {
    const value = runtime.state.results.get(ref)?.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const receipt = value.checkReceipt
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue
    checks.set(JSON.stringify([receipt.command, receipt.args, receipt.cwd]), { ref, receipt })
  }
  for (const { ref, receipt } of checks.values()) {
    if (!receipt.stable || receipt.definitionChanged || !receipt.files || typeof receipt.files !== 'object') { stale.push(ref); continue }
    const sorted = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    try {
      const current = await captureCheck(root, resolve(root, receipt.cwd), receipt.command, receipt.args)
      if (sorted(current.files) !== sorted(receipt.files) || sorted(current.definitions) !== sorted(receipt.definitions ?? {}) || sorted(current.environment) !== sorted(receipt.environment ?? {})) stale.push(ref)
    } catch { stale.push(ref) }
  }
  for (const [path, snapshot] of paths) if (await files.hash(path).catch(() => undefined) !== snapshot.hash) stale.push(...snapshot.refs)
  return [...new Set(stale)]
}
