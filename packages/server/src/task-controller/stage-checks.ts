import type { JsonValue, StepContext } from '@hunterzhu/pulse-runtime'
import type { TaskRecord } from '../task.js'
import { assessAcceptanceResult, type AcceptanceCheck } from './acceptance.js'
import type { ControlledTask } from './state.js'

/** Names refer to frozen Host checks, never to guessed worker-visible files. */
export function namedHostChecks(record: TaskRecord | undefined, task: ControlledTask): AcceptanceCheck[] {
  return (record?.acceptanceChecks ?? []).filter(check => check.criterionIds.some(id => task.criterionIds.includes(id)) && check.expectedChecks.some(id => `${task.goal}\n${task.check}`.includes(id)))
}

export function stageCheckFailure(ctx: Pick<StepContext<JsonValue>, 'results'>, task: ControlledTask, checks: AcceptanceCheck[]): string | undefined {
  for (const check of checks) {
    const result = assessAcceptanceResult(ctx, check, task.hostCheckRefs?.[check.id])
    if (result.status === 'unverifiable') return `INDEPENDENT_ACCEPTANCE_UNAVAILABLE: ${check.id}: ${result.reason}`
    const relevant = check.expectedChecks.filter(id => `${task.goal}\n${task.check}`.includes(id))
    const failed = result.checks?.filter(row => relevant.includes(row.id) && !row.passed)
    if (failed?.length) return `INDEPENDENT_ACCEPTANCE_FAILED: ${failed.map(r => `${r.id}: ${r.detail ?? 'failed'}`).join('; ')}`
  }
  return undefined
}

/** Existing implementation needs current native file hashes AND full frozen proof. */
export function existingContractEvidence(ctx: Pick<StepContext<JsonValue>, 'results'>, task: ControlledTask, checks: AcceptanceCheck[]): boolean {
  const targets = [...new Set(task.goal.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|md|json)\b/g) ?? [])]
  if (!targets.length) return false
  return checks.some(check => {
    if (!task.criterionIds.every(id => check.criterionIds.includes(id))) return false
    const ref = task.hostCheckRefs?.[check.id]
    if (assessAcceptanceResult(ctx, check, ref).status !== 'passed') return false
    const value = ref ? ctx.results.read(ref) : undefined
    const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value.checkReceipt : undefined
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.stable !== true || receipt.definitionChanged !== false) return false
    const files = receipt.files
    if (!files || typeof files !== 'object' || Array.isArray(files)) return false
    return targets.every(target => {
      const matches = task.evidenceRefs.flatMap(r => {
        const meta = ctx.results.meta(r), body = ctx.results.read(r)
        if (meta?.toolName !== 'fs.read' || meta.outcomeStatus !== 'succeeded' || !body || typeof body !== 'object' || Array.isArray(body) || typeof body.path !== 'string' || typeof body.hash !== 'string') return []
        return (body.path === target || body.path.endsWith(`/${target}`)) && files[body.path] === body.hash ? [body.path] : []
      })
      return new Set(matches).size === 1
    })
  })
}

/** A successful unfiltered named Node suite covers an earlier explicit subset. */
export function coversNamedNodeTests(previous: JsonValue | undefined, current: JsonValue | undefined): boolean {
  const parse = (input: JsonValue | undefined) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.command !== 'node' || !Array.isArray(input.args) || input.args[0] !== '--test') return undefined
    const files = input.args.slice(1)
    if (!files.length || !files.every(p => typeof p === 'string' && p.length > 0 && !p.startsWith('-') && !/[*?\[\]{}]/.test(p))) return undefined
    return { cwd: input.cwd ?? '.', files: files as string[] }
  }
  const before = parse(previous), after = parse(current)
  return !!before && !!after && before.cwd === after.cwd && before.files.every(file => after.files.includes(file))
}
