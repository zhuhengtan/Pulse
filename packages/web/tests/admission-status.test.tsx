import { describe, expect, it } from 'vitest'
import { admissionLabel, compactRunLabel, snapshotAdmission } from '../src/run-status.js'
import { emptyTrace, reduceTrace, traceDuration } from '../src/RunTrace.js'
import { MessageQueueController, queueAdapter, type ConversationQueue, type QueueStore } from '../src/MessageQueue.js'
import type { PulseWebTransport, WebRunAdmission, WebRunEvent, WebRunSnapshot } from '../src/transport.js'

const status = (admission?: WebRunAdmission): WebRunEvent => ({ type: 'status', runId: 'run', seq: 1, runStartedAt: 1000, data: { kind: 'working', ...(admission ? { admission } : {}) } })

describe('background admission status', () => {
  it.each([
    ['queued', '排队中'], ['starting', '正在启动'], ['cancelling', '正在停止'], ['quarantined', '任务状态需检查'],
  ] as const)('prioritizes %s over ordinary execution and stale completion', (phase, label) => {
    expect(compactRunLabel({ running: true, admission: { phase }, recovering: true, interaction: 'approval', completeLabel: '任务已完成', steps: [] })).toBe(label)
  })
  it('shows queue position and keeps legacy running behavior', () => {
    expect(admissionLabel({ phase: 'queued', position: 3 })).toBe('排队中（第 3 位）')
    expect(compactRunLabel({ running: true, steps: [] })).toBe('执行中')
    expect(compactRunLabel({ running: true, admission: { phase: 'running' }, steps: [] })).toBe('执行中')
  })
  it('restores admission from snapshots or older status envelopes', () => {
    const snapshot: WebRunSnapshot = { runId: 'run', seq: 1, state: 'running', activities: [] }
    expect(snapshotAdmission(snapshot)).toBeUndefined()
    expect(snapshotAdmission({ ...snapshot, status: status({ phase: 'queued' }) as Extract<WebRunEvent, { type: 'status' }> })?.phase).toBe('queued')
    expect(snapshotAdmission({ ...snapshot, admission: { phase: 'starting' } })?.phase).toBe('starting')
  })
  it('excludes all queue time and ignores stale runStartedAt after admission', () => {
    let trace = reduceTrace(emptyTrace, status({ phase: 'queued', queuedAt: 1000 }))
    expect(trace.startedAt).toBeUndefined()
    trace = reduceTrace(trace, status({ phase: 'starting', queuedAt: 1000 }))
    expect(trace.startedAt).toBeUndefined()
    trace = reduceTrace(trace, status({ phase: 'running', queuedAt: 1000, startedAt: 11000 }))
    trace = reduceTrace(trace, status())
    expect(trace.startedAt).toBe(11000)
    expect(traceDuration({ ...trace, endedAt: 14000 })).toBe('3 秒')
  })
  it('retains legacy event timing and removes provisional queue time', () => {
    const legacy = reduceTrace(emptyTrace, status())
    expect(legacy.startedAt).toBe(1000)
    expect(reduceTrace(legacy, status({ phase: 'queued', queuedAt: 1000 })).startedAt).toBeUndefined()
  })
  it.each(['queued', 'starting', 'cancelling', 'quarantined'] as const)('never drains the per-conversation queue while %s', async phase => {
    let saved: ConversationQueue | undefined
    let sends = 0
    const store: QueueStore = {
      list: async () => saved ? [structuredClone(saved)] : [],
      update: async (_key, change) => saved = change(saved ? structuredClone(saved) : undefined),
    }
    const transport: PulseWebTransport = {
      request: async path => {
        if (path === '/api/conversations/conversation') return new Response(JSON.stringify({ id: 'conversation', activeRunId: 'run' }))
        if (path === '/api/runs/run/state') return new Response(JSON.stringify({ runId: 'run', state: 'running', seq: 1, activities: [], admission: { phase } }))
        sends++; throw new Error('must not send')
      },
      subscribe: () => () => {},
    }
    const controller = new MessageQueueController('test', store, queueAdapter(transport), () => {})
    await controller.enqueue('conversation', 'work', { text: 'next' }, 'run')
    await controller.tick(); await controller.tick()
    expect(sends).toBe(0)
    expect(saved?.entries).toHaveLength(1)
    expect(saved?.awaitingRunId).toBe('run')
    controller.close()
  })
})
