import { detectResponseLanguage } from '../language.js'
import type { ControlledTask, TaskControllerState } from './state.js'

/** Terminal projection; the original Runtime checkpoint remains audit evidence. */
export function interruptedController(state: TaskControllerState, reason: string): TaskControllerState {
  const terminal = structuredClone(state)
  for (const stage of terminal.tasks) if (stage.status === 'running' || stage.status === 'verifying') {
    stage.status = 'blocked'
    stage.note = `RUN_INTERRUPTED: ${reason}. Settled evidence retained; no operation replayed.`
  }
  delete terminal.activeId
  delete terminal.activeIds
  return terminal
}

export function interruptedSummary(goal: string, state: TaskControllerState, reason: string, artifacts: (task: ControlledTask) => string[] = () => []): string {
  const zh = detectResponseLanguage(goal) === 'zh-CN'
  const done = state.tasks.filter(t => t.status === 'passed')
  const blocked = state.tasks.find(t => t.status === 'blocked' && t.attempts > 0)
  const waiting = state.tasks.filter(t => t.status !== 'passed' && t !== blocked)
  return [
    zh ? '任务未完成；已保留交付与检查点。' : 'Task incomplete; settled deliveries and checkpoint retained.',
    ...done.map(t => `${zh ? '阶段检查已通过' : 'Stage checks passed'}: ${t.id} ${t.goal}${artifacts(t).length ? `\n${zh ? '已落盘文件（未重新验收）' : 'Saved files (not reverified)'}: ${artifacts(t).join(', ')}` : ''}`),
    `${zh ? '首个阻塞' : 'First blocker'}: ${blocked ? `${blocked.id} ${blocked.goal}\n` : ''}${reason}`,
    ...(waiting.length ? [`${zh ? '未完成或未启动阶段' : 'Unfinished or unstarted stages'}: ${waiting.map(t => `${t.id} ${t.goal}`).join('; ')}`] : []),
    zh ? '整体验收未通过。失败检查仍为失败；不会自动重试。' : 'Overall acceptance is not established. Failed checks remain failed; no automatic retry.',
  ].join('\n\n')
}
