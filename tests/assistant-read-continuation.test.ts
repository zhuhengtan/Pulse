import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'

afterEach(() => vi.unstubAllGlobals())

it.each(['files', 'pages', 'corrected-path', 'repeated-window'] as const)('supports bounded assistant read continuation: %s', async scenario => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-assistant-reads-'))
  await writeFile(join(directory, 'a.txt'), 'first\nsecond\n')
  await writeFile(join(directory, 'b.txt'), 'other file\n')
  const requests: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request)
    const turn = requests.length
    const tool = scenario === 'repeated-window' || turn < 3
    const args = scenario === 'files' ? { path: turn === 1 ? 'a.txt' : 'b.txt' }
      : scenario === 'pages' ? { path: 'a.txt', maxBytes: 6, offset: turn === 1 ? 0 : 6 }
      : scenario === 'corrected-path' ? { path: turn === 1 ? 'missing.txt' : 'b.txt' }
      : { path: 'a.txt', offset: 0 }
    const message = tool ? { content: '', tool_calls: [{ id: `read-${turn}`, function: { name: 'fs_read', arguments: JSON.stringify(args) } }] } : { content: '已读取完整请求内容' }
    return Response.json({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  }))
  const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
  const dataDir = join(directory, 'data')
  const host = createLocalHost({ cwd: directory, dataDir, provider, providerProfiles: { fixture: provider }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', approvalMode: 'ask' })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '读取 a.txt 和 b.txt；必要时继续分页', assistantChat: true })
    const events: any[] = []
    for await (const event of run.events) events.push(event)
    const outcome = await run.outcome()
    expect(events.some(event => event.type === 'waiting')).toBe(false)
    const saved = JSON.parse(await readFile(join(dataDir, 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
    expect(saved.assistantChatVersion).toBe('5')
    if (scenario === 'repeated-window') {
      expect(outcome.status).toBe('failed')
      expect(requests.length).toBeLessThanOrEqual(12)
    } else {
      expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded')
      expect(requests).toHaveLength(3)
      expect(outcome.text).toBe('已读取完整请求内容')
      const output = JSON.stringify(requests[2])
      expect(output).toContain(scenario === 'pages' ? 'second' : 'other file')
      expect(output).not.toContain('Tool fs.read is not allowed')
    }
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
})
