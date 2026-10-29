import { coversUnavailablePythonCheck } from './check-coverage.js'
import { copyChanges } from './copy-evidence.js'
import { inPlaceChanges } from './inplace-evidence.js'
import { captureCheck } from '../check-receipt.js'
import { resolve } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import type { PulseRuntime } from '@hunterzhu/pulse-runtime'

/** Host-side I/O, outside pure Runtime steps. Earlier edits remain historical evidence. */
export async function staleFileEvidence(root: string, refs: string[], runtime: PulseRuntime, checkRefs?: ReadonlySet<string>, snapshotRefs: readonly string[] = [], originalText = '', currentChecksRefreshSnapshots = false): Promise<string[]> {
  const paths = new Map<string, { hash: string; refs: string[]; order: number }>()
  // Passed sibling stages can legitimately update a file inspected by a shared
  // preparatory dependency. Their receipts refresh file versions only; they do
  // not contribute successful checks or authorize acceptance of this stage.
  for (const ref of [...refs, ...snapshotRefs].sort((a, b) => Number(a.match(/(\d+)$/)?.[1] ?? 0) - Number(b.match(/(\d+)$/)?.[1] ?? 0))) {
    const result = runtime.state.results.get(ref), value = result?.value
    const effect = result?.producer?.kind === 'effect' ? runtime.state.effects.get(result.producer.id) : undefined
    if (effect?.outcome?.status === 'succeeded' && effect.kind === 'tool' && effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) && ['shell.exec', 'shell.poll'].includes(String(effect.input.name))) {
      for (const entry of inPlaceChanges(value ?? result?.summary)) {
        const key = resolve(root, entry.path), previous = paths.get(key), order = Number(ref.match(/(\d+)$/)?.[1] ?? 0)
        // A command's receipt refreshes only the exact version it observed.
        if (previous && previous.order < order && previous.hash === entry.beforeHash) paths.set(key, { hash: entry.hash, order, refs: [...previous.refs, ref] })
      }
      for (const entry of copyChanges(value ?? result?.summary)) for (const [path, hash] of [[entry.path, entry.hash], [entry.source, entry.sourceHash]]) {
        const key = resolve(root, path!), previous = paths.get(key), order = Number(ref.match(/(\d+)$/)?.[1] ?? 0)
        paths.set(key, { hash: previous && previous.order > order ? previous.hash : hash!, order: Math.max(previous?.order ?? 0, order), refs: [...(previous?.refs ?? []), ref] })
      }
    }
    if (effect?.outcome?.status !== 'succeeded' || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const path = value.path ?? value.destination ?? (value.committed === true ? value.target : undefined), hash = value.hash ?? value.contentHash
    if (typeof path !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) continue
    const key = resolve(root, path), previous = paths.get(key), order = Number(ref.match(/(\d+)$/)?.[1] ?? 0)
    paths.set(key, { hash: previous && previous.order > order ? previous.hash : hash, order: Math.max(previous?.order ?? 0, order), refs: [...(previous?.refs ?? []), ref] })
  }
  const files = new FilesystemTool(root), stale: string[] = []
  const checks = new Map<string, { ref: string; receipt: Record<string, any>; order: number; passed: boolean; value: any }>()
  for (const ref of [...refs].sort((a, b) => Number(a.match(/(\d+)$/)?.[1] ?? 0) - Number(b.match(/(\d+)$/)?.[1] ?? 0))) {
    if (checkRefs && !checkRefs.has(ref)) continue
    const value = runtime.state.results.get(ref)?.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const receipt = value.checkReceipt
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue
    checks.set(JSON.stringify([receipt.command, receipt.args, receipt.cwd]), { ref, receipt, order: Number(ref.match(/(\d+)$/)?.[1] ?? 0), value, passed: value.code === 0 && !value.timedOut && !value.aborted && !value.truncated })
  }
  for (const { ref, receipt, order, value } of checks.values()) {
    if ([...checks.values()].some(next => next.order > order && coversUnavailablePythonCheck(receipt as any, value, next.receipt as any, next.value, originalText))) continue
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
      const current = await captureCheck(root, resolve(root, receipt.cwd), receipt.command, receipt.args, false, receipt.schemaVersion === 4 ? 4 : receipt.schemaVersion === 3 ? 3 : receipt.schemaVersion === 2 ? 2 : 1, receipt.scope)
      if (sorted(current.files) !== sorted(receipt.files) || sorted(current.definitions) !== sorted(receipt.definitions ?? {}) || sorted(current.environment) !== sorted(receipt.environment ?? {})) stale.push(ref)
      else if (currentChecksRefreshSnapshots && value.code === 0 && !value.timedOut && !value.aborted && !value.truncated && receipt.unresolvedInputs !== true) {
        // A passing check refreshes only document artifacts it actually resolved
        // and hashed. Import-closure sources keep their earlier fs.read version,
        // and a failed or unbound check cannot turn that snapshot into a pass.
        const reads = Array.isArray(receipt.readInputs) ? receipt.readInputs : []
        for (const path of reads) {
          if (typeof path !== 'string' || !isDocumentArtifact(path)) continue
          const hash = receipt.files[path]
          if (typeof hash !== 'string') continue
          const key = resolve(root, path), previous = paths.get(key)
          if (previous && previous.order < order) paths.set(key, { hash, order, refs: previous.refs })
        }
      }
    } catch { stale.push(ref) }
  }
  for (const [path, snapshot] of paths) if (await files.hash(path).catch(() => undefined) !== snapshot.hash) stale.push(...snapshot.refs)
  return [...new Set(stale)]
}

export const isDocumentArtifact = (path: string): boolean => /\.(?:pptx|docx|xlsx|pdf|png|jpe?g|webp|svg)$/i.test(path)

/** Actual statically resolved reads, rather than a script name or an argv claim. */
export function mismatchedArtifactChecks(root: string, refs: string[], runtime: PulseRuntime, targets: readonly string[]): string[] {
  const expected = new Set(targets.filter(isDocumentArtifact).map(path => resolve(root, path)))
  return refs.filter(ref => {
    const result = runtime.state.results.get(ref), value = result?.value
    const effect = result?.producer?.kind === 'effect' ? runtime.state.effects.get(result.producer.id) : undefined
    if (effect?.kind !== 'tool' || effect.outcome?.status !== 'succeeded' || !value || typeof value !== 'object' || Array.isArray(value) || value.code !== 0) return false
    const receipt = value.checkReceipt
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.schemaVersion !== 4) return false
    const reads = Array.isArray(receipt.readInputs) ? receipt.readInputs.filter((p): p is string => typeof p === 'string' && isDocumentArtifact(p)) : []
    // A resolved source-only check attests to source, not a document. An
    // unresolved read cannot prove a document target even when argv names none.
    const declared = new Set((Array.isArray(receipt.args) ? receipt.args : []).filter((p): p is string => typeof p === 'string' && isDocumentArtifact(p)).map(p => resolve(root, String(receipt.cwd ?? '.'), p)))
    const targets = expected.size ? expected : declared
    const files = receipt.files && typeof receipt.files === 'object' && !Array.isArray(receipt.files) ? receipt.files : {}
    if (receipt.unresolvedInputs === true && (expected.size > 0 || declared.size > 0)) return true
    if (reads.length === 0) return false
    return !reads.some(path => targets.has(resolve(root, path)) && (!declared.size || declared.has(resolve(root, path))) && typeof files[path] === 'string')
  })
}
