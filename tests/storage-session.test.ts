import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, exportRuntimeLog, exportRuntimeLogTo, exportRuntimeState, FileRuntimeLogSink, HttpRuntimeLogSink, importRuntimeState, PulseRuntime, serializeRuntimeState } from '@pulse/runtime'

describe('session serialization boundary', () => {
  it('round-trips Runtime state without losing Maps, Sets, references, events, or Infinity limits', () => {
    const state = createRuntimeState(9, { maxQueuedEffects: 3, maxRunning: { tool: 2 } })
    const { agent, root } = createAgent(state, 'serialize', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    root.children.add('lane-child')
    root.ownedEffectIds.add('effect-1')
    state.events.push({ seq: 1, type: 'agent.created', laneId: root.id, data: { goal: agent.goal ?? 'serialize' } })
    const snapshot = exportRuntimeState(state)
    const restored = importRuntimeState(JSON.parse(JSON.stringify(serializeRuntimeState(state))))
    expect(restored.maxTotalLanes).toBe(9)
    expect(restored.maxRunning.none).toBe(Number.POSITIVE_INFINITY)
    expect(restored.agents.get(agent.id)?.globalVersions.get(0)).toEqual({})
    expect(restored.lanes.get(root.id)?.children).toEqual(new Set(['lane-child']))
    expect(restored.lanes.get(root.id)?.ownedEffectIds).toEqual(new Set(['effect-1']))
    expect(restored.events).toEqual(snapshot.state.events)
    expect(restored.nextIds).toEqual(state.nextIds)
  })

  it('rejects incompatible or malformed snapshot versions before creating state', () => {
    expect(() => importRuntimeState({ schemaVersion: 2 } as any)).toThrow('INVALID_SESSION_SNAPSHOT')
    expect(() => importRuntimeState({ schemaVersion: 1, state: { agents: [] } } as any)).toThrow('INVALID_SESSION_SNAPSHOT')
  })

  it('rejects invalid scheduler limits and cursors in a recovery snapshot', () => {
    const snapshot = exportRuntimeState(createRuntimeState())
    snapshot.state.maxRunning.llm = -1
    expect(() => importRuntimeState(snapshot)).toThrow('INVALID_SESSION_SNAPSHOT')

    const cursorSnapshot = exportRuntimeState(createRuntimeState())
    cursorSnapshot.state.nextIds.event = 0
    expect(() => importRuntimeState(cursorSnapshot)).toThrow('INVALID_SESSION_SNAPSHOT')

    const clockSnapshot = exportRuntimeState(createRuntimeState())
    clockSnapshot.state.now = Number.NaN
    expect(() => importRuntimeState(clockSnapshot)).toThrow('INVALID_SESSION_SNAPSHOT')
  })

  it('redacts non-public bodies at the log export boundary without changing recovery snapshots', () => {
    const state = createRuntimeState()
    state.results.set('public', { id: 'public', value: { ok: true }, privacy: 'public', derivedFrom: [] })
    state.results.set('cloud', { id: 'cloud', value: { token: 'cloud-secret' }, privacy: 'cloud_allowed', derivedFrom: [] })
    state.results.set('local', { id: 'local', value: { token: 'local-secret' }, privacy: 'local_only', derivedFrom: [] })
    state.artifacts.set('artifact-public', { ref: 'artifact-public', mediaType: 'text/plain', sizeBytes: 3, contentHash: 'hash-public', contentBase64: 'cHVi', privacy: 'public', storageState: 'memory', pinCount: 0 })
    state.artifacts.set('artifact-local', { ref: 'artifact-local', mediaType: 'text/plain', sizeBytes: 5, contentHash: 'hash-local', contentBase64: 'bG9jYWw=', privacy: 'local_only', storageState: 'memory', pinCount: 0 })
    state.events.push({ id: 'event-public', schemaVersion: 1, sessionId: 'session', seq: 1, timestamp: 0, type: 'lane.succeeded', payload: 'public', data: 'public' })
    state.events.push({ id: 'event-unknown', schemaVersion: 1, sessionId: 'session', seq: 2, timestamp: 0, type: 'human.requested', payload: { token: 'secret' }, data: { token: 'secret' } })

    const publicExport = exportRuntimeLog(state)
    expect(publicExport.results.find((result) => result.id === 'public')?.value).toEqual({ ok: true })
    expect(publicExport.results.find((result) => result.id === 'cloud')).toMatchObject({ redacted: true, privacy: 'cloud_allowed' })
    expect(publicExport.artifacts.find((artifact) => artifact.ref === 'artifact-local')).toMatchObject({ redacted: true, privacy: 'local_only' })
    expect(JSON.stringify(publicExport)).not.toContain('local-secret')
    expect(publicExport.events.find((event) => event.id === 'event-unknown')?.data).toMatchObject({ redacted: true })
    expect(exportRuntimeLog(state, { maxPrivacy: 'cloud_allowed' }).results.find((result) => result.id === 'cloud')?.value).toEqual({ token: 'cloud-secret' })
    expect(exportRuntimeLog(state, { maxPrivacy: 'local_only' }).artifacts.find((artifact) => artifact.ref === 'artifact-local')?.contentBase64).toBe('bG9jYWw=')
  })

  it('writes a privacy-filtered audit export as durable JSONL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-runtime-log-'))
    try {
      const state = createRuntimeState()
      state.results.set('secret', { id: 'secret', value: { token: 'do-not-write' }, privacy: 'local_only', derivedFrom: [] })
      const path = join(directory, 'audit', 'runtime.jsonl')
      const log = await exportRuntimeLogTo(state, new FileRuntimeLogSink(path))
      const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toEqual([log])
      expect(JSON.stringify(lines[0])).not.toContain('do-not-write')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('posts an audit export through the host-owned HTTP sink and fails non-2xx responses', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const state = createRuntimeState()
    const log = exportRuntimeLog(state)
    const sink = new HttpRuntimeLogSink({ endpoint: 'https://audit.test/events', headers: { authorization: 'Bearer test' }, fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(null, { status: 202 })
    } })
    await sink.append(log)
    expect(calls[0]?.url).toBe('https://audit.test/events')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer test', 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(log)
    await expect(new HttpRuntimeLogSink({ endpoint: 'https://audit.test/events', fetch: async () => new Response(null, { status: 503 }) }).append(log)).rejects.toThrow('RUNTIME_LOG_HTTP_503')
  })

  it('lets Runtime export through a configured audit sink with a host privacy ceiling', async () => {
    const published: unknown[] = []
    const runtime = new PulseRuntime({ auditLogPrivacy: 'cloud_allowed', auditLogSink: { append: (log) => { published.push(log) } } })
    runtime.state.results.set('cloud', { id: 'cloud', value: { ok: true }, privacy: 'cloud_allowed', derivedFrom: [] })
    runtime.state.results.set('local', { id: 'local', value: { token: 'do-not-export' }, privacy: 'local_only', derivedFrom: [] })
    const log = await runtime.exportAuditLog()
    expect(published).toEqual([log])
    expect(log.maxPrivacy).toBe('cloud_allowed')
    expect(log.results.find((result) => result.id === 'cloud')?.value).toEqual({ ok: true })
    expect(log.results.find((result) => result.id === 'local')).toMatchObject({ redacted: true })
  })
})
