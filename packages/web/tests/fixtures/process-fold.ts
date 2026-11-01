import { routingFixture } from './routing.js'
import type { WebMessage, WebRunEvent } from '../../src/transport.js'

/** Product-level fixture: every request is handled in memory, with no backend or provider. */
export function processFoldFixture(stopped: 'accepted' | 'budget' = 'accepted') {
  const base = routingFixture(), original = base.transport.request
  const now = '2026-11-01T01:00:00Z', calls: string[] = []
  const runIds = ['round-one', 'round-two']
  const conversation = { id: 'pulse-chat', title: '过程折叠与任务交付', cwd: '/example/Pulse', projectId: 'pulse', createdAt: now, updatedAt: now }
  const messages: WebMessage[] = [
    { id: 'user-one', role: 'user', runId: runIds[0]!, text: '检查并修复项目中的置顶功能。', createdAt: now },
    { id: 'final-one', role: 'assistant', runId: runIds[0]!, text: '已修复置顶状态保存，相关模拟测试通过。', createdAt: now },
    { id: 'user-two', role: 'user', runId: runIds[1]!, text: '继续，检查移动端的显示效果。', createdAt: now },
    { id: 'final-two', role: 'assistant', runId: runIds[1]!, text: stopped === 'budget' ? '调用额度已用尽，当前任务尚未完成；已有改动与检查点已保留。' : '已完成移动端检查，布局与交互符合要求。', createdAt: now },
  ]
  const traces = runIds.map((runId, i) => ({ runId, events: [
    { type: 'trace', runId, seq: 1, runStartedAt: 1_000, timestamp: 2_000, data: { kind: 'note', effectId: 'inspect', laneId: 'root', task: 'reason', text: i ? '正在检查移动端的布局与滚动行为。' : '已找到状态保存入口，接下来检查回归用例。' } },
    { type: 'tool', runId, seq: 2, runStartedAt: 1_000, timestamp: 3_000, data: { activityId: 'test', effectId: 'test', laneId: 'root', tool: 'shell.exec', status: 'succeeded', args: { command: 'node', args: ['--test', 'fixture.test.mjs'] }, preview: { output: 'All local fixture tests passed.', exitCode: 0 } } },
    { type: 'complete', runId, seq: 3, runStartedAt: 1_000, timestamp: i ? 91_000 : 883_000, data: i && stopped === 'budget' ? { status: 'failed', errorCode: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED', taskOutcome: { status: 'incomplete' } } : { status: 'succeeded', taskRequired: true, taskOutcome: { status: 'accepted' } } },
  ] as WebRunEvent[] }))
  const artifacts = runIds.map((runId, i) => ({ path: i ? 'reports/mobile-check.md' : 'reports/pinned-fix.md', runId, absolutePath: `/example/Pulse/reports/${i ? 'mobile-check' : 'pinned-fix'}.md`, workspaceState: 'project' as const }))
  base.transport.request = async (path, init) => {
    calls.push(path)
    if (path === '/api/conversations/pulse-chat') return Response.json(conversation)
    if (path === '/api/web/conversations/pulse-chat/messages') return Response.json(messages)
    if (path === '/api/web/conversations/pulse-chat/traces') return Response.json({ traces })
    if (path.startsWith('/api/conversations/pulse-chat/artifacts?')) return Response.json(artifacts)
    if (path === '/api/conversations/pulse-chat/budget-continuation') return Response.json(stopped === 'budget' ? { conversationId: 'pulse-chat', runId: 'round-two', used: 256, limit: 256, totalUsed: 512, calls: 256, continuationRunId: 'fixture-continued', status: 'available' } : null)
    if (path === '/api/conversations/pulse-chat/runs/round-two/budget-continuation' && init?.method === 'POST') return Response.json({ runId: 'fixture-continued' })
    if (path.startsWith('/api/conversations/pulse-chat/artifacts/content?')) return Response.json({ content: '这是本地模拟产物，未读取真实项目文件。' })
    return original(path, init)
  }
  return { transport: base.transport, traces, messages, artifacts, calls }
}
