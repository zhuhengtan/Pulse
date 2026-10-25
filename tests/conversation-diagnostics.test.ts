import { expect, it } from 'vitest'
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { assertDiagnosticTarget, inspectConversationRun } from '../packages/server/src/conversation-diagnostics.js'
import { initialController, unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'

const target = 'conv-11111111-1111-4111-8111-111111111111'
it('requires the exact user-named target and refuses arbitrary paths or IDs supplied only by a model', () => {
  expect(() => assertDiagnosticTarget(`检查 ${target}`, target)).not.toThrow()
  expect(() => assertDiagnosticTarget('inspect a conversation', target)).toThrow('DIAGNOSTIC_TARGET_NOT_AUTHORIZED')
  expect(() => assertDiagnosticTarget(target + '-suffix', target)).toThrow('DIAGNOSTIC_TARGET_NOT_AUTHORIZED')
  expect(() => assertDiagnosticTarget(target, '../config.json')).toThrow('DIAGNOSTIC_TARGET_NOT_AUTHORIZED')
  expect(() => assertDiagnosticTarget(target, target, '../../config.json')).toThrow('DIAGNOSTIC_TARGET_NOT_AUTHORIZED')
})

it('exposes archived idle events and status contradictions without leaking prompts or changing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-run-diagnostic-'))
  try {
    const write = async (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value))
    await mkdir(join(root, 'runtime-events'))
    await write('outcome.json', { status: 'failed', text: 'PRIVATE ANSWER' })
    await write('task-outcome.json', { status: 'accepted' })
    await write('task-controller.json', { tasks: [{ id: 'one', status: 'passed' }] })
    await write('model-budget.json', { used: 27, limit: 256 })
    await write('runtime.json', { state: { state: { agents: [['a', { id: 'a', rootLaneId: 'l', state: 'running' }]], lanes: [['l', { id: 'l', status: 'succeeded', context: 'PRIVATE PROMPT' }]], effects: [], events: [] } } })
    await write('runtime-events/000000000001-000000000256.json', [{ type: 'runtime.idle_blocked', seq: 30, timestamp: 1000, data: { status: 'waiting' } }])
    const before = await readFile(join(root, 'runtime.json'), 'utf8')
    const result = await inspectConversationRun(root)
    expect(result).toMatchObject({ stateMismatch: true, execution: { status: 'failed' }, acceptance: { status: 'accepted' }, idleEvents: [{ seq: 30, status: 'waiting' }], unavailable: [] })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE ANSWER|PRIVATE PROMPT/)
    expect(await readFile(join(root, 'runtime.json'), 'utf8')).toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['Operation not permitted（macOS 隐私授权 TCC）', 'PATH_OUTSIDE_SANDBOX', 'EACCES: cannot read source', '本机路径 Operation not permitted'])('retains the unmet goal on an unchanged external access blocker: %s', note => {
  const state = initialController(64)
  state.tasks = [{ id: 'inspect', goal: 'Inspect and repair the named session', check: 'Actual session repaired', criterionIds: ['c'], dependsOn: [], status: 'blocked', attempts: 1, evidenceRefs: ['original-evidence'], note }]
  expect(unmetGoalCanChangeApproach(state)).toBe(false)
  expect(state.tasks[0]?.goal).toBe('Inspect and repair the named session')
})

it('reports bounded omissions and refuses metadata symlinks outside the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-diagnostic-bounds-'))
  const run = join(root, 'run')
  try {
    await mkdir(run)
    await writeFile(join(root, 'private.json'), JSON.stringify({ status: 'PRIVATE STATUS' }))
    await symlink(join(root, 'private.json'), join(run, 'outcome.json'))
    const file = await open(join(run, 'runtime.json'), 'w')
    try { await file.truncate(33 * 1024 * 1024) } finally { await file.close() }
    const result = await inspectConversationRun(run)
    expect(result).toMatchObject({ truncated: true, execution: { status: null } })
    expect(result.unavailable).toEqual(expect.arrayContaining(['outcome.json', 'runtime.json']))
    expect(JSON.stringify(result)).not.toContain('PRIVATE STATUS')
    expect(JSON.parse(await readFile(join(root, 'private.json'), 'utf8'))).toEqual({ status: 'PRIVATE STATUS' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([true, false])('routes read-only diagnosis through the Host without shell home access (user-named=%s)', async named => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-diagnostic-host-'))
  const calls = [{ name: 'task.diagnose', input: { conversationId: '' } }]
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'auto', jarvis: { enabled: false }, taskController: false, mockToolCalls: calls, mockAfterToolResponse: 'done' })
  try {
    const targetConversation = await host.createConversation(), targetId = targetConversation.id
    // The mock provider input is set before starting the run; the authorization
    // check still derives its scope solely from the actual user message.
    calls[0]!.input.conversationId = targetId
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: named ? `检查会话 ${targetId} 为什么没有完成` : 'Check the current task' })
    await run.outcome()
    const audit = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'operations.json'), 'utf8'))
    const text = JSON.stringify(audit)
    expect(text).toContain('task.diagnose')
    expect(text).not.toContain('shell.exec')
    expect(text).toContain(named ? 'succeeded' : 'failed')
    if (!named) {
      const snapshot = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
      const diagnostic = snapshot.state.state.effects.find(([, effect]: any) => effect.input?.name === 'task.diagnose')?.[1]
      expect(JSON.stringify(diagnostic.outcome)).toContain('DIAGNOSTIC_TARGET_NOT_AUTHORIZED')
    }
    expect((await host.getConversation(targetId)).id).toBe(targetId)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
