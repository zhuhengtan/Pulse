import type { TaskOutcome } from '../task.js'
import { isCascadeBlocked, rootBlockedDependency, type ControlledTask, type TaskControllerState } from './state.js'

/** Keep criterion assessments intact; the human projection expands each cause once. */
export function controllerReport(state: TaskControllerState, criteria: TaskOutcome['criteria'], accepted: boolean, zh: boolean, artifacts: (t: ControlledTask) => string[], candidate: (t: ControlledTask) => string | undefined, auditedCandidateOnly = false): string {
  const parts = [accepted ? (zh ? '任务逐项验收通过。' : 'All task stages accepted.') : (zh ? '任务尚未全部完成，已保留完成项与阻塞原因。' : 'Task incomplete; completed work and blockers retained.')]
  const roots = state.tasks.filter(t => t.status === 'blocked' && !isCascadeBlocked(t, state.tasks))
  const expanded = new Set<string>()
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
  const emit = (s: string): string => {
    const key = normalize(s)
    if (!key || expanded.has(key)) return ''
    expanded.add(key); return s
  }
  for (const [i, t] of roots.entries()) {
    const reason = emit(t.note ?? t.status)
    parts.push(`${zh ? i === 0 ? '首个阻塞' : '其他阻塞' : i === 0 ? 'First blocker' : 'Other blocker'}: ${t.id} ${t.goal}${reason ? `\n${reason}` : ''}`)
  }
  const failures = new Map<string, string[]>()
  for (const c of criteria) {
    // A cascade refers to the actual failed stage instead of copying its text.
    const assigned = state.tasks.filter(t => t.criterionIds.includes(c.criterionId))
    const blocked = [...new Set(assigned.filter(t => t.status === 'blocked').map(t => (isCascadeBlocked(t, state.tasks) ? rootBlockedDependency(t, state.tasks) ?? t : t).id))]
    parts.push(`${c.criterionId}: ${c.status}${c.evidenceRefs.length ? ` [${c.evidenceRefs.join(', ')}]` : ''}${blocked.length ? ` (${zh ? '关联阻塞' : 'blocked by'}: ${blocked.join(', ')})` : ''}`)
    if (c.status === 'passed') continue
    const reason = normalize(c.rationale)
    const described = roots.some(t => reason === normalize(t.note ?? '') || reason === `${t.id}: ${normalize(t.note ?? '')}` || assigned.length > 0 && assigned.every(a => a.status === 'blocked') && reason === assigned.map(a => `${a.id}: ${normalize((isCascadeBlocked(a, state.tasks) ? rootBlockedDependency(a, state.tasks) : a)?.note ?? a.status)}`).join(' '))
    if (!described && !expanded.has(reason)) failures.set(reason, [...(failures.get(reason) ?? []), c.criterionId])
  }
  for (const [reason, ids] of failures) { const text = emit(reason); if (text) parts.push(`${ids.join(', ')}: ${text}`) }
  for (const t of state.tasks.filter(t => t.status === 'passed')) {
    if (auditedCandidateOnly) {
      const body = candidate(t)
      if (body) { const delivery = emit(body); if (delivery) parts.push(delivery) }
      continue
    }
    const note = emit(!accepted && roots.length ? (zh ? '阶段检查已通过；整体验收仍未通过。' : 'Stage checks passed; overall acceptance remains incomplete.') : t.note ?? t.status), body = candidate(t), delivery = body ? emit(body) : ''
    parts.push(`✓ ${t.id} ${t.goal}${note ? `\n${note}` : ''}${delivery ? `\n${delivery}` : ''}`)
  }
  for (const t of state.tasks) {
    const paths = artifacts(t)
    if (paths.length) parts.push(`${zh ? '已落盘文件' : 'Saved files'} (${t.id}): ${[...new Set(paths)].join(', ')}`)
  }
  const unstarted = state.tasks.filter(t => t.attempts === 0 && t.status !== 'passed')
  if (unstarted.length) parts.push(`${zh ? '未启动阶段' : 'Unstarted stages'}: ${unstarted.map(t => `${t.id} ${t.goal}`).join('; ')}`)
  if (!accepted) parts.push(zh ? '整体验收未通过。失败检查保持失败；未执行的操作不计为完成。' : 'Overall acceptance remains incomplete. Failed checks remain failed; unexecuted operations are not completed work.')
  return parts.filter(Boolean).join('\n\n')
}
