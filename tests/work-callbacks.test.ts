import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { lowerProjectionToCanonical } from '@hunterzhu/pulse-adapters'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'
import { agentAnswerableQuestion, interactionFingerprint, routineApprovalCallback, workCallback } from '../packages/server/src/work-callback.js'
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
it('projects the native pending card and stable wait timestamp before the callback model runs', async () => {
  const f = await fixture(), runId = 'run-pending-native'
  vi.spyOn(f.internal, 'pumpAssistantInbox').mockResolvedValue(undefined)
  const pending = [{ groupId:'native-group', kind:'approval', items:[{effectId:'native-effect',input:{tools:[{toolName:'fs.write',input:{path:'report.txt',content:'test'}}]}}] }]
  try {
    await f.host.conversationData.call('saveState','approval-policy',{policy:'manual'})
    const manifest = await f.host.conversationData.call<any>('get', f.work.id)
    await f.host.conversationData.call('save', {...manifest,activeRunId:runId})
    f.internal.attachRun({id:runId,conversationId:f.work.id,pendingInteractions:async()=>pending},false)
    await f.internal.pushInteractionSnapshot(runId,1)
    const first = await fetch(f.base+'/api/assistant',{headers:f.headers}).then(r=>r.json()) as any
    expect(first.messages).toEqual([])
    expect(first.workInteractions[0]).toMatchObject({runId,groupId:'native-group',action:{callbackId:expect.any(String),fingerprint:expect.any(String),controlRevision:0}})
    expect(first.workInteractions[0].requestedAt).toBeGreaterThan(0)
    f.internal.runSnapshots.delete(runId) // Rehydrate the durable timestamp, as after reconnect/recovery.
    await f.internal.pushInteractionSnapshot(runId,2)
    const second = await fetch(f.base+'/api/assistant?before=1',{headers:f.headers}).then(r=>r.json()) as any
    expect(second.workInteractions[0].requestedAt).toBe(first.workInteractions[0].requestedAt)
  } finally {f.internal.activeRuns.delete(runId);await f.close()}
})
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

it.each(['automatic', 'legacy'] as const)('drains %s policy progress without model calls, then delivers an actionable result', async source => {
  const f = await fixture('读取超出限制，工作已经停止，现有修改已保留。')
  const send = vi.spyOn(f.host, 'sendMessage')
  try {
    f.internal.maintenance = true
    for (let index = 0; index < 4; index++) await f.internal.queueWorkCallback({ conversationId: f.work.id, runId: 'policy-run', title: '修复', kind: 'approval_resolved', ...(source === 'automatic' ? { approvalSource: 'automatic' } : {}), summary: '无需用户确认', interaction: { groupId: `approved:effect-${index}`, kind: 'approval', items: [] } })
    expect(f.internal.assistantInbox.callbacks().every(callback => callback.state === 'completed' && !callback.assistantRunId)).toBe(true)
    f.internal.maintenance = false; await f.internal.pumpAssistantInbox()
    expect(f.internal.assistantInbox.callbacks()).toHaveLength(4)
    expect(f.internal.assistantInbox.callbacks().every(callback => callback.state === 'completed')).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect((await f.host.getConversation(f.internal.assistantInbox.conversationId)).summary.activeRunId).toBeUndefined()
    expect(await f.host.getConversationMessages(f.internal.assistantInbox.conversationId)).toEqual([])
    await f.internal.queueWorkCallback({ conversationId: f.work.id, runId: 'policy-run', title: '修复', kind: 'failed', summary: 'FILE_TOO_LARGE，读取失败，等待用户决定' })
    await vi.waitFor(() => expect(f.internal.assistantInbox.callbacks().at(-1)?.state).toBe('completed'), { timeout: 5000 })
    expect(send).toHaveBeenCalledOnce()
    expect(await f.host.getConversationMessages(f.internal.assistantInbox.conversationId)).toMatchObject([{messageKind:'work_notice',work:{state:'failed'},text:'读取超出限制，工作已经停止，现有修改已保留。'}])
  } finally { await f.close() }
})

it('silently drains a persisted legacy queued approval with a previously allocated chat run', async () => {
  const f = await fixture(), send = vi.spyOn(f.host, 'sendMessage')
  try {
    f.internal.maintenance = true
    const chat=f.internal.assistantInbox.conversationId
    const legacy={...workCallback({...terminal,kind:'approval_resolved',interaction:{groupId:'approved:legacy-effect',kind:'approval',items:[]}}),assistantRunId:'previously-allocated-chat-run'}
    await f.host.conversationData.call('saveState','assistant-inbox',{schemaVersion:1,conversationId:chat,messages:[],callbacks:[legacy]})
    const recovered=new AssistantConversationStore(f.dataDir,f.host.conversationData)
    await recovered.init(async()=>{throw Error('must reuse persisted chat')})
    f.internal.assistantInbox=recovered;f.internal.maintenance=false;await f.internal.pumpAssistantInbox()
    expect(recovered.callbacks()[0]).toMatchObject({state:'completed',assistantRunId:legacy.assistantRunId})
    expect(send).not.toHaveBeenCalled();expect(await f.host.getConversationMessages(chat)).toEqual([])
  } finally { await f.close() }
})

it('keeps user approval outcomes and actionable events out of routine policy suppression', () => {
  expect(routineApprovalCallback(workCallback({...terminal,kind:'approval_resolved',approvalSource:'user',interaction:{groupId:'answered:approval-1',kind:'approval',items:[]}}))).toBe(false)
  expect(routineApprovalCallback(workCallback({...terminal,approvalSource:'automatic'}))).toBe(false)
  expect(routineApprovalCallback(workCallback({...terminal,kind:'question',approvalSource:'automatic'}))).toBe(false)
})

it('sends an explicit internal-event instruction and current facts without stale work-notice history', async () => {
  const f = await fixture()
  try {
    const chat = f.internal.assistantInbox.conversationId
    await f.host.appendAssistantUserMessage(chat,{id:'real-request',runId:'earlier-run',text:'REAL_USER_REQUIREMENT 保留已有改动',createdAt:new Date().toISOString()})
    await f.host.conversationData.call('append',chat,{id:'old-event',role:'assistant',text:'STALE_EMPTY_MESSAGE_NOTICE 你发了空消息，任务还在跑。',messageKind:'work_notice',createdAt:new Date().toISOString()})
    await f.internal.queueWorkCallback({conversationId:f.work.id,runId:'failed-later',title:'修复',kind:'failed',summary:'CURRENT_FAILURE_FACT FILE_TOO_LARGE，工作已停止'})
    await vi.waitFor(()=>expect(f.internal.assistantInbox.callbacks()[0]?.state).toBe('completed'),{timeout:5000})
    const runId=f.internal.assistantInbox.callbacks()[0].assistantRunId
    const saved=JSON.parse(await readFile(join(f.dataDir,'conversations',chat,'runs',runId,'runtime.json'),'utf8'))
    const effect=saved.state.state.effects.map(([,effect])=>effect).find(effect=>effect.kind==='llm')
    const {canonical}=lowerProjectionToCanonical({request:effect.input.request})
    const wire=JSON.stringify(canonical.messages)
    expect(wire).toContain('internal work status event, not a new user message')
    expect(wire).toContain('CURRENT_FAILURE_FACT');expect(wire).toContain('REAL_USER_REQUIREMENT')
    expect(wire).not.toContain('STALE_EMPTY_MESSAGE_NOTICE')
    // The persisted transcript is preserved; only callback model context omits old notices.
    expect((await f.host.getConversationMessages(chat)).some(message=>message.id==='old-event')).toBe(true)
  } finally { await f.close() }
})

it('never treats permission or plan-execution confirmation as an agent-answerable question', () => {
  expect(agentAnswerableQuestion({ toolName: 'ask.input', prompt: '报告使用什么语言？' })).toBe(true)
  expect(agentAnswerableQuestion({ toolName: 'ask.confirm', prompt: 'Proceed?' })).toBe(false)
  expect(agentAnswerableQuestion({ type: 'choice', prompt: '选一个', decisionScope: 'plan-execution', options: ['defer', 'execute'] })).toBe(false)
  expect(agentAnswerableQuestion({ prompt: '是否允许写入文件？' })).toBe(false)
})
it('projects the original question and accepted answers back into chat after a later control change', async () => {
  const f = await fixture('请选择部署方式。')
  const runId = 'question-work'
  const group = { groupId: 'question-g', kind: 'ask' as const, items: [{ effectId: 'question-e', input: { kind: 'ask', type: 'choice', prompt: '选择部署方式？', options: [{ label: '本地预览', value: 'local', description: '先验证交互流程。' }] } }] }
  let pending = [group]
  const replyBatch = vi.fn(async () => { pending = [] })
  f.internal.activeRuns.set(runId, { id: runId, conversationId: f.work.id, pendingInteractions: async () => pending, replyBatch })
  try {
    await f.internal.queueWorkCallback({ conversationId: f.work.id, runId, title: '修复', kind: 'question', summary: '请选择部署方式', interaction: group })
    await vi.waitFor(() => expect(f.internal.assistantInbox.callbacks()[0]?.state).toBe('completed'), { timeout: 5000 })
    const callback = f.internal.assistantInbox.callbacks()[0]
    const answers = [{ effectId: 'question-e', value: { value: 'local' } }]
    const response = await fetch(`${f.base}/api/assistant/work/${f.work.id}/replies`, { method: 'POST', headers: f.headers, body: JSON.stringify({ callbackId: callback.id, fingerprint: callback.fingerprint, answers }) })
    expect(response.status).toBe(200)
    await f.host.conversationData.call('changeWorkControl', f.work.id, 'takeover', 0)
    const view = await fetch(`${f.base}/api/assistant`, { headers: f.headers }).then(response => response.json()) as any
    expect(view.messages.find((message: any) => message.workAction)?.workAction).toMatchObject({ state: 'answered', interaction: group, answers })
    expect(replyBatch).toHaveBeenCalledTimes(1)
    expect(replyBatch).toHaveBeenCalledWith(group.groupId, answers)
  } finally { f.internal.activeRuns.delete(runId); await f.close() }
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
