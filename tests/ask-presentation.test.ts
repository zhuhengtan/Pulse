import { readConversationFixture } from './conversation-fixtures.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it.each(['choice', 'multi', 'input'] as const)('accepts and persists a custom %s answer with the original question and background', async type => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-ask-presentation-'))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), mockToolCalls: [{ name: `ask.${type}`, input: { prompt: '选择哪种方案？', context: '现有项目需要兼顾维护成本。', ...(type !== 'input' ? { options: [{ label: '渐进调整（推荐）', value: 'incremental', description: '保留现有入口，降低迁移成本。' }, { label: '', value: '' }], ...(type === 'multi' ? { min: 1 } : {}) } : {}) } }], mockAfterToolResponse: '已收到你的方案。' })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '先询问我的方案' })
    for await (const event of run.events) {
      if (event.type !== 'waiting') continue
      const data = event.data as any
      expect(data.input).toMatchObject({ prompt: '选择哪种方案？', context: '现有项目需要兼顾维护成本。' })
      if (type !== 'input') expect(data.input.options).toEqual([{ label: '渐进调整（推荐）', value: 'incremental', description: '保留现有入口，降低迁移成本。' }])
      await expect(run.reply(data.effectId, { text: '   ' })).rejects.toThrow('ASK_RESPONSE_INVALID:text')
      await run.replyBatch((await run.pendingInteractions())[0]!.groupId, [{ effectId: data.effectId, value: { text: '我选择分两阶段迁移。\n先完成界面，再改后端。' } }])
    }
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    const messages = await host.getWebConversationMessages(conversation.id)
    expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: '选择哪种方案？\n\n现有项目需要兼顾维护成本。' }))
    expect(messages).toContainEqual(expect.objectContaining({ role: 'user', text: '我选择分两阶段迁移。\n先完成界面，再改后端。' }))
    expect(messages.filter(message => message.id.startsWith('ask-answer-'))).toHaveLength(1)
    await host.close()
    const restored = createLocalHost({ cwd: root, dataDir: join(root, 'data') })
    try { expect(await restored.getWebConversationMessages(conversation.id)).toEqual(messages) } finally { await restored.close() }
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('exposes Ask presentation through HTTP and records a textarea answer idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-ask-http-'))
  const host = createLocalHost({ cwd: root, dataDir: root, mockToolCalls: [{ name: 'ask.choice', input: { prompt: '选择部署方式？', context: '当前只有一台测试机。', options: [{ label: '本地预览（推荐）', description: '先验证交互流程。', value: 'local' }] } }], mockAfterToolResponse: '收到。' })
  const server = new H5Server(host, { dataDir: root, port: 0, host: '127.0.0.1' })
  try {
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const conversation = await host.createConversation()
    const sent = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: '先问我部署方式' }) }).then(response => response.json()) as any
    let group: any
    for (let i = 0; i < 100 && !group; i++) {
      group = (await fetch(`${base}/api/runs/${sent.runId}/state`, { headers }).then(response => response.json()) as any).interactions?.[0]
      if (!group) await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(group.items[0].input).toMatchObject({ context: '当前只有一台测试机。', options: [{ label: '本地预览（推荐）', description: '先验证交互流程。', value: 'local' }] })
    const body = JSON.stringify({ conversationId: conversation.id, groupId: group.groupId, requestId: 'textarea-reply-001', answers: [{ effectId: group.items[0].effectId, value: { text: '使用隔离环境验证。' } }] })
    for (let i = 0; i < 2; i++) expect((await fetch(`${base}/api/runs/${sent.runId}/replies`, { method: 'POST', headers, body })).status).toBe(200)
    const messages = await fetch(`${base}/api/web/conversations/${conversation.id}/messages`, { headers }).then(response => response.json()) as any[]
    expect(messages.filter(message => message.text === '使用隔离环境验证。')).toHaveLength(1)
    const stored = await readConversationFixture(join(root, 'conversations', conversation.id, 'messages.jsonl'), 'utf8')
    expect(stored).toContain('选择部署方式？')
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
