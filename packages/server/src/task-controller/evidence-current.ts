import { captureCheck } from '../check-receipt.js'
import { resolve } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import type { PulseRuntime } from '@hunterzhu/pulse-runtime'

/** Host-side I/O, outside pure Runtime steps. Earlier edits remain historical evidence. */
export async function staleFileEvidence(root: string, refs: string[], runtime: PulseRuntime, checkRefs?: ReadonlySet<string>, snapshotRefs: readonly string[] = []): Promise<string[]> {
  const paths = new Map<string, { hash: string; refs: string[]; order: number }>()
  // Passed sibling stages can legitimately update a file inspected by a shared
  // preparatory dependency. Their receipts refresh file versions only; they do
  // not contribute successful checks or authorize acceptance of this stage.
  for (const ref of [...refs, ...snapshotRefs]) {
    const result = runtime.state.results.get(ref), value = result?.value
    const effect = result?.producer?.kind === 'effect' ? runtime.state.effects.get(result.producer.id) : undefined
    if (effect?.outcome?.status !== 'succeeded' || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const path = value.path ?? value.destination ?? (value.committed === true ? value.target : undefined), hash = value.hash ?? value.contentHash
    if (typeof path !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) continue
    const key = resolve(root, path), previous = paths.get(key), order = Number(ref.match(/(\d+)$/)?.[1] ?? 0)
    paths.set(key, { hash: previous && previous.order > order ? previous.hash : hash, order: Math.max(previous?.order ?? 0, order), refs: [...(previous?.refs ?? []), ref] })
  }
  const files = new FilesystemTool(root), stale: string[] = []
  const checks = new Map<string, { ref: string; receipt: Record<string, any>; order: number; passed: boolean }>()
  for (const ref of [...refs].sort((a, b) => Number(a.match(/(\d+)$/)?.[1] ?? 0) - Number(b.match(/(\d+)$/)?.[1] ?? 0))) {
    if (checkRefs && !checkRefs.has(ref)) continue
    const value = runtime.state.results.get(ref)?.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const receipt = value.checkReceipt
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue
    checks.set(JSON.stringify([receipt.command, receipt.args, receipt.cwd]), { ref, receipt, order: Number(ref.match(/(\d+)$/)?.[1] ?? 0), passed: value.code === 0 && !value.timedOut && !value.aborted && !value.truncated })
  }
  for (const { ref, receipt, order } of checks.values()) {
    if (!receipt.stable || receipt.definitionChanged || !receipt.files || typeof receipt.files !== 'object') { stale.push(ref); continue }
    // A later passing, unfiltered Node test over the entire import closure
    // supersedes older syntax/tests after a legitimate fix. A bare whole-suite
    // run and a named run have different keys above, but can cover the same
    // artifacts. The new receipt is still checked for external changes below;
    // syntax or filtered test runs can never replace full behavioral evidence.
    const nodeTest = (value: Record<string, any>) => value.command === 'node' && value.args?.[0] === '--test' && value.args.slice(1).every((arg: unknown) => typeof arg === 'string' && !arg.startsWith('-'))
    if (receipt.command === 'node' && (receipt.args?.[0] === '--check' || nodeTest(receipt)) && [...checks.values()].some(check => check.order > order && check.passed && check.receipt.stable && !check.receipt.definitionChanged && nodeTest(check.receipt) && Object.keys(receipt.files).every(path => typeof check.receipt.files?.[path] === 'string'))) continue
    const sorted = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    try {
      const current = await captureCheck(root, resolve(root, receipt.cwd), receipt.command, receipt.args)
      if (sorted(current.files) !== sorted(receipt.files) || sorted(current.definitions) !== sorted(receipt.definitions ?? {}) || sorted(current.environment) !== sorted(receipt.environment ?? {})) stale.push(ref)
    } catch { stale.push(ref) }
  }
  for (const [path, snapshot] of paths) if (await files.hash(path).catch(() => undefined) !== snapshot.hash) stale.push(...snapshot.refs)
  return [...new Set(stale)]
}
