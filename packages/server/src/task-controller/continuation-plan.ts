import type { Checkpoint } from './checkpoint.js'
import type { ControlledTask, PlannedTask } from './state.js'

/** These are verification candidates, never automatic passes or fresh executions. */
export function continuationCandidates(tasks: PlannedTask[], checkpoint: Checkpoint, objective: string, continuationRequest = objective): Array<PlannedTask & Pick<ControlledTask, 'retainedArtifactVerification'>> {
  if (checkpoint.continuationVersion !== 2) return tasks
  const requested = continuationRequest.replace(/(?:不要|不得|无需|禁止|不必|不需要)\s*(?:复跑|重跑|重复执行|再次运行)|\b(?:do not|don't|never|without)\s+(?:rerun|repeat|run again)\b/gi, '')
  if (/复跑|重跑|重复执行|再次运行|\b(?:rerun|repeat|run again)\b/i.test(requested)) return tasks
  const paths = Object.keys(checkpoint.stamp.files)
  const written = new Set((checkpoint.facts ?? []).filter(f => ['fs.write', 'fs.apply_patch', 'fs.apply_patches'].includes(f.tool)).flatMap(f => {
    const body = f.result as { path?: string }
    return typeof body.path === 'string' ? [body.path] : []
  }))
  const commands = checkpoint.completedCommands ?? []
  const candidates = tasks.map(task => {
    const text = `${task.goal}\n${task.check}`
    const mentioned = paths.filter(path => text.includes(path))
    const named = [...text.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w.-]*/g)].map(match => match[0])
    const completeNamedScope = named.length > 0 && named.every(path => paths.includes(path))
    const requestsWrite = /^\s*(?:编写|创建|新增|修改|更新|写入|实现|\b(?:create|write|implement|modify|patch|update|add)\b)/i.test(task.goal)
    const priorWrite = requestsWrite && completeNamedScope && mentioned.some(path => written.has(path))
    const priorCommand = completeNamedScope && commands.some(command => Object.keys(command.scriptHashes).some(path => text.includes(path)))
    if (!priorWrite && !priorCommand) return task
    return { ...task, kind: 'verify' as const, retainedArtifactVerification: true,
      goal: `Read-only verify retained artifacts against the original requested contract: ${task.goal}`.slice(0, 700),
      check: `Read current retained files (${mentioned.join(', ')}); verify their contents against the original objective and criterion IDs. Historical command receipts record earlier execution, not fresh checks. Do not recreate files or replay successful generators.`.slice(0, 500) }
  })
  // A planner cannot invent a final replay absent from the caller's objective.
  // Retain concrete new deliverables and any uniquely covered criterion.
  if (candidates.length > 1 && !/复跑|重跑|重复执行|再次运行|\b(?:rerun|repeat|run again)\b/i.test(objective)) {
    const last = candidates.at(-1)!
    const covered = new Set(candidates.slice(0, -1).flatMap(task => task.criterionIds))
    if (/^(?:按顺序)?(?:复跑|重跑|重复执行)|\b(?:rerun|repeat)\b/i.test(last.goal) && !/[\w.-]+(?:\/[\w.-]+)+\.[\w.-]+/.test(last.goal) && last.criterionIds.every(id => covered.has(id)) && !/生成|写入|创建|汇总|\b(?:create|write|generate|summarize)\b/i.test(last.goal)) candidates.pop()
  }
  return candidates
}

export function requiresBaselineTestRemoval(tasks: PlannedTask[]): boolean {
  return tasks.some(task => {
    const text = `${task.goal}\n${task.check}`
    return /(?:test\/|tests\/|\.test\.|测试|\btests?\b)/i.test(text) && (/(?:替换|删除|移除|\b(?:replace|remove|delete)\b)[^。；\n]{0,70}(?:占位|基线|placeholder|baseline)/i.test(text) || /(?:占位(?:用例|测试)|基线测试|(?:placeholder|baseline)[^.;\n]{0,20}(?:test|case))[^。；\n]{0,50}(?:替换|删除|移除|\b(?:replace|remove|delete)\b)/i.test(text))
  })
}
