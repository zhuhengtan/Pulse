import { toolEvidenceHash, type JsonValue, type StepContext } from '@hunterzhu/pulse-runtime'
import type { ControlledTask } from './state.js'

/** One observation per worker call, retained across verifier and lane retries. */
export function observeStageProgress(task: ControlledTask, ctx: Pick<StepContext<JsonValue>, 'results'>): void {
  const calls = task.modelCalls ?? 0
  const previous = task.progress ?? { hashes: [], processedCalls: 0, noProgress: 0 }
  if (calls <= previous.processedCalls) return
  const hashes = new Set(previous.hashes)
  let fresh = false
  for (const ref of task.evidenceRefs) {
    const meta = ctx.results.meta(ref)
    if (meta?.effectKind !== 'tool' && meta?.effectKind !== 'human') continue
    const hash = toolEvidenceHash(meta, ctx.results.read(ref) ?? null)
    if (!hashes.has(hash)) { fresh = true; hashes.add(hash) }
  }
  task.progress = { ...previous, hashes: [...hashes].slice(-128), processedCalls: calls, noProgress: fresh ? 0 : previous.noProgress + 1 }
}

export function stageProgressBlock(task: ControlledTask): string | undefined {
  return (task.progress?.noProgress ?? 0) >= 4 ? 'NO_PROGRESS: four worker rounds without new settled evidence across work and verification; checkpoint retained.' : undefined
}
