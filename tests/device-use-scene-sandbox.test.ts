import { access } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { SceneSandbox } from '../packages/server/src/device-use/scene-sandbox.js'
const cleanupFault = vi.hoisted(() => ({ rejectNext: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => { if (cleanupFault.rejectNext) { cleanupFault.rejectNext = false; throw new Error('SIMULATED_CLEANUP_REFUSAL') } return actual.rm(...args) } }
})
const binding = 'trusted-test-admin'
async function fixture() { const sandbox = new SceneSandbox(); await sandbox.act({ action: 'enable' }, binding); return sandbox }
async function preview(sandbox: SceneSandbox) { const snapshot = await sandbox.act({ action: 'preview' }, binding); return snapshot.preview! }
const execute = (sandbox: SceneSandbox, p: { previewId: string; version: number }, fault = 'none', b = binding) => sandbox.act({ action: 'execute', previewId: p.previewId, version: p.version, fault }, b)
it('defaults disabled without a ledger and rejects arbitrary devices, endpoints and authorization', async () => {
  const sandbox = new SceneSandbox()
  try {
    expect(sandbox.snapshot()).toMatchObject({ enabled: false, realDevices: false, simulated: true, automaticRollback: false, automaticRetry: false, cleanup: { state: 'idle' } })
    expect((sandbox as any).directory).toBeUndefined()
    await expect(sandbox.act({ action: 'preview' }, binding)).rejects.toThrow('DISABLED')
    for (const input of [{ action: 'enable', url: 'https://example.com' }, { action: 'configure', name: 'real', steps: [{ deviceId: 'ha:lamp', desiredState: { power: true } }] }, { action: 'configure', name: 'invalid', steps: [{ deviceId: 'scene:lamp-a', desiredState: { targetTemperatureC: 28 } }] }, { action: 'execute', principal: 'owner' }]) await expect(sandbox.act(input, binding)).rejects.toThrow('INVALID')
  } finally { await sandbox.close() }
})
it('previews without executing, then reports ordered results from the real Broker', async () => {
  const sandbox = await fixture()
  try {
    const p = await preview(sandbox), adapter = (sandbox as any).adapter
    expect(adapter.calls).toHaveLength(0); expect(p.steps.map(step => step.index)).toEqual([0, 1])
    expect(p.steps[0]).toMatchObject({ deviceId: 'scene:lamp-a', from: { power: false, brightness: 0 }, to: { power: true, brightness: 30 } })
    const result = await execute(sandbox, p)
    expect(result.run).toMatchObject({ version: p.version, status: 'completed', atomic: false, outcome: 'all-observed', steps: [{ index: 0, deviceId: 'scene:lamp-a', status: 'observed' }, { index: 1, deviceId: 'scene:lamp-b', status: 'observed' }] })
    expect(adapter.calls).toHaveLength(2)
    const replay = await execute(sandbox, p)
    expect(replay.run).toEqual(result.run); expect(adapter.calls).toHaveLength(2)
    await expect(execute(sandbox, p, 'reject-second')).rejects.toThrow('REQUEST_CONFLICT'); expect(adapter.calls).toHaveLength(2)
  } finally { await sandbox.close() }
})
it('binds a preview to exact configuration version and local admin session', async () => {
  const sandbox = await fixture()
  try {
    const p = await preview(sandbox)
    await expect(execute(sandbox, p, 'none', 'another-admin')).rejects.toThrow('PREVIEW_CHANGED')
    await sandbox.act({ action: 'configure', name: 'New config', steps: [{ deviceId: 'scene:lamp-a', desiredState: { brightness: 40 } }] }, binding)
    await expect(execute(sandbox, p)).rejects.toThrow('PREVIEW_CHANGED')
    expect((sandbox as any).adapter.calls).toHaveLength(0)
    const next = await preview(sandbox)
    await expect(execute(sandbox, next, 'reject-second')).rejects.toThrow('INVALID')
    expect((await execute(sandbox, next)).run?.steps).toHaveLength(1)
  } finally { await sandbox.close() }
})
it('rejects expired previews before execution, but exact committed retries still return the receipt', async () => {
  const sandbox = await fixture()
  try {
    const p = await preview(sandbox)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(p.expiresAt + 1)
    await expect(execute(sandbox, p)).rejects.toThrow('PREVIEW_EXPIRED'); clock.mockRestore()
    const result = await execute(sandbox, p)
    const late = vi.spyOn(Date, 'now').mockReturnValue(p.expiresAt + 1)
    expect((await execute(sandbox, p)).run).toEqual(result.run); late.mockRestore()
    expect((sandbox as any).adapter.calls).toHaveLength(2)
  } finally { vi.restoreAllMocks(); await sandbox.close() }
})
it('retains successful siblings after explicit rejection without rollback or hidden compensation', async () => {
  const sandbox = await fixture()
  try {
    const result = await execute(sandbox, await preview(sandbox), 'reject-second')
    expect(result.run).toMatchObject({ status: 'completed', outcome: 'partial', steps: [{ status: 'observed' }, { status: 'failed' }] })
    expect(result.devices).toMatchObject([{ deviceId: 'scene:lamp-a', state: { power: true, brightness: 30 } }, { deviceId: 'scene:lamp-b', state: { power: false, brightness: 0 } }])
    expect((sandbox as any).adapter.calls).toHaveLength(2)
    expect((await (sandbox as any).registry.store.transaction((l: any) => l.commands, false))).toHaveLength(2)
  } finally { await sandbox.close() }
})
it('leaves ambiguous steps unknown, blocks new scene work and never replays them', async () => {
  const sandbox = await fixture()
  try {
    const p = await preview(sandbox), result = await execute(sandbox, p, 'disconnect-second'), adapter = (sandbox as any).adapter
    expect(result.run).toMatchObject({ outcome: 'uncertain', steps: [{ status: 'observed' }, { status: 'unknown' }] })
    expect((await execute(sandbox, p, 'disconnect-second')).run).toEqual(result.run); expect(adapter.calls).toHaveLength(2)
    await expect(sandbox.act({ action: 'preview' }, binding)).rejects.toThrow('UNRESOLVED')
    await expect(sandbox.act({ action: 'configure', name: 'Do not evade', steps: result.scene.steps }, binding)).rejects.toThrow('UNRESOLVED')
    expect(sandbox.snapshot().run?.steps[1]?.status).toBe('unknown'); expect(adapter.calls).toHaveLength(2)
    const directory = (sandbox as any).directory
    const disabled = await sandbox.act({ action: 'disable' }, binding)
    expect(disabled).toMatchObject({ enabled: false, cleanup: { state: 'completed' }, run: { outcome: 'uncertain' } }); await expect(access(directory)).rejects.toThrow()
    const reset = await sandbox.act({ action: 'enable' }, binding)
    expect(reset.run).toBeUndefined(); expect(reset.preview).toBeUndefined(); expect(reset.devices.every(d => d.state.power === false)).toBe(true)
    await expect(execute(sandbox, p, 'disconnect-second')).rejects.toThrow('PREVIEW_CHANGED')
  } finally { await sandbox.close() }
})
it('rejects duplicate devices and contradictory targets, and returns cloned snapshots', async () => {
  const sandbox = await fixture()
  try {
    for (const steps of [[{ deviceId: 'scene:lamp-a', desiredState: { power: false, brightness: 10 } }], [{ deviceId: 'scene:lamp-a', desiredState: { power: true, brightness: 0 } }], [{ deviceId: 'scene:lamp-a', desiredState: {} }], [{ deviceId: 'scene:lamp-a', desiredState: { brightness: 101 } }], [{ deviceId: 'scene:lamp-a', desiredState: { power: true } }, { deviceId: 'scene:lamp-a', desiredState: { power: false } }]]) await expect(sandbox.act({ action: 'configure', name: 'invalid', steps }, binding)).rejects.toThrow('INVALID')
    const snapshot = sandbox.snapshot(); snapshot.scene.steps[0]!.desiredState.brightness = 99; snapshot.devices[0]!.state.power = true
    expect(sandbox.snapshot().scene.steps[0]!.desiredState.brightness).toBe(30); expect(sandbox.snapshot().devices[0]!.state.power).toBe(false)
  } finally { await sandbox.close() }
})
it('targets faults at the second configured step and never queues overlapping mutations', async () => {
  const sandbox = await fixture()
  try {
    await sandbox.act({ action: 'configure', name: 'reverse', steps: [{ deviceId: 'scene:lamp-b', desiredState: { brightness: 50 } }, { deviceId: 'scene:lamp-a', desiredState: { power: true } }] }, binding)
    const p = await preview(sandbox), executing = execute(sandbox, p, 'reject-second')
    await expect(sandbox.act({ action: 'configure', name: 'race', steps: sandbox.snapshot().scene.steps }, binding)).rejects.toThrow('BUSY')
    const result = await executing
    expect(result.run?.steps).toMatchObject([{ deviceId: 'scene:lamp-b', status: 'observed' }, { deviceId: 'scene:lamp-a', status: 'failed' }])
    expect((sandbox as any).adapter.calls).toHaveLength(2)
  } finally { await sandbox.close() }
})

it('supports finite fractional brightness consistently with the virtual lamp capability', async () => {
  const sandbox = await fixture()
  try {
    await sandbox.act({ action: 'configure', name: 'fraction', steps: [{ deviceId: 'scene:lamp-a', desiredState: { power: true, brightness: 25.5 } }] }, binding)
    const p = await preview(sandbox)
    expect(p.steps[0]?.to.brightness).toBe(25.5)
    const result = await execute(sandbox, p)
    expect(result.run?.steps[0]?.status).toBe('observed'); expect(result.devices[0]?.state.brightness).toBe(25.5)
  } finally { await sandbox.close() }
})

it('retains an unconfirmed owned cleanup and permits only explicit cleanup recovery', async () => {
  const sandbox = await fixture()
  try {
    const directory = (sandbox as any).directory
    cleanupFault.rejectNext = true
    await expect(sandbox.act({ action: 'disable' }, binding)).rejects.toThrow('CLEANUP_UNCONFIRMED')
    expect(sandbox.snapshot()).toMatchObject({ enabled: false, cleanup: { state: 'unconfirmed' } })
    await expect(access(directory)).resolves.toBeUndefined()
    await expect(sandbox.act({ action: 'enable' }, binding)).rejects.toThrow('CLEANUP_UNCONFIRMED')
    await expect(sandbox.act({ action: 'preview' }, binding)).rejects.toThrow('DISABLED')
    const recovered = await sandbox.act({ action: 'disable' }, binding)
    expect(recovered).toMatchObject({ enabled: false, cleanup: { state: 'completed' } }); await expect(access(directory)).rejects.toThrow()
    expect((sandbox as any).directory).toBeUndefined()
  } finally { cleanupFault.rejectNext = false; await sandbox.close() }
})
it('retains the index and sibling receipt when another step fails before acceptance', async () => {
  const sandbox = await fixture()
  try {
    // Force the real Broker's existing fail-closed audit ceiling in this isolated fixture.
    ;(sandbox as any).broker.options.maxCommands = 1
    const result = await execute(sandbox, await preview(sandbox))
    expect(result.run).toMatchObject({ outcome: 'partial', steps: [{ index: 0, status: 'observed' }, { index: 1, status: 'not-accepted', reason: 'DEVICE_COMMAND_AUDIT_CAPACITY' }] })
    expect(result.run?.steps[0]?.commandId).toBeTruthy(); expect(result.run?.steps[1]?.commandId).toBeUndefined()
    expect((sandbox as any).adapter.calls).toHaveLength(1)
  } finally { await sandbox.close() }
})
