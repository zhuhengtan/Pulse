import { describe, expect, it, vi } from 'vitest'
import { compactTraceEvents, prepareRunEvent, sanitizeTraceEvent, traceWatermark } from '../packages/server/src/h5/trace.js'
import type { WebRunEvent } from '../packages/server/src/protocol.js'

describe('browser execution trace boundary', () => {
  it('redacts nested credentials, command flags, output and errors without discarding useful details', () => {
    const event: WebRunEvent = { type: 'tool', runId: 'run', seq: 1, data: {
      activityId: 'tool:attempt', effectId: 'tool', tool: 'shell.exec', status: 'failed',
      args: { command: 'curl', args: ['--api-key', 'argv-secret', '--password=flag-secret', '-H', 'Authorization: Basic header-secret', '-H', 'Cookie: session=header-cookie-secret'], options: { password: 'nested-secret', cookies: ['cookie-secret'] }, cwd: 'src' },
      preview: { output: 'token=output-secret\nChecked 3 files', exitCode: 1 },
      error: { code: 'SHELL_COMMAND_FAILED', stderr: 'password=error-secret\nhttps://example.com/path?token=url-secret', details: { apiKey: 'error-key' }, command: 'curl -u name:basic-secret https://example.com' },
    } }
    const safe = sanitizeTraceEvent(event)
    expect(safe.type).toBe('tool')
    const serialized = JSON.stringify(safe)
    for (const secret of ['argv-secret', 'flag-secret', 'header-secret', 'nested-secret', 'cookie-secret', 'header-cookie-secret', 'basic-secret', 'output-secret', 'error-secret', 'url-secret', 'error-key']) expect(serialized).not.toContain(secret)
    expect(serialized).toContain('Checked 3 files')
    expect(serialized).toContain('SHELL_COMMAND_FAILED')
    expect(serialized).toContain('src')
    expect(event.data.args?.options).toEqual({ password: 'nested-secret', cookies: ['cookie-secret'] })
    const ordinary = sanitizeTraceEvent({ type: 'tool', runId: 'run', seq: 2, data: {
      activityId: 'tool:flags', effectId: 'tool', tool: 'shell.exec', status: 'succeeded',
      args: { command: 'git', args: ['push', '-u', 'origin', '&&', 'tar', '-b', '20'] },
      preview: { output: 'curl -u name:basic-secret https://example.com && curl --cookie session=cookie-secret' },
    } })
    const ordinaryText = JSON.stringify(ordinary)
    expect(ordinaryText).toContain('origin')
    expect(ordinaryText).toContain('20')
    expect(ordinaryText).not.toContain('basic-secret')
    expect(ordinaryText).not.toContain('cookie-secret')
    const huge = 'x'.repeat(9_000)
    const bounded = sanitizeTraceEvent({ type: 'tool', runId: 'run', seq: 3, data: { activityId: 'tool:size', effectId: 'tool', tool: 'fs.read', status: 'succeeded', args: { path: huge }, error: { stderr: huge } } })
    if (bounded.type !== 'tool') throw new Error('TOOL_MISSING')
    expect(bounded.data.args?.path).toHaveLength(8_192)
    expect(JSON.stringify(bounded.data.error)).toContain('x'.repeat(8_192))
    expect(JSON.stringify(bounded.data.error)).not.toContain('x'.repeat(8_193))
    // Existing on-disk traces pass through the same boundary when reopened.
    expect(compactTraceEvents([event])).toEqual([safe])
  })

  it('stamps original publication time and carries the same start time through persistence', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const first = prepareRunEvent({ type: 'status', runId: 'run', seq: 1, data: { kind: 'working' } })
      now.mockReturnValue(91_000)
      const last = prepareRunEvent({ type: 'complete', runId: 'run', seq: 2, data: { status: 'succeeded' } }, first.runStartedAt)
      now.mockReturnValue(999_000)
      const restored = compactTraceEvents(JSON.parse(JSON.stringify([first, last])))
      expect(restored.map(event => [event.runStartedAt, event.timestamp])).toEqual([[1_000, 1_000], [1_000, 91_000]])
      expect(compactTraceEvents([{ type: 'complete', runId: 'legacy', seq: 1, data: { status: 'succeeded' } }])[0]?.timestamp).toBeUndefined()
    } finally { now.mockRestore() }
  })

  it('keeps fallback reasoning separate and gives each attempt its own text allowance', () => {
    const events: WebRunEvent[] = [
      { type: 'trace', runId: 'run', seq: 1, data: { kind: 'reasoning', effectId: 'llm', laneId: 'root', attemptId: 'a1', attemptNo: 1, task: 'reason', text: 'A'.repeat(25_000) } },
      { type: 'trace', runId: 'run', seq: 2, data: { kind: 'reasoning', effectId: 'llm', laneId: 'root', attemptId: 'a2', attemptNo: 2, task: 'reason', text: 'B' } },
      { type: 'trace', runId: 'run', seq: 3, data: { kind: 'reasoning', effectId: 'llm', laneId: 'root', attemptId: 'a2', attemptNo: 2, task: 'reason', text: 'C' } },
    ]
    const compacted = compactTraceEvents(events)
    expect(compacted).toHaveLength(2)
    expect(compacted[0]?.type === 'trace' && 'text' in compacted[0].data && compacted[0].data.text.length).toBe(24_000)
    expect(compacted[1]).toMatchObject({ data: { attemptId: 'a2', text: 'BC' } })
  })

  it('moves a folded reasoning event to the latest seq and keeps the raw watermark ahead of dropped events', () => {
    const events: WebRunEvent[] = [
      { type: 'trace', runId: 'run', seq: 2, timestamp: 20, data: { kind: 'reasoning', effectId: 'llm', attemptId: 'a1', task: 'reason', text: '历史思考' } },
      { type: 'trace', runId: 'run', seq: 3, timestamp: 30, data: { kind: 'reasoning', effectId: 'llm', attemptId: 'a1', task: 'reason', text: '加载期间思考' } },
      { type: 'text', runId: 'run', seq: 4, data: 'answer' },
    ]
    const compacted = compactTraceEvents(events)
    expect(compacted).toMatchObject([{ seq: 3, timestamp: 30, data: { text: '历史思考加载期间思考' } }])
    expect(traceWatermark(events)).toBe(4)
    expect(traceWatermark(compacted)).toBe(3)
  })
})
