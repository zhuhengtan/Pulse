import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHost, H5Server, type AssistantEvent } from '../packages/server/src/index.js'
import type { WebRunEvent } from '../packages/server/src/protocol.js'

describe('H5 trace publication and cold restore', () => {
  it('redacts before SSE and disk writes, preserves attempt identity/timing, and sanitizes legacy traces on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-h5-trace-'))
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockResponse: '完成' })
    let server = new H5Server(host, { dataDir: dir, host: '127.0.0.1', port: 0 })
    const sendMessage = host.sendMessage.bind(host)
    const spy = vi.spyOn(host, 'sendMessage').mockImplementation(async (conversationId, input) => {
      const handle = await sendMessage(conversationId, input)
      const injected: AssistantEvent['data'][] = [
        { kind: 'tool_start', effectId: 'trace-tool', laneId: 'trace-root', attemptId: 'tool-a1', tool: 'shell.exec', args: { command: 'echo', args: ['--api-key', 'argv-secret'] } },
        { effectId: 'trace-tool', laneId: 'trace-root', attemptId: 'tool-a1', tool: 'shell.exec', status: 'failed', args: { password: 'argument-secret' }, preview: { output: 'token=output-secret' }, result: { stderr: 'password=error-secret', code: 'FAILED' } },
        { kind: 'model', effectId: 'trace-llm', laneId: 'trace-root', attemptId: 'llm-a1', attemptNo: 1, task: 'reason', modelId: 'A', fallback: false },
        { kind: 'reasoning', effectId: 'trace-llm', laneId: 'trace-root', attemptId: 'llm-a1', attemptNo: 1, task: 'reason', text: 'A thought' },
        { kind: 'model', effectId: 'trace-llm', laneId: 'trace-root', attemptId: 'llm-a2', attemptNo: 2, task: 'reason', modelId: 'B', fallback: true },
        { kind: 'reasoning', effectId: 'trace-llm', laneId: 'trace-root', attemptId: 'llm-a2', attemptNo: 2, task: 'reason', text: 'B thought' },
      ]
      return { ...handle, events: (async function* () {
        for (const [index, data] of injected.entries()) yield { schemaVersion: 1 as const, conversationId, runId: handle.id, seq: index + 1, type: 'observation' as const, data }
        for await (const event of handle.events) yield { ...event, seq: event.seq + injected.length }
      })() }
    })
    try {
      await host.init()
      const info = await server.start()
      const base = `http://127.0.0.1:${info.port}`
      const paired = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Trace test' }) })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const conversation = await host.createConversation({ title: 'Trace' })
      const sent = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: '简单回复即可' }) })
      expect(sent.status).toBe(200)
      const { runId } = await sent.json() as { runId: string }
      const sse = await fetch(`${base}/api/runs/${runId}/events`, { headers: { Cookie: cookie } }).then(response => response.text())
      for (const secret of ['argv-secret', 'argument-secret', 'output-secret', 'error-secret']) expect(sse).not.toContain(secret)
      const live = await fetch(`${base}/api/runs/${runId}/trace`, { headers: { Cookie: cookie } }).then(response => response.json()) as { events: WebRunEvent[]; seq: number }
      expect(live.seq).toBeGreaterThan(6)
      expect(live.events.filter(event => event.type === 'trace' && event.data.effectId === 'trace-llm')).toMatchObject([
        { data: { kind: 'model', attemptId: 'llm-a1', attemptNo: 1 } },
        { data: { kind: 'reasoning', attemptId: 'llm-a1', text: 'A thought' } },
        { data: { kind: 'model', attemptId: 'llm-a2', attemptNo: 2 } },
        { data: { kind: 'reasoning', attemptId: 'llm-a2', text: 'B thought' } },
      ])
      const runtimeModels = live.events.filter(event => event.type === 'trace' && event.data.kind === 'model' && event.data.effectId !== 'trace-llm')
      expect(runtimeModels.length).toBeGreaterThan(0)
      expect(runtimeModels.every(event => event.type === 'trace' && typeof event.data.attemptId === 'string')).toBe(true)
      const path = join(dir, 'conversations', conversation.id, 'runs', runId, 'web-trace.json')
      let persisted = ''
      await vi.waitFor(async () => { persisted = await readFile(path, 'utf8'); expect(JSON.parse(persisted).events.length).toBeGreaterThan(0) })
      for (const secret of ['argv-secret', 'argument-secret', 'output-secret', 'error-secret']) expect(persisted).not.toContain(secret)
      expect(live.events.every(event => typeof event.timestamp === 'number' && event.runStartedAt === live.events[0]?.runStartedAt)).toBe(true)
      await server.stop()
      // A legacy file can still contain credentials; do not expose them on read.
      const legacy = JSON.parse(persisted) as { events: WebRunEvent[] }
      const tool = legacy.events.find(event => event.type === 'tool')
      if (tool?.type !== 'tool') throw new Error('TOOL_MISSING')
      tool.data.args = { apiKey: 'legacy-secret' }
      await writeFile(path, JSON.stringify(legacy))
      server = new H5Server(host, { dataDir: dir, host: '127.0.0.1', port: 0 })
      const restarted = await server.start()
      const cold = await fetch(`http://127.0.0.1:${restarted.port}/api/runs/${runId}/trace`, { headers: { Cookie: cookie } }).then(response => response.json()) as { events: WebRunEvent[] }
      expect(cold.events.length).toBe(live.events.length)
      expect(JSON.stringify(cold)).not.toContain('legacy-secret')
      expect(cold.events.map(event => [event.timestamp, event.runStartedAt])).toEqual(live.events.map(event => [event.timestamp, event.runStartedAt]))
    } finally {
      spy.mockRestore()
      await server.stop()
      await host.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
