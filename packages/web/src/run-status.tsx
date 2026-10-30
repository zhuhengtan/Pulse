import { presentRun, shellProcessPending } from '@hunterzhu/pulse-server/run-presentation'

export type SnapshotRuntimeState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** Terminal snapshots without a completion payload stay conservative. Running has no terminal label. */
export function missingCompleteStatus(state: SnapshotRuntimeState): { outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; label: string } | undefined {
  if (state === 'running') return undefined
  if (state === 'interrupted') return { outcome: 'interrupted', label: '任务已中断，没有自动恢复' }
  if (state === 'failed') return { outcome: 'failed', label: presentRun({ state: 'failed' }).label }
  if (state === 'cancelled') return { outcome: 'cancelled', label: presentRun({ state: 'cancelled' }).label }
  return { outcome: 'succeeded', label: presentRun({ state: 'succeeded' }).label }
}

export interface CompactRunInput {
  running: boolean
  completeLabel?: string | undefined
  interaction?: 'ask' | 'approval' | undefined
  steps: Array<{ kind: string; tool?: string | undefined; status?: string | undefined; preview?: object | undefined }>
  /** Used when the trace has not arrived and the restored tool list is the only evidence. */
  latestToolPending?: boolean | undefined
}

/** Completion replaces waiting. A later non-process step replaces an older shell wait. */
export function compactRunLabel(input: CompactRunInput): string | undefined {
  if (input.completeLabel) return input.completeLabel
  if (!input.running) return undefined
  if (input.interaction === 'ask') return presentRun({ state: 'running', waiting: 'input' }).label
  if (input.interaction === 'approval') return presentRun({ state: 'running', waiting: 'approval' }).label
  const latest = input.steps.at(-1)
  if (latest?.kind === 'tool' && shellProcessPending(latest.tool, latest.status, latest.preview)) return presentRun({ state: 'running', waiting: 'process' }).label
  if (latest) return presentRun({ state: 'running' }).label
  if (input.latestToolPending) return presentRun({ state: 'running', waiting: 'process' }).label
  return presentRun({ state: 'running' }).label
}

export function ConnectionMark({ paired, serviceConnected }: { paired: boolean; serviceConnected: boolean }) {
  const label = !paired ? '设备未授权' : serviceConnected ? '服务已连接' : '服务未连接'
  return <span className={`status-dot ${paired && serviceConnected ? '' : 'offline'}`} role="status" aria-label={label} title={label} />
}

export function CompactRunStatus({ label }: { label?: string | undefined }) {
  if (!label) return null
  return <span className="run-phase" role="status" aria-label={label}>{label}</span>
}
