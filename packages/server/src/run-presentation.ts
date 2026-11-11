/** Browser-safe presentation of execution and business acceptance. No runtime authority. */
export type TaskAcceptance = 'accepted' | 'incomplete' | 'unverifiable' | 'failed' | 'cancelled'
export interface RunCompletion {
  status: 'succeeded' | 'failed' | 'cancelled'
  /** false explicitly identifies a turn without a business acceptance contract. */
  taskRequired?: boolean
  taskOutcome?: { status: TaskAcceptance; reviewStatus?: 'passed' | 'needs_work' | 'unavailable' | 'skipped' }
  errorCode?: string
}
export type RunPresentationState = 'executing' | 'waiting-input' | 'waiting-approval' | 'waiting-process' | 'interrupted' | 'accepted' | 'finished' | 'incomplete' | 'unverifiable' | 'failed' | 'cancelled'
export interface RunPresentation { state: RunPresentationState; label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; terminal: boolean }
/** Only allowlisted public fields cross client and persisted-notice boundaries. */
export function runCompletion(value: unknown): RunCompletion {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const task = data.taskOutcome && typeof data.taskOutcome === 'object' ? data.taskOutcome as Record<string, unknown> : undefined
  const acceptance = ['accepted', 'incomplete', 'unverifiable', 'failed', 'cancelled'].includes(String(task?.status)) ? task!.status as TaskAcceptance : undefined
  const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : undefined
  const code = typeof data.errorCode === 'string' ? data.errorCode : typeof error?.code === 'string' ? error.code : undefined
  return { status: data.status === 'succeeded' || data.status === 'cancelled' ? data.status : 'failed', ...(typeof data.taskRequired === 'boolean' ? { taskRequired: data.taskRequired } : {}), ...(acceptance ? { taskOutcome: { status: acceptance, ...(['passed', 'needs_work', 'unavailable', 'skipped'].includes(String(task?.reviewStatus)) ? { reviewStatus: task!.reviewStatus as 'passed' | 'needs_work' | 'unavailable' | 'skipped' } : {}) } } : {}), ...(code ? { errorCode: code.slice(0, 120) } : {}) }
}
export function presentRun(input: { state: 'running' | 'interrupted' | RunCompletion['status']; completion?: RunCompletion; waiting?: 'input' | 'approval' | 'process' }): RunPresentation {
  if (input.state === 'interrupted') return { state: 'interrupted', label: '任务已中断，可检查后恢复', tone: 'warning', terminal: false }
  if (input.state === 'running') {
    const state = input.waiting === 'input' ? 'waiting-input' : input.waiting === 'approval' ? 'waiting-approval' : input.waiting === 'process' ? 'waiting-process' : 'executing'
    return { state, label: { 'waiting-input': '等待你的回答', 'waiting-approval': '等待审批', 'waiting-process': '等待进程', executing: '执行中' }[state], tone: 'neutral', terminal: false }
  }
  if (input.state === 'failed') return { state: 'failed', label: `任务执行失败${input.completion?.errorCode ? ` · ${input.completion.errorCode}` : ''}`, tone: 'danger', terminal: true }
  if (input.state === 'cancelled') return { state: 'cancelled', label: '任务已取消', tone: 'neutral', terminal: true }
  const task = input.completion?.taskOutcome?.status
  if (task === 'incomplete') return { state: 'incomplete', label: '任务未完成', tone: 'warning', terminal: true }
  if (task === 'failed') return { state: 'failed', label: '任务执行失败', tone: 'danger', terminal: true }
  if (task === 'cancelled') return { state: 'cancelled', label: '任务已取消', tone: 'neutral', terminal: true }
  if (!task && input.completion?.taskRequired === false) return { state: 'finished', label: '回复完成', tone: 'neutral', terminal: true }
  if (input.completion?.taskOutcome?.reviewStatus === 'skipped') return { state: 'unverifiable', label: '已结束，未复核', tone: 'neutral', terminal: true }
  if (input.completion?.taskOutcome?.reviewStatus === 'unavailable') return { state: 'unverifiable', label: '复核暂不可用，已保留工作结果', tone: 'warning', terminal: true }
  if (task === 'accepted') return { state: 'accepted', label: '任务验收通过', tone: 'success', terminal: true }
  return { state: 'unverifiable', label: task === 'unverifiable' ? '任务结果无法核验' : '运行已结束，验收状态未知', tone: 'warning', terminal: true }
}

/** A successful shell.start/poll can still leave the process running. Exited or unknown does not. */
export function shellProcessPending(tool: string | undefined, toolStatus: string | undefined, preview: object | undefined): boolean {
  const processStatus = preview && 'status' in preview ? preview.status : undefined
  if (tool !== 'shell.start' && tool !== 'shell.poll') return false
  if (processStatus === 'exited' || processStatus === 'unknown') return false
  if (processStatus === 'running') return true
  return toolStatus === 'running'
}

/** Public process preview. Command, process id, and other receipt fields stay off the wire. */
export function publicShellProcessPreview(record: { status?: unknown; output?: unknown; truncated?: unknown }): { status: 'running' | 'exited' | 'unknown'; output?: string; truncated?: true } | undefined {
  const status = record.status === 'running' || record.status === 'exited' || record.status === 'unknown' ? record.status : undefined
  if (!status) return undefined
  const output = typeof record.output === 'string' && record.output ? record.output : undefined
  return { status, ...(output ? { output } : {}), ...(record.truncated === true ? { truncated: true } : {}) }
}

/** Live one-shot and resume text. A missing task outcome is an explicit taskless turn. */
export function humanRunPresentation(outcome: { status: RunCompletion['status']; error?: { code?: string } }, taskOutcome: { status?: string } | null | undefined): RunPresentation {
  const completion = runCompletion({ status: outcome.status, taskRequired: taskOutcome != null, ...(taskOutcome ? { taskOutcome } : {}), ...(outcome.error?.code ? { error: { code: outcome.error.code } } : {}) })
  return presentRun({ state: completion.status, completion })
}

/** Read-only projection shared by CLI events, Web and Desktop. */
export interface RunHealth {
  execution: 'executing' | 'recovering' | 'waiting' | 'finished'
  acceptance: 'pending' | 'verifying' | 'accepted' | 'incomplete' | 'unverifiable'
  environment: 'unknown' | 'recovering' | 'waiting'
  recoveryAttempts: number
  reason?: string
  nextAction?: string
}
export function projectRunHealth(input: {
  tasks: Array<{ status: string; nextAction?: string; correctionKind?: string; failure?: { code: string; category: string; action: string; recoverable: boolean } }>
  reliability?: { cycles: Record<string, { phase: string }>; environments: Record<string, { refs: string[] }> }
  goalRecoveries: number
  recoveryAttempts?: Array<{ result: string; failures: Array<{ code: string; category: string; action: string; recoverable: boolean }> }>
  actualBudget?: { workAllowed: boolean }
  recoveryNoProgress?: number
}, outcome?: TaskAcceptance): RunHealth {
  const recovery = input.recoveryAttempts?.at(-1)
  // Every known failure counts. A recoverable first failure must not hide a later
  // non-recoverable or currently blocking one; this is a projection only.
  const known = [...(recovery?.failures ?? []), ...input.tasks.filter(task => task.status !== 'passed').flatMap(task => task.failure ? [task.failure] : [])]
  const failure = outcome === 'accepted' ? undefined : known.find(item => !item.recoverable) ?? known[0]
  const terminal = outcome !== undefined
  const waiting = !terminal && (input.actualBudget?.workAllowed === false && input.tasks.some(task => task.status !== 'passed' && task.status !== 'verifying') || (input.recoveryNoProgress ?? 0) >= 8 || failure?.recoverable === false || !!input.reliability && (Object.values(input.reliability.cycles).some(cycle => cycle.phase === 'blocked') || Object.values(input.reliability.environments).some(block => block.refs.length >= 2)))
  return {
    execution: terminal ? 'finished' : waiting ? 'waiting' : recovery?.result === 'pending' ? 'recovering' : 'executing',
    acceptance: outcome === 'accepted' ? 'accepted' : terminal ? outcome === 'unverifiable' ? 'unverifiable' : 'incomplete' : input.tasks.some(task => task.status === 'verifying') ? 'verifying' : 'pending',
    environment: failure && ['environment', 'provider', 'permission', 'uncertain'].includes(failure.category) ? terminal || waiting ? 'waiting' : 'recovering' : 'unknown',
    recoveryAttempts: input.goalRecoveries + (input.reliability ? Object.values(input.reliability.cycles).reduce((n, cycle) => n + (cycle.phase === 'work' ? 0 : cycle.phase === 'correct' ? 1 : 2), 0) + Object.values(input.reliability.environments).filter(block => block.refs.length > 1).length : 0),
    ...(failure ? { reason: failure.code, nextAction: failure.action } : {}),
  }
}

export function completeRunHealth(health: RunHealth, outcome?: TaskAcceptance): RunHealth {
  const next: RunHealth = { ...health, execution: 'finished', acceptance: outcome === 'accepted' ? 'accepted' : outcome === 'unverifiable' ? 'unverifiable' : 'incomplete' }
  if (outcome === 'accepted') { next.environment = 'unknown'; delete next.reason; delete next.nextAction }
  return next
}
