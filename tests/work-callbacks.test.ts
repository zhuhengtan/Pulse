import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'
import { agentAnswerableQuestion, interactionFingerprint, workCallback } from '../packages/server/src/work-callback.js'
const terminal = { conversationId: 'work', runId: 'run', kind: 'failed' as const, title: '修复', summary: '校验失败，等待用户决定', controlRevision: 0 }
it('durably deduplicates callbacks, restores their same reply run and supersedes obsolete progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-callback-store-'))
  const store = new AssistantConversationStore(root)
  try {
    await store.init(async () => 'chat')
    const notice = workCallback({ ...terminal, kind: 'approval', interaction: { groupId: 'g', kind: 'approval', items: [{ effectId: 'e', input: { prompt: 'Allow?', tools: [] } }] } })
    await store.addCallback(notice); await store.addCallback(notice)
    const first = await store.nextCallback()
    const restored = new AssistantConversationStore(root)
    try {
      await restored.init(async () => { throw new Error('must reuse') })
      const again = await restored.nextCallback()
      expect(again?.assistantRunId).toBe(first?.assistantRunId)
      await restored.updateCallback(notice.id, { state: 'queued' })
      const end = workCallback(terminal); await restored.addCallback(end)
      await restored.addCallback(workCallback({ ...terminal, controlRevision: 5 })) // A later takeover must not duplicate a terminal fact.
      expect(restored.callbacks()).toHaveLength(2)
      expect(restored.callbacks()[0]?.state).toBe('completed')
      expect((await restored.nextCallback())?.id).toBe(end.id)
    } finally { await restored.close() }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
async function fixture(response = '校验未通过，我先停在这里，等你决定。') {
  const root = await mkdtemp(join(tmpdir(), 'pulse-work-callback-')), dataDir = join(root, 'data')
  const host = createLocalHost({ cwd: root, dataDir, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', mockResponse: response, taskController: false, jarvis: { enabled: false } })
  const server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 }), internal = server as any
  const base = `http://127.0.0.1:${(await server.start()).port}`
  const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const headers = { Cookie: auth.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
  const work = await host.createConversation({ origin: 'assistant', title: '修复' })
  await internal.assistantInbox.linkWork(work.id, 'project-fixture', '修复')
  await host.conversationData.call('initializeWorkControl', work.id, internal.assistantInbox.conversationId)
  return { root, dataDir, host, server, internal, base, headers, work, close: async () => { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) } }
}
it('runs a work fact through the chat model once, without fabricating a user message or restarting failed work', async () => {
  const f = await fixture()
  try {
    const input = { conversationId: f.work.id, runId: 'failed-run', kind: 'failed', title: '修复', summary: '校验失败' }
    await f.internal.queueWorkCallback(input)
    await vi.waitFor(() => expect(f.internal.assistantInbox.callbacks()[0]?.state, JSON.stringify(f.internal.assistantInbox.callbacks())).toBe('completed'), { timeout: 5000 })
    await f.internal.queueWorkCallback(input)
    const messages = await f.host.getConversationMessages(f.internal.assistantInbox.conversationId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'assistant', messageKind: 'work_notice', text: '校验未通过，我先停在这里，等你决定。', work: { conversationId: f.work.id, state: 'failed' } })
    expect((await f.host.getConversation(f.work.id)).summary.activeRunId).toBeUndefined()
  } finally { await f.close() }
})
it('binds chat approval to the exact operation, deduplicates concurrent answers, and never transfers ownership', async () => {
  const f = await fixture('需要确认这个操作。')
  let pending: any[] = [{ groupId: 'approval-g', kind: 'approval', items: [{ effectId: 'effect-write', input: { prompt: '写入文件？', tools: [{ name: 'fs.write', input: { path: 'a.txt', content: 'ok' } }] } }] }]
  const runId = 'pending-work', replyBatch = vi.fn(async () => { pending = [] })
  const handle = { id: runId, conversationId: f.work.id, pendingInteractions: async () => pending, replyBatch }
  f.internal.activeRuns.set(runId, handle)
  try {
    await f.internal.queueWorkCallback({ conversationId: f.work.id, runId, title: '修复', kind: 'approval', summary: '需要确认', interaction: pending[0] })
    await vi.waitFor(() => expect(f.internal.assistantInbox.callbacks()[0]?.state, JSON.stringify(f.internal.assistantInbox.callbacks())).toBe('completed'), { timeout: 5000 })
    const callback = f.internal.assistantInbox.callbacks()[0]
    const path = `${f.base}/api/assistant/work/${f.work.id}/replies`
    const send = (fingerprint = callback.fingerprint, approved = true) => fetch(path, { method: 'POST', headers: f.headers, body: JSON.stringify({ callbackId: callback.id, fingerprint, answers: [{ effectId: 'effect-write', value: { approved } }] }) })
    expect((await send('changed')).status).toBe(409)
    expect(replyBatch).not.toHaveBeenCalled()
    const original = structuredClone(pending)
    pending[0].items[0].input.tools[0].input.content = 'different effect with the same displayed path'
    expect((await send()).status).toBe(409)
    expect(replyBatch).not.toHaveBeenCalled()
    pending = original
    const results = await Promise.all([send(), send(), send()])
    expect(results.map(result => result.status), JSON.stringify(await Promise.all(results.map(result => result.json())))).toEqual([200,200,200])
    expect(replyBatch).toHaveBeenCalledTimes(1)
    expect((await send(callback.fingerprint, false)).status).toBe(409)
    expect((await f.host.getConversation(f.work.id)).summary.control).toMatchObject({ owner: 'assistant', revision: 0 })
    const messages = await f.host.getConversationMessages(f.internal.assistantInbox.conversationId)
    expect(messages.find(message => message.workAction)?.workAction?.fingerprint).toBe(interactionFingerprint(callback.interaction))
    // The agent's ordinary-question tool cannot authorize an operation.
    pending = [callback.interaction]
    const manifest = await f.host.conversationData.call<any>('get', f.work.id)
    await f.host.conversationData.call('save', { ...manifest, activeRunId: runId })
    await expect((f.host as any).assistantWorkTools.answer(f.work.id, 'approval-g', [{ effectId: 'effect-write', value: { approved: true } }])).rejects.toThrow('WORK_QUESTION_REQUIRED')
    expect(replyBatch).toHaveBeenCalledTimes(1)
    // A still-pending prompt becomes unusable after explicit takeover.
    const stale = workCallback({ ...callback, interaction: { ...callback.interaction, groupId: 'new-g' } })
    await f.internal.assistantInbox.addCallback(stale)
    await f.host.conversationData.call('changeWorkControl', f.work.id, 'takeover', 0)
    const expired = await fetch(path, { method: 'POST', headers: f.headers, body: JSON.stringify({ callbackId: stale.id, fingerprint: stale.fingerprint, answers: [{ effectId: 'effect-write', value: { approved: true } }] }) })
    expect(expired.status).toBe(409)
    expect(replyBatch).toHaveBeenCalledTimes(1)
    await f.host.conversationData.call('changeWorkControl', f.work.id, 'return', 1)
    await expect((f.host as any).assistantWorkTools.answer(f.work.id, 'new-g', [], 0)).rejects.toThrow('WORK_CONTROL_STALE')
  } finally { f.internal.activeRuns.delete(runId); await f.close() }
})
it('recovers a committed work outcome that crashed before callback enqueue and delivers it once', async () => {
  const f = await fixture('上次工作已经停止，交付状态还需要核实。')
  try {
    const manifest = await f.host.conversationData.call<any>('get', f.work.id), runId = 'orphan-run'
    await f.host.conversationData.call('save', { ...manifest, runs: [runId] })
    const runDir = join(f.dataDir, 'conversations', f.work.id, 'runs', runId)
    await mkdir(runDir, { recursive: true }); await writeFile(join(runDir, 'outcome.json'), JSON.stringify({ status: 'succeeded', text: 'runtime complete' }))
    await f.internal.reconcileWorkCallbacks()
    await vi.waitFor(() => expect(f.internal.assistantInbox.callbacks()[0]?.state, JSON.stringify(f.internal.assistantInbox.callbacks())).toBe('completed'), { timeout: 5000 })
    await f.internal.reconcileWorkCallbacks()
    expect(f.internal.assistantInbox.callbacks()).toHaveLength(1)
    expect(f.internal.assistantInbox.callbacks()[0]?.kind).toBe('pending')
    expect(await f.host.getConversationMessages(f.internal.assistantInbox.conversationId)).toHaveLength(1)
  } finally { await f.close() }
})
it('suppresses a routine automatic approval update without creating an empty bubble', async () => {
  const f = await fixture('[NO_CHAT_UPDATE]')
  try {
    await f.internal.queueWorkCallback({ conversationId: f.work.id, runId: 'auto-approved-run', title: '修复', kind: 'approval_resolved', summary: '按现有策略自动批准' })
    await vi.waitFor(() => expect(f.internal.assistantInbox.callbacks()[0]?.state, JSON.stringify(f.internal.assistantInbox.callbacks())).toBe('completed'), { timeout: 5000 })
    expect(await f.host.getConversationMessages(f.internal.assistantInbox.conversationId)).toEqual([])
  } finally { await f.close() }
})

it('never treats permission or plan-execution confirmation as an agent-answerable question', () => {
  expect(agentAnswerableQuestion({ toolName: 'ask.input', prompt: '报告使用什么语言？' })).toBe(true)
  expect(agentAnswerableQuestion({ toolName: 'ask.confirm', prompt: 'Proceed?' })).toBe(false)
  expect(agentAnswerableQuestion({ type: 'choice', prompt: '选一个', decisionScope: 'plan-execution', options: ['defer', 'execute'] })).toBe(false)
  expect(agentAnswerableQuestion({ prompt: '是否允许写入文件？' })).toBe(false)
})
it('resumes a durable callback after an actual isolated server restart without duplicating its chat message', async () => {
  const f = await fixture()
  let resumedHost: ReturnType<typeof createLocalHost> | undefined, resumedServer: H5Server | undefined
  try {
    f.internal.maintenance = true
    await f.internal.queueWorkCallback({ conversationId: f.work.id, runId: 'interrupted-source', kind: 'interrupted', title: '修复', summary: '上次工作意外中断' })
    const before = await f.internal.assistantInbox.nextCallback()
    expect(before.state).toBe('processing')
    await f.server.stop(); await f.host.close()
    const profile = { provider: 'mock' as const, defaultModel: 'mock' }
    resumedHost = createLocalHost({ cwd: f.root, dataDir: f.dataDir, provider: profile, providerProfiles: { mock: profile }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', mockResponse: '工作中断了，我在这里等你的下一步安排。', jarvis: { enabled: false } })
    resumedServer = new H5Server(resumedHost, { dataDir: f.dataDir, host: '127.0.0.1', port: 0 })
    await resumedServer.start()
    const inbox = (resumedServer as any).assistantInbox
    await vi.waitFor(() => expect(inbox.callbacks()[0]?.state).toBe('completed'), { timeout: 5000 })
    expect(inbox.callbacks()[0]?.assistantRunId).toBe(before.assistantRunId)
    expect(await resumedHost.getConversationMessages(inbox.conversationId)).toMatchObject([{ id: `chat-${before.id}`, role: 'assistant', text: '工作中断了，我在这里等你的下一步安排。' }])
  } finally {
    await resumedServer?.stop(); await resumedHost?.close()
    await f.server.stop(); await f.host.close(); await rm(f.root, { recursive: true, force: true })
  }
})
