import { describe, expect, it } from 'vitest'
import { FileRuntimeTelemetryExporter, HttpRuntimeTelemetryExporter, ObservationInbox, PulseRuntime, RuntimeTelemetryAggregator, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('observation inbox and shutdown', () => {
  it('reports dropped observation sequence ranges for slow session consumers', () => {
    const inbox = new ObservationInbox(2)
    inbox.enqueue({ agentId: 'agent-a', type: 'trace', data: { n: 1 }, timestamp: 1 })
    inbox.enqueue({ agentId: 'agent-b', type: 'trace', data: { n: 2 }, timestamp: 2 })
    inbox.enqueue({ agentId: 'agent-a', type: 'trace', data: { n: 3 }, timestamp: 3 })
    expect(inbox.droppedThrough('agent-a')).toBe(1)
    expect(inbox.droppedThrough('agent-b')).toBe(0)
    expect(inbox.snapshot()).toMatchObject([{ agentId: 'agent-b' }, { agentId: 'agent-a' }])
  })

  it('bounds observations by bytes as well as entry count', () => {
    const inbox = new ObservationInbox(10, 120)
    inbox.enqueue({ agentId: 'agent-a', type: 'trace', data: { payload: 'first' }, timestamp: 1 })
    inbox.enqueue({ agentId: 'agent-a', type: 'trace', data: { payload: 'second' }, timestamp: 2 })
    expect(inbox.size).toBe(1)
    expect(inbox.sizeBytes).toBeLessThanOrEqual(120)
    expect(inbox.droppedThrough('agent-a')).toBe(1)
  })

  it('allows Runtime hosts to configure the observation ring limits', () => {
    const runtime = new PulseRuntime({ maxObservationEntries: 1, maxObservationBytes: 120 })
    runtime.observationInbox.enqueue({ agentId: 'agent-a', type: 'trace', data: { payload: 'first' }, timestamp: 1 })
    runtime.observationInbox.enqueue({ agentId: 'agent-a', type: 'trace', data: { payload: 'second' }, timestamp: 2 })
    expect(runtime.observationInbox.size).toBe(1)
    expect(runtime.observationInbox.maxEntries).toBe(1)
    expect(runtime.observationInbox.maxBytes).toBe(120)
  })

  it('surfaces an observation gap through Session.stream()', async () => {
    const runtime = new PulseRuntime()
    const program = defineLaneProgram({ id: 'observation-gap', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'start' }))
    })
    const { agentId } = runtime.createAgent('observation gap', program)
    const session = runtime.start(agentId)
    for (let index = 0; index <= 4096; index++) runtime.observationInbox.enqueue({ agentId, type: 'trace', data: { index }, timestamp: index })
    const stream = session.stream()[Symbol.asyncIterator]()
    let gap: Awaited<ReturnType<typeof stream.next>>['value']
    for (let index = 0; index < 100 && gap === undefined; index++) {
      const event = (await stream.next()).value
      if (event?.kind === 'gap') gap = event
    }
    expect(gap).toMatchObject({ kind: 'gap', fromSeq: 1, toSeq: 1 })
    await stream.return?.()
  })

  it('keeps trace outside the fact log and exposes it to inspection', async () => {
    const program = defineLaneProgram({ id: 'observe', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => { ctx.trace({ kind: 'diagnostic', data: { phase: 'start' } }); return { actions: [{ type: 'complete', result: { ok: true } }], next: 'start' } })
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('observe', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.observationInbox.size).toBe(1)
    expect(runtime.state.events.some((event) => event.type === 'trace')).toBe(false)
    expect(runtime.inspect()).toMatchObject({ observationsPending: 1 })
  })

  it('returns an explicit shutdown status and unresolved list', async () => {
    const runtime = new PulseRuntime()
    const program = defineLaneProgram({ id: 'shutdown', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'start' }))
    })
    runtime.createAgent('shutdown', program)
    const result = await runtime.shutdown()
    expect(result.status).toBe('stopped')
    expect(result.unresolvedEffectIds).toEqual([])
    expect(() => runtime.createAgent('after shutdown', program)).toThrow('RUNTIME_SHUTTING_DOWN')
  })

  it('drains already queued Host Facts before shutdown returns', async () => {
    const runtime = new PulseRuntime()
    runtime.enqueueHostCommand({ type: 'cancel', agentId: 'missing-agent', reason: 'USER_REQUESTED' })
    expect(runtime.factInbox.size).toBe(1)
    await runtime.shutdown()
    expect(runtime.factInbox.size).toBe(0)
    expect(runtime.state.events.some((event) => event.type === 'command.applied')).toBe(true)
  })

  it('exports telemetry through an atomic append-only host boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-telemetry-'))
    try {
      const exporter = new FileRuntimeTelemetryExporter(join(directory, 'runtime.jsonl'))
      const runtime = new PulseRuntime({ telemetryExporter: exporter })
      const snapshot = await runtime.exportTelemetry(123)
      await runtime.exportTelemetry(124)
      const lines = (await readFile(join(directory, 'runtime.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { schemaVersion: number; timestamp: number; snapshot: typeof snapshot })
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({ schemaVersion: 1, timestamp: 123, snapshot: { agents: { total: 0 } } })
      expect(lines[1]?.timestamp).toBe(124)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('aggregates telemetry peaks and emits cooled-down threshold alerts', () => {
    const aggregator = new RuntimeTelemetryAggregator([{ id: 'lanes-high', metric: 'lanes.total', threshold: 2, direction: 'above', cooldownMs: 100 }])
    const runtime = new PulseRuntime()
    const first = runtime.telemetry(); first.lanes.total = 2
    const second = runtime.telemetry(); second.lanes.total = 3
    const third = runtime.telemetry(); third.lanes.total = 4
    expect(aggregator.ingest({ schemaVersion: 1, timestamp: 0, snapshot: first })).toHaveLength(1)
    expect(aggregator.ingest({ schemaVersion: 1, timestamp: 50, snapshot: second })).toHaveLength(0)
    expect(aggregator.ingest({ schemaVersion: 1, timestamp: 100, snapshot: third })).toHaveLength(1)
    expect(aggregator.snapshot()).toMatchObject({ sampleCount: 3, peaks: { 'lanes.total': 4 }, alerts: [{ ruleId: 'lanes-high', value: 2 }, { ruleId: 'lanes-high', value: 4 }] })
  })

  it('publishes a complete envelope to an HTTP collector and fails closed on non-2xx', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const exporter = new HttpRuntimeTelemetryExporter({ endpoint: 'https://collector.test/telemetry', headers: { authorization: 'Bearer test' }, fetch: async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(null, { status: 202 }) } })
    const envelope = { schemaVersion: 1 as const, timestamp: 42, snapshot: new PulseRuntime().telemetry() }
    await exporter.publish(envelope)
    expect(calls[0]?.url).toBe('https://collector.test/telemetry')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' } })
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ schemaVersion: 1, timestamp: 42 })
    const rejected = new HttpRuntimeTelemetryExporter({ endpoint: 'https://collector.test/telemetry', fetch: async () => new Response(null, { status: 503 }) })
    await expect(rejected.publish(envelope)).rejects.toThrow('TELEMETRY_HTTP_503')
  })
})
