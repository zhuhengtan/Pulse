import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { DeviceUseIpcParent, DeviceUseIpcClient, createRemoteDeviceActivation, DEVICE_IPC_MAX_REQUEST_BYTES, type DeviceUseIpcMessage } from '../packages/server/src/device-use/worker-ipc.js'
import { createDeviceCapabilityPack } from '../packages/server/src/device-use/pack.js'
import type { DeviceBroker } from '../packages/server/src/device-use/broker.js'
const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const context = (signal = new AbortController().signal): ToolContext => ({ toolCallId: 'call-1', effectId: 'effect-1', attemptId: 'attempt-1', agentId: 'agent-1', laneId: 'lane-1', signal, emit: () => {} })
function fixture(execute: ConstructorParameters<typeof DeviceUseIpcParent>[0] = async () => ({ simulated: true }), timeout = 1000) {
  const errors: Error[] = [], replies: DeviceUseIpcMessage[] = [], sent: DeviceUseIpcMessage[] = []
  let client: DeviceUseIpcClient
  const parent = new DeviceUseIpcParent(execute, async message => { replies.push(message); queueMicrotask(() => client.receive(message)) }, e => errors.push(e), timeout)
  client = new DeviceUseIpcClient(parent.sessionId, async message => { sent.push(message); queueMicrotask(() => parent.receive(message)) }, timeout)
  parent.bindRun('run-1'); client.bindRun('run-1')
  return { parent, client, errors, replies, sent }
}
const request = (sessionId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, type: 'deviceUseRequest', sessionId, runId: 'run-1', requestId: randomUUID(), name: 'device.read', input: { deviceId: 'sim:light' }, context: { toolCallId: 'call-1', effectId: 'effect-1', attemptId: 'attempt-1', agentId: 'agent-1', laneId: 'lane-1' }, ...extra })
describe('Device Use private worker IPC', () => {
  it('uses a single parent execution with reconstructed context and no caller identity', async () => {
    const run = vi.fn(async (name, input, ctx: ToolContext) => { expect(ctx.signal).toBeInstanceOf(AbortSignal); expect(ctx).not.toHaveProperty('principal'); return { name, input } })
    const f = fixture(run)
    expect(await f.client.execute('device.read', { deviceId: 'sim:light' }, context())).toEqual({ name: 'device.read', input: { deviceId: 'sim:light' } }); expect(run).toHaveBeenCalledTimes(1)
    f.client.close(); f.parent.close()
  })
  it.each(['device.grant', 'device.enroll', 'shell', 'device.connect', 'device.setPrincipal'])('rejects unsupported tool %s at the parent boundary', async name => {
    const run = vi.fn(async () => ({})), f = fixture(run)
    f.parent.receive(request(f.parent.sessionId, { name })); await pause()
    expect(f.errors[0]?.message).toBe('DEVICE_IPC_PROTOCOL'); expect(run).not.toHaveBeenCalled(); f.parent.close(); f.client.close()
  })
  it('rejects extra principal, arbitrary service and malformed input fields', async () => {
    const run = vi.fn(async () => ({})), f = fixture(run)
    f.parent.receive(request(f.parent.sessionId, { principal: 'admin' })); expect(f.errors[0]?.message).toBe('DEVICE_IPC_PROTOCOL')
    f.parent.receive(request(f.parent.sessionId, { input: { deviceId: 'sim:light', url: 'https://evil.example' } })); await pause()
    expect(f.replies.at(-1)).toMatchObject({ ok: false, error: 'DEVICE_IPC_INPUT_INVALID' }); expect(run).not.toHaveBeenCalled(); f.parent.close(); f.client.close()
  })
  it('binds the parent to the exact session and Run', () => {
    const f = fixture()
    f.parent.receive(request(randomUUID())); f.parent.receive(request(f.parent.sessionId, { runId: 'different-run' }))
    expect(f.errors.map(e => e.message)).toEqual(['DEVICE_IPC_SCOPE', 'DEVICE_IPC_SCOPE']); f.parent.close(); f.client.close()
  })
  it('does not replay duplicate IPC request IDs', async () => {
    const run = vi.fn(async () => ({})), f = fixture(run), message = request(f.parent.sessionId)
    f.parent.receive(message); f.parent.receive(message); await pause()
    expect(run).toHaveBeenCalledTimes(1); expect(f.replies.some(r => 'error' in r && r.error === 'DEVICE_IPC_DUPLICATE')).toBe(true); f.parent.close(); f.client.close()
  })
  it('limits request payloads before executing', () => {
    const run = vi.fn(async () => ({})), f = fixture(run)
    f.parent.receive(request(f.parent.sessionId, { input: { text: 'a'.repeat(DEVICE_IPC_MAX_REQUEST_BYTES) } }))
    expect(f.errors[0]?.message).toBe('DEVICE_IPC_REQUEST_TOO_LARGE'); expect(run).not.toHaveBeenCalled(); f.parent.close(); f.client.close()
  })
  it('limits response payloads and sanitizes arbitrary execution errors', async () => {
    const f = fixture(async () => 'a'.repeat(300_000))
    await expect(f.client.execute('device.list', {}, context())).rejects.toThrow('DEVICE_IPC_RESULT_TOO_LARGE'); f.parent.close(); f.client.close()
    const g = fixture(async () => { throw new Error('account secret must never cross IPC') })
    await expect(g.client.execute('device.list', {}, context())).rejects.toThrow(/^DEVICE_IPC_EXECUTION_FAILED$/); g.parent.close(); g.client.close()
  })
  it('passes cancellation to parent execution and never automatically retries', async () => {
    let parentSignal: AbortSignal | undefined
    const run = vi.fn(async (_name, _input, ctx: ToolContext) => { parentSignal = ctx.signal; return new Promise(() => {}) }), f = fixture(run)
    const controller = new AbortController(), pending = f.client.execute('device.read', { deviceId: 'sim:light' }, context(controller.signal))
    await pause(); controller.abort()
    await expect(pending).rejects.toThrow('DEVICE_IPC_OUTCOME_UNKNOWN'); await pause()
    expect(parentSignal?.aborted).toBe(true); expect(run).toHaveBeenCalledTimes(1); expect(f.sent.map(m => m.type)).toEqual(['deviceUseRequest', 'deviceUseCancel']); f.parent.close(); f.client.close()
  })
  it('times out unknown outcomes without a resend, including ignored abort signals', async () => {
    const run = vi.fn(async () => new Promise(() => {})), f = fixture(run, 15)
    await expect(f.client.execute('device.read', { deviceId: 'sim:light' }, context())).rejects.toThrow('DEVICE_IPC_OUTCOME_UNKNOWN')
    expect(run).toHaveBeenCalledTimes(1); f.parent.close(); f.client.close()
  })
  it('disconnect aborts parent calls and rejects all pending worker calls', async () => {
    let signal: AbortSignal | undefined
    const f = fixture(async (_n, _i, ctx) => { signal = ctx.signal; return new Promise(() => {}) })
    const pending = f.client.execute('device.list', {}, context()); await pause(); f.parent.close(); f.client.close()
    await expect(pending).rejects.toThrow('DEVICE_IPC_OUTCOME_UNKNOWN'); expect(signal?.aborted).toBe(true)
  })
  it('rejects responses from another session rather than satisfying a pending call', async () => {
    const f = fixture(async () => new Promise(() => {})), pending = f.client.execute('device.list', {}, context())
    await pause(); const request = f.sent[0]!
    f.client.receive({ schemaVersion: 1, type: 'deviceUseResult', sessionId: randomUUID(), runId: 'run-1', requestId: request.requestId, ok: true, value: {} })
    await expect(pending).rejects.toThrow('DEVICE_IPC_SCOPE'); f.parent.close()
  })
  it('remote activation preserves finite names and the external approval classification', async () => {
    const activation = await createDeviceCapabilityPack({} as DeviceBroker, 'local-owner').activate({ workspaceRoot: '/tmp', config: {}, signal: new AbortController().signal })
    const executor = vi.fn(async () => ({ remote: true }))
    const remote = createRemoteDeviceActivation({ tools: activation.tools.map(t => t.manifest), instructions: activation.instructions ?? [] }, executor)
    expect(remote.tools).toHaveLength(7); expect(remote.tools.find(t => t.manifest.name === 'device.set')?.manifest.sideEffectPolicy).toBe('external')
    expect(await remote.tools[0]!.execute({}, context())).toEqual({ remote: true }); expect(executor).toHaveBeenCalledWith('device.list', {}, expect.anything())
    expect(() => createRemoteDeviceActivation({ tools: [{ ...activation.tools[0]!.manifest, name: 'shell' }], instructions: [] }, executor)).toThrow()
    expect(() => createRemoteDeviceActivation({ tools: [{ ...activation.tools[3]!.manifest, sideEffectPolicy: 'read' }], instructions: [] }, executor)).toThrow('DEVICE_IPC_TOOL_POLICY')
  })
})
