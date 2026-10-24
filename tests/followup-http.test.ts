import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RichContent } from '../packages/server/src/rich-content.js'
import { createLocalHost, H5Server, type HumanInputOptions } from '../packages/server/src/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(surface: 'chat' | 'work') {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-followup-http-'))
  const host = createLocalHost({ cwd: dir, dataDir: dir, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', jarvis: { enabled: false } })
  await host.init(); const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
  const { port } = await server.start(), base = `http://127.0.0.1:${port}`
  const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
  const headers = { Cookie: session.headers.get('set-cookie')!.split(';')[0]!, Origin: base, 'Content-Type': 'application/json' }
  const conversationId = surface === 'chat' ? (await fetch(`${base}/api/assistant`, { headers }).then(response => response.json()) as any).conversation.id : (await host.createConversation()).id
  const manifest = await host.conversationData.call<Record<string, unknown>>('get', conversationId), runId = `run-${randomUUID()}`
  await host.conversationData.call('save', { ...manifest, activeRunId: runId, runs: [runId] })
  const cancel = vi.fn(async () => {}), replyBatch = vi.fn(async () => {})
  const submit = vi.fn(async (text: string, _effectId?: string, options: HumanInputOptions = {}) => {
    await host.appendAssistantUserMessage(conversationId, { id: `msg-${options.requestId}`, text, runId, createdAt: new Date().toISOString(), ...(options.attachments ? { attachments: options.attachments } : {}), ...(options.skills ? { skills: options.skills } : {}), ...(options.mentionedFiles ? { mentionedFiles: options.mentionedFiles } : {}), ...(options.richContent ? { richContent: options.richContent } : {}) })
  })
  ;(server as any).activeRuns.set(runId, { id: runId, conversationId, submitHumanInput: submit, cancel, replyBatch, pendingInteractions: async () => [] })
  cleanups.push(async () => { (server as any).activeRuns.delete(runId); await server.stop(); await host.close(); await new Promise(resolve => setTimeout(resolve, 200)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  return { host, server, base, headers, conversationId, runId, cancel, replyBatch, submit, post, path: surface === 'chat' ? '/api/assistant/messages' : `/api/conversations/${conversationId}/messages` }
}
describe('follow-up HTTP routing', () => {
  it.each(['chat', 'work'] as const)('routes %s immediate input to the active primary with full payload and deduplicates', async surface => {
    const f = await fixture(surface)
    const richContent: RichContent = { version: 1, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '请先回答这个问题', marks: [{ type: 'bold' }] }] }] } }
    const body = { richContent, requestId: 'followup-request-001', delivery: 'immediate', text: '请先回答这个问题', mentionedFiles: ['example.ts'], attachments: [{ id: 'note-attachment', name: 'note.txt', type: 'file', mediaType: 'text/plain', size: 4, data: 'data:text/plain;base64,dGVzdA==' }] }
    const response = await f.post(f.path, body); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ runId: f.runId })
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.submit.mock.calls[0]?.[2]).toMatchObject({ richContent, requestId: body.requestId, mentionedFiles: ['example.ts'], attachments: [expect.objectContaining({ id: 'note-attachment' })] })
    expect(f.cancel).not.toHaveBeenCalled()
    const duplicate = await f.post(f.path, body); expect(duplicate.status).toBe(200); expect(f.submit).toHaveBeenCalledTimes(1)
    expect((await f.post(f.path, { ...body, text: 'different' })).status).toBe(409)
    expect((await f.post(f.path, { ...body, richContent: { version: 1, document: { type: 'doc', content: [{ type: 'paragraph' }] } } })).status).toBe(409)
    expect((await f.post(f.path, { ...body, requestId: 'unsafe-rich-input', richContent: { version: 1, document: { type: 'script' } } })).status).toBe(400)
    expect((await f.host.getConversationMessages(f.conversationId)).filter(message => message.id === `msg-${body.requestId}`)).toHaveLength(1)
  })
  it.each(['chat', 'work'] as const)('does not put frontend-queued %s input into a server queue during a busy race', async surface => {
    const f = await fixture(surface), response = await f.post(f.path, { requestId: 'queue-message-001', text: 'later', delivery: 'whenIdle' })
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'CONVERSATION_BUSY' }); expect(f.submit).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled()
    expect((await f.host.getConversationMessages(f.conversationId)).some(message => message.text === 'later')).toBe(false)
  })
  it('persists a fixed-ID Host input with attachments once across concurrent retries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-host-input-id-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'fixed input accepted', taskController: false, jarvis: { enabled: false } })
    try {
      await host.init(); const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'original task' })
      const options: HumanInputOptions = { requestId: 'fixed-host-input', mentionedFiles: ['note.txt'], attachments: [{ id: 'host-note', name: 'note.txt', type: 'file', mediaType: 'text/plain', size: 4, data: 'data:text/plain;base64,dGVzdA==' }] }
      await Promise.all([run.submitHumanInput('record this input', undefined, options), run.submitHumanInput('record this input', undefined, options)])
      await expect(run.submitHumanInput('different', undefined, options)).rejects.toThrow('REQUEST_ID_REUSED')
      const events = []; for await (const event of run.events) events.push(event)
      const messages = (await host.getConversationMessages(conversation.id)).filter(message => message.id === 'msg-fixed-host-input')
      expect(messages).toHaveLength(1); expect(messages[0]).toMatchObject({ text: 'record this input', mentionedFiles: ['note.txt'], attachments: [expect.objectContaining({ id: 'host-note' })] })
      expect(events.filter(event => (event.data as any)?.inputId === 'human-fixed-host-input' && (event.data as any)?.decision === 'spawn')).toHaveLength(1)
    } finally { await host.close(); await new Promise(resolve => setTimeout(resolve, 200)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })
  it('lets the assistant send instructions to running work without cancelling it', async () => {
    const f = await fixture('work')
    await (f.server as any).sendToWork(f.conversationId, '新的用户指令')
    expect(f.submit).toHaveBeenCalledWith('新的用户指令'); expect(f.cancel).not.toHaveBeenCalled()
  })
  it('keeps targeted ask answers separate from primary input and invokes explicit cancellation only on stop', async () => {
    const f = await fixture('work'), answers = [{ effectId: 'effect-ask', value: { text: 'only this answer' } }]
    const response = await f.post(`/api/runs/${f.runId}/replies`, { conversationId: f.conversationId, groupId: 'ask-group', requestId: 'reply-request-001', answers })
    expect(response.status).toBe(200); expect(f.replyBatch).toHaveBeenCalledTimes(1); expect(f.replyBatch).toHaveBeenCalledWith('ask-group', answers); expect(f.submit).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled()
    await f.post(`/api/runs/${f.runId}/cancel`, {}); expect(f.cancel).toHaveBeenCalledOnce()
  })
})
