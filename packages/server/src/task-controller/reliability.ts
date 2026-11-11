import { contentHash, type JsonValue, type LaneProgramDefinition, type StepContext } from '@hunterzhu/pulse-runtime'
import type { ControlledTask, TaskControllerState } from './state.js'
import { officeWriteToolNames } from './office-evidence.js'
import { environmentBlock, checkTarget, checkMethod } from './stage-checks.js'

export interface ProgressCycle {
  seen: string[]
  processed: string[]
  noProgress: number
  phase: 'work' | 'correct' | 'alternative' | 'blocked'
}
export interface ReliabilityState {
  excludedRefs: string[]
  cycles: Record<string, ProgressCycle>
  freshness: Record<string, number>
  invalidations: Array<{ key: string; code: string; refs: string[]; targets: string[]; files: Array<{ path: string; hash: string }> }>
  environments: Record<string, { methods: string[]; refs: string[]; reason: string }>
  processedChecks: string[]
}
export const emptyReliability = (): ReliabilityState => ({ excludedRefs: [], cycles: {}, freshness: {}, invalidations: [], environments: {}, processedChecks: [] })
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
export const deliveryKey = (task: ControlledTask): string => [...task.criterionIds].sort().join('|')
const normalizeOutput = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?)\b/gi, '<duration>').replace(/(?:Start at|Duration|Time:|pid[:= ]).*$/gim, '').replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<time>').trim()
function shellInvocation(ctx: Pick<StepContext<JsonValue>, 'results'>, ref: string, refs: string[]) {
  const meta = ctx.results.meta(ref), body = record(ctx.results.read(ref))
  const start = meta?.toolName === 'shell.poll' && typeof body.processId === 'string'
    ? refs.find(candidate => ctx.results.meta(candidate)?.toolName === 'shell.start' && record(ctx.results.read(candidate)).processId === body.processId)
    : undefined
  const args = record(ctx.results.meta(start ?? ref)?.toolArguments)
  return { command: String(args.command ?? ''), args: Array.isArray(args.args) ? args.args.map(String) : [], cwd: String(args.cwd ?? '.') }
}

/** Only settled, relevant facts advance a cycle. A proposal or a new receipt ID does not. */
const VOLATILE_KEY = /^(?:id|ids|ref|refs|at|ms|[A-Za-z0-9]*[a-z0-9](?:Id|Ids|Ref|Refs|At|Ms)|time|timestamp|ts|(?:elapsed|duration|receipt|attempt).*|pid|nonce)$/
function stableObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObservation)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !VOLATILE_KEY.test(key)).map(([key, item]) => [key, stableObservation(item)]))
  return value
}

export function progressFacts(ctx: Pick<StepContext<JsonValue>, 'results'>, refs: string[]): string[] {
  return refs.flatMap(ref => {
    const meta = ctx.results.meta(ref), body = record(ctx.results.read(ref) ?? ctx.results.summary(ref))
    if (meta?.effectKind !== 'tool' || meta.outcomeStatus !== 'succeeded') return []
    const tool = meta.toolName ?? '', args = record(meta.toolArguments)
    if (body.error || body.ok === false || body.committed === false) return []
    if (tool === 'fs.read' && typeof body.hash === 'string') return [contentHash({ tool, path: body.path ?? args.path, hash: body.hash, offset: body.offset ?? args.offset ?? args.startLine ?? 0, end: body.nextOffset ?? body.nextLine ?? (typeof body.content === 'string' ? body.content.length : null) })]
    if (/^fs\.(write|apply_patch|apply_patches|overwrite|stage|move)$/.test(tool) || officeWriteToolNames.includes(tool as never) || tool === 'plan.write') {
      if (body.changed === false || body.alreadyApplied) return []
      const path = body.path ?? body.destination ?? args.path ?? args.destination
      if (typeof body.hash === 'string') return body.hash !== body.beforeHash ? [contentHash({ edit: path, hash: body.hash })] : []
      // A native receipt without a content hash cannot prove a new file version.
      return []
    }
    if (tool === 'shell.exec' || tool === 'shell.poll') {
      if (body.code !== 0 || body.timedOut || body.aborted) return []
      const invocation = shellInvocation(ctx, ref, refs)
      if (!invocation.command) return []
      const method = checkMethod(invocation), target = checkTarget(invocation)
      const receipt = record(body.checkReceipt)
      if (Object.keys(receipt).length) return [contentHash({ method, target, files: receipt.files, checks: receipt.checks, stdout: normalizeOutput(String(body.stdout ?? body.output ?? '')) })]
      return [contentHash({ method, target, output: normalizeOutput(String(body.stdout ?? body.output ?? '')) })]
    }
    if (/^fs\.(search|glob)$/.test(tool)) {
      const { query: _query, pattern: _pattern, ...facts } = body
      return [contentHash({ tool, path: body.path ?? args.path ?? '.', facts })]
    }
    if (/^(web|browser|computer)\./.test(tool)) return [contentHash({ tool, args, body })]
    // Other settled native observations (directory listings, office/document reads, git, LSP...) are new
    // evidence only when their own content is new. Refs, ids, times and receipts never count; an unchanged
    // repeat hashes identically, so the no-progress bound still applies.
    if (/^(?:task|plan|ask|work)\./.test(tool)) return []
    return [contentHash({ tool, body: stableObservation(body) })]
  })
}

export function observeCycle(cycle: ProgressCycle, round: string, facts: string[]): ProgressCycle {
  if (cycle.processed.includes(round)) return cycle
  const seen = new Set(cycle.seen), fresh = facts.some(key => !seen.has(key))
  facts.forEach(key => seen.add(key))
  const noProgress = fresh ? 0 : cycle.noProgress + 1
  return { seen: [...seen], processed: [...cycle.processed, round], noProgress, phase: fresh ? 'work' : noProgress >= 12 ? 'blocked' : noProgress >= 8 ? 'alternative' : noProgress >= 4 ? 'correct' : 'work' }
}

export function cycleGuidance(cycle: ProgressCycle): string | undefined {
  if (cycle.phase === 'blocked') return 'NO_PROGRESS: correction and one authorized alternative produced no new evidence; preserve completed work and report the blocker.'
  if (cycle.phase === 'alternative') return 'NO_PROGRESS_ALTERNATIVE: use one materially different authorized method. Do not repeat the same reads, patches, failed checks, or denied operations. Preserve completed work.'
  if (cycle.phase === 'correct') return 'NO_PROGRESS_CORRECTION: use the latest exact file window/hash and settled failures to correct the method. Do not restart discovery or repeat unchanged evidence.'
  return undefined
}

export function observeEnvironment(ledger: ReliabilityState, ctx: Pick<StepContext<JsonValue>, 'results'>, refs: string[]): string | undefined {
  for (const ref of refs) {
    if (ledger.processedChecks.includes(ref)) continue
    ledger.processedChecks.push(ref)
    const meta = ctx.results.meta(ref)
    if (!['shell.exec', 'shell.poll'].includes(meta?.toolName ?? '')) continue
    const invocation = shellInvocation(ctx, ref, refs)
    const body = record(ctx.results.read(ref)), failure = environmentBlock(invocation, body, meta?.outcomeStatus)
    if (!failure) {
      if (body.code === 0 && !body.aborted && !body.timedOut) for (const key of Object.keys(ledger.environments)) if (key.startsWith(checkTarget(invocation) + ':')) delete ledger.environments[key]
      continue
    }
    const previous = ledger.environments[failure.key]
    ledger.environments[failure.key] = { methods: [...new Set([...(previous?.methods ?? []), failure.method])], refs: [...(previous?.refs ?? []), ref], reason: failure.reason }
    if (ledger.environments[failure.key]!.refs.length >= 2) return `CHECK_ENVIRONMENT_BLOCKED: ${failure.reason} One authorized alternative has been exhausted; verification remains unaccepted.`
  }
  return undefined
}

/** Remove stale facts from active inputs, keeping the original Runtime records for audit. */
export function excludeEvidence(state: TaskControllerState, staleRefs: string[]): void {
  const ledger = state.reliability ??= emptyReliability()
  ledger.excludedRefs = [...new Set([...ledger.excludedRefs, ...staleRefs])]
  const stale = new Set(ledger.excludedRefs), keep = (refs: string[]) => refs.filter(ref => !stale.has(ref))
  for (const task of [...state.tasks, ...state.priorTasks]) {
    task.evidenceRefs = keep(task.evidenceRefs)
    if (task.contextRefs) task.contextRefs = keep(task.contextRefs)
    if (task.approvalContextRefs) task.approvalContextRefs = keep(task.approvalContextRefs)
    if (task.candidateRef && stale.has(task.candidateRef)) { delete task.candidateRef; delete task.candidateAttempt }
    if (task.hostCheckRefs) task.hostCheckRefs = Object.fromEntries(Object.entries(task.hostCheckRefs).filter(([, ref]) => !stale.has(ref)))
  }
  if (state.evidenceIndex) state.evidenceIndex = keep(state.evidenceIndex)
  if (state.acceptanceResults) state.acceptanceResults = state.acceptanceResults.filter(result => !result.ref || !stale.has(result.ref))
  if (state.finalReview) for (const verdict of state.finalReview) verdict.evidenceRefs = keep(verdict.evidenceRefs)
}

export function mergeReliability(state: TaskControllerState, child: ReliabilityState | undefined): void {
  if (!child) return
  const own = state.reliability ??= emptyReliability()
  for (const [key, cycle] of Object.entries(child.cycles)) {
    const previous = own.cycles[key]
    if (!previous || cycle.processed.length >= previous.processed.length) own.cycles[key] = cycle
  }
  Object.assign(own.freshness, child.freshness)
  for (const event of child.invalidations) if (!own.invalidations.some(previous => previous.key === event.key)) own.invalidations.push(event)
  own.processedChecks = [...new Set([...own.processedChecks, ...child.processedChecks])]
  for (const [key, value] of Object.entries(child.environments)) {
    const previous = own.environments[key]
    own.environments[key] = { ...value, methods: [...new Set([...(previous?.methods ?? []), ...value.methods])], refs: [...new Set([...(previous?.refs ?? []), ...value.refs])] }
  }
  excludeEvidence(state, child.excludedRefs)
}

export function evidenceFilteredProgram(definition: LaneProgramDefinition): LaneProgramDefinition {
  return { ...definition, step: ctx => {
    const local = record(ctx.lane.context.state), agent = ctx.state.agents.get(ctx.lane.agentId)
    const global = record(agent?.globalVersions.get(ctx.lane.contextSnapshotVersion))
    const controller = record(local.taskControllerChain ?? global.taskController)
    const ledger = record(local.taskControllerReliability ?? controller.reliability)
    const settled = Array.isArray(controller.tasks) && controller.tasks.length > 0 && controller.tasks.every((task: any) => ['passed', 'blocked'].includes(task.status))
    const terminal = controller.budgetStopped || controller.recoveryNoProgress >= 8 || Object.values(record(ledger.cycles)).some((cycle: any) => cycle.phase === 'blocked') || Object.values(record(ledger.environments)).some((block: any) => block.refs.length >= 2)
    // A pure terminal report needs no new model context. Do not ask the user to
    // compact merely to explain an already settled blocker. Stored history is
    // unchanged, and every continuing/model step keeps its confirmation rules.
    const unsettled = [...ctx.state.effects.values()].some(effect => effect.ownerLaneId === ctx.lane.id && !['succeeded', 'failed', 'cancelled'].includes(effect.state))
    // Only a lane that is already in the pure report step may drop its model context. Final review,
    // source audits and frozen checks are earlier steps whose obligations a terminal flag must not swallow;
    // the report step itself still owns not-yet-run frozen checks.
    const checks = record(global.taskRecord).acceptanceChecks
    const checksPending = Array.isArray(checks) && checks.length > 0 && controller.acceptanceResults === undefined
    const finalize = ctx.lane.resume.step === 'report' && settled && terminal && !checksPending && !ctx.lane.activeWaitId && !unsettled
    const stepContext = finalize ? { ...ctx, lane: { ...ctx.lane, context: { ...ctx.lane.context, history: [] } } } : ctx
    const result = definition.step(stepContext)
    const refs = Array.isArray(ledger.excludedRefs) ? ledger.excludedRefs.filter((r: unknown): r is string => typeof r === 'string') : []
    if (!refs.length) return result
    const stale = new Set(refs)
    const filter = (value: JsonValue): JsonValue => Array.isArray(value) ? value.filter(item => !(typeof item === 'string' && stale.has(item))).map(filter) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filter(item)])) : value
    return { ...result, ...(result.actions ? { actions: result.actions.map(action => action.type !== 'submit_effects' ? action : { ...action, effects: action.effects.map(effect => effect.kind !== 'llm' ? effect : { ...effect, input: { ...record(filter(effect.input)), excludedResultRefs: refs } }) }) } : {}) }
  } }
}
