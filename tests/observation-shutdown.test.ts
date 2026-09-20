import { describe, expect, it } from 'vitest'
import { FileRuntimeTelemetryExporter, PulseRuntime, defineLaneProgram } from '@pulse/runtime'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('observation inbox and shutdown', () => {
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
})
