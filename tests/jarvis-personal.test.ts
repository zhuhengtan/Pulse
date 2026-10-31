import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry, type ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { JarvisClient, createLocalHost } from '../packages/server/src/index.js'
import { explicitPersonalRecordAllowed, PersonalJarvisQueue, registerPersonalJarvisTools } from '../packages/server/src/jarvis/personal.js'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const context = (id = 'effect-1'): ToolContext => ({ effectId: id, toolCallId: id, attemptId: 'attempt-1', agentId: 'a', laneId: 'l', signal: new AbortController().signal, emit() {} })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-personal-')); roots.push(root)
  const calls: Array<{ url: URL; body: any }> = []
  let online = true, conflict = false, forgetNext = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url: u, body })
    if (!online) throw Error('offline')
    if (conflict) return new Response('{}', { status: 409 })
    if (u.pathname === '/v1/context/retrieve') return Response.json({ text: 'Historical source', topicIds: ['topic-1'], sourceIds: ['source-1'] })
    if (u.pathname === '/v1/observe') {
      if (forgetNext) { forgetNext = false; return Response.json({ id: 'source-forgotten', status: 'forgotten' }) }
      return Response.json({ id: 'source-1', status: 'pending' })
    }
    if (u.pathname === '/v1/knowledge/search') return Response.json({ results: [{ id: 'source-1' }] })
    if (u.pathname === '/v1/knowledge/source-1') return Response.json({ content: 'part', nextLine: 1, nextCharOffset: 4000 })
    throw Error('Unexpected legacy endpoint: ' + u.pathname)
  }))
  const client = new JarvisClient({ token: 'private-credential' }), queue = new PersonalJarvisQueue(root, client), registry = new ToolRegistry()
  registerPersonalJarvisTools(registry, client, queue, {}, root, 'conversation:run', '当前问题')
  return { root, client, queue, registry, calls, offline: () => { online = false }, online: () => { online = true }, conflict: () => { conflict = true }, forgetNext: () => { forgetNext = true } }
}
const assistantHost = (root: string, client: JarvisClient, extra: Parameters<typeof createLocalHost>[0] = {}) => createLocalHost({
  cwd: root, dataDir: join(root, 'host'), jarvisClient: client, taskController: false, approvalMode: 'auto',
  provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', ...extra,
})
const workTools = { start: async () => ({ conversationId: 'work-1', projectId: 'p', title: 'Inspect' }), list: async () => [], status: async () => ({}), send: async () => {}, stop: async () => {}, resume: async () => {} }
async function savedInput(root: string, conversationId: string, runId: string) {
  return JSON.parse(await readFile(join(root, 'host', 'conversations', conversationId, 'runs', runId, 'input.json'), 'utf8')) as { currentUserText?: string; jarvisProtocol?: string }
}
async function modelPrompt(root: string, conversationId: string, runId: string) {
  const saved = JSON.parse(await readFile(join(root, 'host', 'conversations', conversationId, 'runs', runId, 'runtime.json'), 'utf8')) as { state: { state: { effects: Array<[string, { kind: string; input?: unknown }]> } } }
  return JSON.stringify(saved.state.state.effects.find(([, effect]) => effect.kind === 'llm')?.[1]?.input ?? {})
}
it('uses projectless personal endpoints, follow-up context and bounded long-line pagination', async () => {
  const f = await fixture()
  expect(await f.registry.execute('jarvis.context', { query: '上次那个', recentContext: '审批讨论' }, context())).toMatchObject({ historicalReference: true })
  expect(f.calls[0]!.body).toMatchObject({ client: 'pulse', recentContext: '审批讨论' })
  await f.registry.execute('jarvis.knowledge_search', { query: '审批' }, context())
  expect(await f.registry.execute('jarvis.knowledge_get', { id: 'source-1', offset: 1, charOffset: 4000 }, context())).toMatchObject({ nextCharOffset: 4000 })
  expect(f.calls.at(-1)!.url.searchParams.get('charOffset')).toBe('4000')
  await expect(f.registry.execute('jarvis.context', { query: '秘密', scope: 'project' }, context())).rejects.toThrow()
  expect(f.calls.every(c => !c.url.pathname.includes('sessions'))).toBe(true)
})
it('persists redacted identity and timestamp before delivery; restart retries identical source only once', async () => {
  const f = await fixture(); f.offline()
  expect(await f.queue.submit('stable', { content: 'token private-credential' }, f.root)).toMatchObject({ status: 'pending_sync' })
  const original = f.calls[0]!.body
  const directory = join(f.root, 'h5', (await readdir(join(f.root, 'h5'))).find(name => name.startsWith('jarvis-observations.'))!); const file = (await readdir(directory)).find(name => name.endsWith('.json'))!
  expect(await readFile(join(directory, file), 'utf8')).not.toContain('private-credential')
  f.online(); const restarted = new PersonalJarvisQueue(f.root, f.client); await restarted.flush()
  expect(f.calls[1]!.body).toEqual(original)
  expect(await restarted.submit('stable', { content: 'token private-credential' }, f.root)).toMatchObject({ status: 'received', sourceId: 'source-1' })
  expect(f.calls).toHaveLength(2)
  await expect(restarted.submit('stable', { content: 'changed' }, f.root)).rejects.toThrow('JARVIS_OBSERVATION_ID_CONFLICT')
})
it('retains a 409 as failed rather than inventing a new source ID', async () => {
  const f = await fixture(); f.conflict()
  expect(await f.queue.submit('stable', { content: 'source' }, f.root)).toMatchObject({ status: 'failed' })
  await new PersonalJarvisQueue(f.root, f.client).flush(); expect(f.calls).toHaveLength(1)
})
it('does not send pending data to changed destination credentials', async () => {
  const f = await fixture(); f.offline(); await f.queue.submit('stable', { content: 'source' }, f.root)
  f.online(); await new PersonalJarvisQueue(f.root, new JarvisClient({ token: 'other-account' })).flush(); expect(f.calls).toHaveLength(1)
})
it('runs ordinary new Host work without opening, retrieving or closing a memory session', async () => {
  const f = await fixture()
  const host = createLocalHost({ cwd: f.root, dataDir: join(f.root, 'host'), jarvisClient: f.client, mockResponse: 'Done', taskController: false, approvalMode: 'auto' })
  await host.init()
  try {
    const conversation = await host.createConversation({ title: 'plain', cwd: f.root })
    const run = await host.sendMessage(conversation.id, { text: '回答当前问题' }); await run.outcome()
    expect(f.calls).toHaveLength(0)
  } finally { await host.close() }
})
it('registers the personal tools on the real Host and records an observation without legacy endpoints', async () => {
  const f = await fixture()
  const host = createLocalHost({ cwd: f.root, dataDir: join(f.root, 'host'), jarvisClient: f.client, taskController: false, approvalMode: 'auto', mockToolCalls: [{ name: 'jarvis.observe', input: { content: '用户明确要求记录这次方向变更' } }], mockAfterToolResponse: '已提交来源，等待整理。' })
  await host.init()
  try {
    const conversation = await host.createConversation({ cwd: f.root })
    const run = await host.sendMessage(conversation.id, { text: '记录这次方向变更' })
    expect((await run.outcome()).status).toBe('succeeded')
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.url.pathname).toBe('/v1/observe')
    expect(f.calls[0]!.body).toMatchObject({ client: 'pulse', externalId: expect.stringMatching(/^pulse:[a-f0-9]{64}$/) })
    const saved = JSON.parse(await readFile(join(f.root, 'host', 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
    expect(saved.jarvisProtocol).toBe('personal')
  } finally { await host.close() }
})
it('enforces explicit-only recording, including negative instructions', async () => {
  const f = await fixture()
  const pad = '背景'.repeat(700)
  for (const request of ['当前问题', '不要记录这件事', 'do not remember this', '请勿记录', '不用记录', '不准记录', '', '   ', `${pad}请记住开头，但请勿记录`, `请记住${pad}不用记录`]) {
    expect(explicitPersonalRecordAllowed(request)).toBe(false)
    const registry = new ToolRegistry(); registerPersonalJarvisTools(registry, f.client, f.queue, { observationPolicy: 'explicit', autoCandidate: false }, f.root, 'owner', request)
    await expect(registry.execute('jarvis.observe', { content: 'not allowed' }, context())).rejects.toThrow('JARVIS_EXPLICIT_RECORD_REQUIRED')
  }
  expect(explicitPersonalRecordAllowed(`${pad}请记住这件事`)).toBe(true)
  expect(explicitPersonalRecordAllowed(`不要修改文件。${'间隔'.repeat(40)}请记住这个偏好`)).toBe(true)
  expect(f.calls).toHaveLength(0)
})
it('treats a forgotten receipt as terminal and still sends the next pending source', async () => {
  const f = await fixture(); f.offline()
  const first = await f.queue.submit('alpha', { content: 'alpha source' }, f.root)
  const second = await f.queue.submit('beta', { content: 'beta source' }, f.root)
  expect(first.externalId).not.toBe(second.externalId)
  const parked = f.calls.length
  f.online(); f.forgetNext()
  await new PersonalJarvisQueue(f.root, f.client).flush()
  const sent = f.calls.slice(parked).filter(call => call.url.pathname === '/v1/observe')
  expect(sent).toHaveLength(2)
  expect(sent.map(call => call.body.externalId).sort()).toEqual([first.externalId, second.externalId].sort())
  const settled = f.calls.length
  await new PersonalJarvisQueue(f.root, f.client).flush()
  expect(f.calls).toHaveLength(settled)
  const directory = join(f.root, 'h5', (await readdir(join(f.root, 'h5'))).find(name => name.startsWith('jarvis-observations.'))!)
  const items = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as { status: string; externalId: string }))
  expect(items.map(item => item.status).sort()).toEqual(['forgotten', 'received'])
  expect(items.map(item => item.externalId).sort()).toEqual([first.externalId, second.externalId].sort())
  f.forgetNext()
  const receipt = await f.queue.submit('gone', { content: 'forget me' }, f.root)
  expect(receipt).toMatchObject({ status: 'forgotten', externalId: expect.stringMatching(/^pulse:[a-f0-9]{64}$/), sourceId: 'source-forgotten' })
  expect(receipt.note).toContain('not active')
  expect(await f.queue.submit('gone', { content: 'forget me' }, f.root)).toMatchObject({ externalId: receipt.externalId, status: 'forgotten' })
  expect(f.calls.filter(call => call.url.pathname === '/v1/observe' && call.body.externalId === receipt.externalId)).toHaveLength(1)
})
it('does not let earlier history grant an explicit Host record', async () => {
  const f = await fixture()
  const host = assistantHost(f.root, f.client, { jarvis: { observationPolicy: 'explicit', autoCandidate: false }, mockToolCalls: [{ name: 'jarvis.observe', input: { content: '不该提交' } }], mockAfterToolResponse: '未记录' })
  await host.init()
  try {
    const conversation = await host.createConversation({ cwd: f.root })
    await host.appendAssistantUserMessage(conversation.id, { id: 'history-1', runId: 'history-run', text: '请记住这个历史偏好', createdAt: '2026-10-31T00:00:00.000Z' })
    const ignored = await host.sendMessage(conversation.id, { text: '当前只是问个问题', assistantChat: true })
    await ignored.outcome()
    expect(await savedInput(f.root, conversation.id, ignored.id)).toMatchObject({ currentUserText: '当前只是问个问题', jarvisProtocol: 'personal' })
    expect(f.calls.filter(call => call.url.pathname === '/v1/observe')).toHaveLength(0)
  } finally { await host.close() }
})
it('rejects an explicit record when the negation is past the first 1200 characters', async () => {
  const f = await fixture()
  const denied = '请记住开头。' + '背景'.repeat(700) + '请勿记录'
  expect(denied.lastIndexOf('请勿记录')).toBeGreaterThan(1200)
  const host = assistantHost(f.root, f.client, { jarvis: { observationPolicy: 'explicit', autoCandidate: false }, mockToolCalls: [{ name: 'jarvis.observe', input: { content: '不该提交' } }], mockAfterToolResponse: '未记录' })
  await host.init()
  try {
    const conversation = await host.createConversation({ cwd: f.root })
    const late = await host.sendMessage(conversation.id, { text: denied, assistantChat: true })
    await late.outcome()
    expect((await savedInput(f.root, conversation.id, late.id)).currentUserText).toBe(denied)
    expect(f.calls.filter(call => call.url.pathname === '/v1/observe')).toHaveLength(0)
  } finally { await host.close() }
})
it('records a long explicit request and keeps personal guidance off legacy memory tools', async () => {
  const f = await fixture()
  const text = '背景'.repeat(700) + '请记住这件事'
  expect(text.indexOf('请记住')).toBeGreaterThan(1200)
  const host = assistantHost(f.root, f.client, { jarvis: { observationPolicy: 'explicit', autoCandidate: false }, mockToolCalls: [{ name: 'jarvis.observe', input: { content: '请记住这件事' } }], mockAfterToolResponse: '已提交来源。' })
  await host.init()
  try {
    const conversation = await host.createConversation({ cwd: f.root })
    const run = await host.sendMessage(conversation.id, { text, assistantChat: true })
    expect((await run.outcome()).status).toBe('succeeded')
    expect(f.calls.filter(call => call.url.pathname === '/v1/observe')).toHaveLength(1)
    expect(await modelPrompt(f.root, conversation.id, run.id)).toContain('jarvis.observe')
    expect(await modelPrompt(f.root, conversation.id, run.id)).not.toContain('jarvis.remember')
    expect(await modelPrompt(f.root, conversation.id, run.id)).not.toContain('jarvis.record')
  } finally { await host.close() }
})
it('uses the persisted original text after a personal assistant wait and does not open a session', async () => {
  const f = await fixture()
  const denied = '请记住开头。' + '背景'.repeat(700) + '不准记录'
  const base = { jarvis: { observationPolicy: 'explicit' as const, autoCandidate: false }, approvalMode: 'ask' as const }
  const first = assistantHost(f.root, f.client, { ...base, mockToolCalls: [{ name: 'work.start', input: { projectId: 'p', task: 'Inspect' } }] })
  first.setAssistantWorkTools(workTools)
  await first.init()
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation({ cwd: f.root })
    const run = await first.sendMessage(conversation.id, { text: denied, assistantChat: true })
    let waiting = false
    for await (const event of run.events) if (event.type === 'waiting') { waiting = true; break }
    expect(waiting).toBe(true)
    expect((await savedInput(f.root, conversation.id, run.id)).currentUserText).toBe(denied)
    await first.close({ preserveHumanWaits: true })
    second = assistantHost(f.root, f.client, { ...base, mockToolCalls: [{ name: 'jarvis.observe', input: { content: '不该提交' } }], mockAfterToolResponse: '未记录' })
    second.setAssistantWorkTools(workTools)
    await second.init()
    const resumed = await second.resumeRun(conversation.id)
    for await (const event of resumed.events) if (event.type === 'waiting') {
      const pending = await resumed.pendingInteractions()
      await resumed.reply(pending[0]!.items[0]!.effectId, { approved: true })
    }
    await resumed.outcome()
    expect(f.calls.filter(call => call.url.pathname === '/v1/observe')).toHaveLength(0)
    expect(f.calls.some(call => call.url.pathname.includes('sessions'))).toBe(false)
  } finally { await second?.close(); await first.close() }
})
it('records from the persisted original text after a personal assistant wait', async () => {
  const f = await fixture()
  const allowed = '背景'.repeat(700) + '请记住恢复后的原话'
  expect(allowed.indexOf('请记住')).toBeGreaterThan(1200)
  const base = { jarvis: { observationPolicy: 'explicit' as const, autoCandidate: false }, approvalMode: 'ask' as const }
  const first = assistantHost(f.root, f.client, { ...base, mockToolCalls: [{ name: 'work.start', input: { projectId: 'p', task: 'Inspect' } }] })
  first.setAssistantWorkTools(workTools)
  await first.init()
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation({ cwd: f.root })
    const run = await first.sendMessage(conversation.id, { text: allowed, assistantChat: true })
    let waiting = false
    for await (const event of run.events) if (event.type === 'waiting') { waiting = true; break }
    expect(waiting).toBe(true)
    await first.close({ preserveHumanWaits: true })
    second = assistantHost(f.root, f.client, { ...base, mockToolCalls: [{ name: 'jarvis.observe', input: { content: '请记住恢复后的原话' } }], mockAfterToolResponse: '已提交来源。' })
    second.setAssistantWorkTools(workTools)
    await second.init()
    const resumed = await second.resumeRun(conversation.id)
    for await (const event of resumed.events) if (event.type === 'waiting') {
      const pending = await resumed.pendingInteractions()
      await resumed.reply(pending[0]!.items[0]!.effectId, { approved: true })
    }
    expect((await resumed.outcome()).status).toBe('succeeded')
    expect(f.calls.filter(call => call.url.pathname === '/v1/observe')).toHaveLength(1)
    expect(f.calls.some(call => call.url.pathname.includes('sessions'))).toBe(false)
  } finally { await second?.close(); await first.close() }
})
it('still opens a legacy assistant session on cold recovery', async () => {
  const f = await fixture()
  const first = assistantHost(f.root, f.client, { jarvis: { protocol: 'legacy' }, approvalMode: 'ask', mockToolCalls: [{ name: 'work.start', input: { projectId: 'p', task: 'Inspect' } }] })
  first.setAssistantWorkTools(workTools)
  await first.init()
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation({ cwd: f.root })
    const run = await first.sendMessage(conversation.id, { text: '先等审批', assistantChat: true })
    let waiting = false
    for await (const event of run.events) if (event.type === 'waiting') { waiting = true; break }
    expect(waiting).toBe(true)
    await first.close({ preserveHumanWaits: true })
    second = assistantHost(f.root, f.client, { jarvis: { protocol: 'legacy' }, approvalMode: 'ask', mockResponse: '继续' })
    second.setAssistantWorkTools(workTools)
    await second.init()
    await second.resumeRun(conversation.id)
    expect(f.calls.some(call => call.url.pathname === '/v1/sessions')).toBe(true)
  } finally { await second?.close(); await first.close() }
})
it('adds personal source guidance only to a personal task prompt', async () => {
  const f = await fixture()
  const personal = assistantHost(f.root, f.client, { assistantModel: undefined, mockResponse: '好' })
  await personal.init()
  try {
    const conversation = await personal.createConversation({ cwd: f.root })
    const run = await personal.sendMessage(conversation.id, { text: '普通任务' })
    await run.outcome()
    const prompt = await modelPrompt(f.root, conversation.id, run.id)
    expect(prompt).toContain('jarvis.observe')
    expect(prompt).not.toContain('jarvis.remember')
    expect(prompt).not.toContain('jarvis.record')
  } finally { await personal.close() }
  const legacy = assistantHost(f.root, f.client, { assistantModel: undefined, jarvis: { protocol: 'legacy' }, mockResponse: '好' })
  await legacy.init()
  try {
    const conversation = await legacy.createConversation({ cwd: f.root })
    const run = await legacy.sendMessage(conversation.id, { text: '旧任务' })
    await run.outcome()
    const prompt = await modelPrompt(f.root, conversation.id, run.id)
    expect(prompt).not.toContain('jarvis.observe')
    expect(prompt).not.toContain('## Jarvis memory writes')
  } finally { await legacy.close() }
})
it('keeps a production host observation on its first destination when the same effect is resubmitted', async () => {
  const f = await fixture(); f.offline()
  const recorded = '用户明确要求记录这次方向变更'
  const host = assistantHost(f.root, f.client, { mockToolCalls: [{ name: 'jarvis.observe', input: { content: recorded } }], mockAfterToolResponse: '已提交来源，等待整理。' })
  await host.init()
  try {
    const conversation = await host.createConversation({ cwd: f.root })
    const run = await host.sendMessage(conversation.id, { text: '记录这次方向变更', assistantChat: true })
    expect((await run.outcome()).status).toBe('succeeded')
    const runtime = JSON.parse(await readFile(join(f.root, 'host', 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')) as { state: { state: { effects: Array<[string, { id?: string; kind: string; toolCallId?: string; input?: { name?: string } }]> } } }
    const tool = runtime.state.state.effects.find(([, effect]) => effect.kind === 'tool' && effect.input?.name === 'jarvis.observe')
    expect(tool?.[1].toolCallId).toBeTruthy()
    const identity = `${conversation.id}:${run.id}:${tool![1].id ?? tool![0]}:${tool![1].toolCallId}`
    const outbox = join(f.root, 'host', 'h5', `jarvis-observations.${f.client.destinationScope}`)
    const fileName = (await readdir(outbox)).find(name => name.endsWith('.json'))!
    const before = await readFile(join(outbox, fileName), 'utf8')
    const original = JSON.parse(before) as { externalId: string; occurredAt: string; status: string }
    expect(original.status).toBe('pending_sync')
    const callsBefore = f.calls.length
    const other = new PersonalJarvisQueue(join(f.root, 'host'), new JarvisClient({ token: 'other-account' }))
    const registry = new ToolRegistry()
    registerPersonalJarvisTools(registry, new JarvisClient({ token: 'other-account' }), other, {}, f.root, `${conversation.id}:${run.id}`, '记录这次方向变更')
    await expect(registry.execute('jarvis.observe', { content: recorded }, { ...context(), effectId: tool![1].id ?? tool![0], toolCallId: tool![1].toolCallId! })).rejects.toThrow('JARVIS_OBSERVATION_DESTINATION_CHANGED')
    expect(f.calls).toHaveLength(callsBefore)
    expect(await readFile(join(outbox, fileName), 'utf8')).toBe(before)
    expect(identity).toContain(conversation.id)
    await expect(readdir(join(f.root, 'host', 'h5', `jarvis-observations.${new JarvisClient({ token: 'other-account' }).destinationScope}`))).rejects.toThrow()
  } finally { await host.close() }
})
it('rejects a destination change for the same logical observation and still accepts the original or a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-destination-')); roots.push(root)
  const calls: Array<{ port: string; body: { externalId: string; occurredAt: string; content: string } }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const port = new URL(String(url)).port
    const body = JSON.parse(String(init?.body)) as { externalId: string; occurredAt: string; content: string }
    calls.push({ port, body })
    if (port === '41001') throw Error('offline')
    return Response.json({ id: `source-${port}`, status: 'pending' })
  }))
  const clientA = new JarvisClient({ apiUrl: 'http://127.0.0.1:41001' })
  const clientB = new JarvisClient({ apiUrl: 'http://127.0.0.1:41002' })
  const a = new PersonalJarvisQueue(root, clientA)
  const b = new PersonalJarvisQueue(root, clientB)
  const input = { content: 'A-only synthetic source' }
  const first = await a.submit('conversation:run:effect-1', input, root)
  expect(first.status).toBe('pending_sync')
  const originalTime = calls[0]!.body.occurredAt
  const outbox = join(root, 'h5', `jarvis-observations.${clientA.destinationScope}`)
  const before = await readFile(join(outbox, (await readdir(outbox)).find(name => name.endsWith('.json'))!), 'utf8')
  await expect(b.submit('conversation:run:effect-1', input, root)).rejects.toThrow('JARVIS_OBSERVATION_DESTINATION_CHANGED')
  expect(calls.filter(call => call.port === '41002')).toHaveLength(0)
  expect(await readFile(join(outbox, (await readdir(outbox)).find(name => name.endsWith('.json'))!), 'utf8')).toBe(before)
  const retried = await a.submit('conversation:run:effect-1', input, root)
  expect(retried).toMatchObject({ externalId: first.externalId, status: 'pending_sync' })
  expect(calls.at(-1)!.body.occurredAt).toBe(originalTime)
  expect(calls.at(-1)!.body.externalId).toBe(first.externalId)
  const created = await b.submit('conversation:run:effect-2', { content: 'B source' }, root)
  expect(created.externalId).not.toBe(first.externalId)
  expect(calls.filter(call => call.port === '41002').map(call => call.body.externalId)).toEqual([created.externalId])
})
it('initializes one logical observation once when two queues race', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-destination-race-')); roots.push(root)
  const calls: Array<{ port: string; body: { externalId: string; occurredAt: string } }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const port = new URL(String(url)).port
    const body = JSON.parse(String(init?.body)) as { externalId: string; occurredAt: string }
    calls.push({ port, body })
    if (port === '41001') throw Error('offline')
    return Response.json({ id: `source-${port}`, status: 'pending' })
  }))
  const clientA = new JarvisClient({ apiUrl: 'http://127.0.0.1:41001' })
  const clientB = new JarvisClient({ apiUrl: 'http://127.0.0.1:41002' })
  const input = { content: 'race source' }
  const raced = await Promise.allSettled([
    new PersonalJarvisQueue(root, clientA).submit('same-effect', input, root),
    new PersonalJarvisQueue(root, clientB).submit('same-effect', input, root),
  ])
  expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = raced.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  expect(rejected).toHaveLength(1)
  expect(String(rejected[0]!.reason)).toContain('JARVIS_OBSERVATION_DESTINATION_CHANGED')
  const winner = raced.find((result): result is PromiseFulfilledResult<Record<string, unknown>> => result.status === 'fulfilled')!
  const sent = calls.filter(call => call.body.externalId === winner.value.externalId)
  expect(new Set(sent.map(call => call.port)).size).toBe(1)
  expect(new Set(sent.map(call => call.body.occurredAt)).size).toBe(1)
  const shared = new JarvisClient({ apiUrl: 'http://127.0.0.1:41003' })
  const same = await Promise.all([
    new PersonalJarvisQueue(root, shared).submit('shared-effect', input, root),
    new PersonalJarvisQueue(root, new JarvisClient({ apiUrl: 'http://127.0.0.1:41003' })).submit('shared-effect', input, root),
  ])
  expect(same[0]).toMatchObject({ externalId: same[1]!.externalId, status: 'received' })
  const sharedCalls = calls.filter(call => call.body.externalId === same[0]!.externalId)
  expect(sharedCalls.length).toBeGreaterThan(0)
  expect(new Set(sharedCalls.map(call => call.port))).toEqual(new Set(['41003']))
  expect(new Set(sharedCalls.map(call => call.body.occurredAt)).size).toBe(1)
})
