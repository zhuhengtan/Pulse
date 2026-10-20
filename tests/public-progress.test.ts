import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'

it('publishes ordinary model commentary before a tool result even without streaming deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-public-progress-'))
  let requests = 0
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    requests++
    const calls = requests === 1 ? [{ id: 'list-1', type: 'function', function: { name: 'fs.list', arguments: '{"path":"."}' } }] : undefined
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: calls ? '已确认需求，接下来检查工作目录。' : '目录检查完成。', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] }))
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: false, approvalMode: 'auto', provider: { provider: 'openai', defaultModel: 'test', baseURL: `http://127.0.0.1:${(provider.address() as any).port}/v1` } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '检查工作目录并简要汇报进展' })
    const events = []
    for await (const event of run.events) events.push(event)
    expect(await run.outcome()).toMatchObject({ status: 'succeeded', text: '目录检查完成。' })
    const note = events.findIndex(event => event.type === 'observation' && (event.data as any).kind === 'note' && (event.data as any).text === '已确认需求，接下来检查工作目录。')
    const result = events.findIndex(event => event.type === 'observation' && (event.data as any).tool === 'fs.list' && (event.data as any).status === 'succeeded')
    expect(note).toBeGreaterThan(-1)
    expect(result).toBeGreaterThan(note)
  } finally { await host.close(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
