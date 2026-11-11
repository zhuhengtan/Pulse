import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { runHardwareLoopbackSample } from '../examples/hardware-loopback.js'
import { HardwareIdentityRegistry } from '../packages/server/src/device-use/hardware-identity.js'
import { HardwareLoopbackBridge, hardwareTestCertificateFingerprint } from '../packages/server/src/device-use/hardware-bridge.js'
import { HardwareVirtualTerminal } from '../packages/server/src/device-use/hardware-virtual-terminal.js'
import { hardwareTestTlsAvailable, temporaryHardwareTestTls } from './helpers/hardware-test-tls.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await pause(5) } throw new Error('HARDWARE_TEST_CONDITION_TIMEOUT') }
it('does not listen, pair or generate credentials by default', async () => {
  const bridge = new HardwareLoopbackBridge()
  expect(await bridge.start()).toEqual({ state: 'disabled' })
  expect(bridge.snapshot()).toMatchObject({ enabled: false, connections: 0, persistentCredentials: false, productionReady: false })
  await bridge.close(); await expect(bridge.start()).rejects.toThrow('HARDWARE_BRIDGE_CLOSED')
  expect(() => new HardwareLoopbackBridge({ mode: 'production' as any })).toThrow('HARDWARE_PRODUCTION_AUTHORIZATION_REQUIRED')
})
describe.skipIf(!hardwareTestTlsAvailable)('authenticated hardware loopback with explicit temporary test identities', () => {
  let pki: Awaited<ReturnType<typeof temporaryHardwareTestTls>>
  beforeAll(async () => { pki = await temporaryHardwareTestTls() })
  afterAll(async () => { await pki?.close() })
  async function fixture(options: { idleTimeoutMs?: number; transcribe?: () => Promise<string>; submit?: () => Promise<unknown> } = {}) {
    const identities = new HardwareIdentityRegistry({ hostId: 'loopback-test-host', temporaryTestOnly: true })
    cleanup.push(async () => { identities.clear() })
    const transcribe = vi.fn(options.transcribe ?? (async () => 'Synthetic request, no real hardware action'))
    const submit = vi.fn(options.submit ?? (async () => ({ accepted: true, simulated: true })))
    const bridge = new HardwareLoopbackBridge({ mode: 'ephemeral-loopback-test', identities, tls: pki.server, voice: { transcribe, submit }, ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}) })
    cleanup.push(() => bridge.close())
    const address = await bridge.start()
    if (address.state !== 'listening') throw new Error('test bridge did not listen')
    expect(address.host).toBe('127.0.0.1')
    const client = (overrides: Partial<ConstructorParameters<typeof HardwareVirtualTerminal>[0]> = {}) => {
      const terminal = new HardwareVirtualTerminal({ mode: 'ephemeral-loopback-test', port: address.port, tls: pki.client, pinnedServerFingerprint: hardwareTestCertificateFingerprint(pki.server.cert), expectedHostId: 'loopback-test-host', ...overrides })
      cleanup.push(() => terminal.close()); return terminal
    }
    const terminal = client()
    const pair = async (scopes: ('voice.button' | 'voice.wake' | 'telemetry.read')[] = ['voice.button']) => {
      await terminal.connect()
      const pending = await terminal.pair(identities.createTicket().ticket, 'Synthetic terminal', scopes)
      expect(pending.status).toBe('pending')
      const active = bridge.approvePairing(pending.requestId, { roomId: 'test-room', scopes })
      expect(await terminal.waitForIdentity()).toEqual(active)
      const session = await terminal.openVoice()
      return { active, session }
    }
    return { identities, bridge, terminal, client, pair, transcribe, submit, address }
  }
  it('requires local Host approval before opening a voice session, then submits through injected ordinary admission', async () => {
    const f = await fixture(); await f.terminal.connect()
    const ticket = f.identities.createTicket(), pending = await f.terminal.pair(ticket.ticket, 'Untrusted display name', ['voice.button'])
    expect(f.identities.getActiveByFingerprint(pending.publicKeyFingerprint)).toBeUndefined()
    await expect(f.terminal.waitForIdentity(20)).rejects.toThrow('HARDWARE_LOCAL_APPROVAL_REQUIRED')
    expect(f.submit).not.toHaveBeenCalled()
    const active = f.bridge.approvePairing(pending.requestId, { roomId: 'host-approved-room', scopes: ['voice.button'] })
    await f.terminal.waitForIdentity(); await f.terminal.openVoice()
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const result = await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    expect(result.state).toBe('submitted'); expect(f.transcribe).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.submit.mock.calls[0]?.[1]).toMatchObject({ deviceId: active.deviceId, roomId: 'host-approved-room' })
    expect(f.bridge.snapshot()).toMatchObject({ productionReady: false, persistentCredentials: false, terminals: [{ physicalMuteVerified: false }] })
  })
  it('rejects a wrong pinned server and a client outside the test CA', async () => {
    const f = await fixture()
    await expect(f.client({ pinnedServerFingerprint: '00:'.repeat(31) + '00' }).connect()).rejects.toThrow('HARDWARE_TLS_AUTHENTICATION_FAILED')
    await expect(f.client({ tls: pki.untrusted }).connect()).rejects.toThrow(/HARDWARE_(TLS_AUTHENTICATION_FAILED|CONNECTION_CLOSED)/)
    expect(f.bridge.snapshot().terminals).toHaveLength(0); expect(f.identities.list()).toEqual([])
  })

  it('requires a client certificate rather than merely trusting the server', async () => {
    const f = await fixture()
    const result = await new Promise<string>(resolve => {
      const socket = tlsConnect({ host: '127.0.0.1', port: f.address.port, servername: 'localhost', ca: pki.server.ca, minVersion: 'TLSv1.3', rejectUnauthorized: true })
      cleanup.push(async () => { socket.destroy() })
      socket.once('error', () => resolve('rejected')); socket.once('close', () => resolve('closed'))
      socket.once('data', () => resolve('unexpectedly-ready'))
    })
    expect(result).not.toBe('unexpectedly-ready')
    await until(() => f.bridge.snapshot().connections === 0)
    expect(f.identities.list()).toEqual([])
  })
  it('runs the developer sample with injected test PKI and synthetic admission only', async () => {
    const result = await runHardwareLoopbackSample({ server: pki.server, client: pki.client })
    expect(result).toMatchObject({ simulated: true, persistentAccessCreated: false, receipt: { state: 'submitted' } })
    expect(result.submitted).toHaveLength(1)
  })
  it('does not accept network approval, actuator, principal or Host management messages', async () => {
    const f = await fixture(); await f.terminal.connect()
    await f.terminal.sendRawTestFrame({ type: 'approve', requestId: randomUUID(), principal: 'local-owner', scopes: ['actuator.power'] })
    await until(() => f.bridge.snapshot().connections === 0)
    expect(f.identities.list()).toEqual([]); expect(f.submit).not.toHaveBeenCalled()
  })
  it('does not trust self-reported device or room fields in hello', async () => {
    const f = await fixture(); await f.pair(); await f.terminal.close()
    const terminal = f.client(); await terminal.connect()
    await terminal.sendRawTestFrame({ type: 'hello', requestId: randomUUID(), protocolVersions: [1], audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }, deviceId: 'admin-device', roomId: 'private-room' })
    await until(() => f.bridge.snapshot().connections === 0)
    expect(f.bridge.snapshot().terminals).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled()
  })

  it('isolates a Host approval return value from the stored connection grant', async () => {
    const f = await fixture(); await f.terminal.connect()
    const pending = await f.terminal.pair(f.identities.createTicket().ticket, 'Synthetic', ['voice.button'])
    const returned = f.bridge.approvePairing(pending.requestId, { roomId: 'approved-room', scopes: ['voice.button'] })
    returned.scopes.push('voice.wake'); returned.roomId = 'mutated-room'
    expect(await f.terminal.waitForIdentity()).toMatchObject({ roomId: 'approved-room', scopes: ['voice.button'] })
    await f.terminal.openVoice(); await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    await expect(f.terminal.captureSyntheticPcm(Buffer.alloc(320), 'wake')).rejects.toThrow('VOICE_TERMINAL_CAPTURE_FORBIDDEN')
    expect(f.identities.getActiveByFingerprint(pending.publicKeyFingerprint)).toMatchObject({ roomId: 'approved-room', scopes: ['voice.button'] })
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('starts muted and enforces a button-only grant rather than treating pairing as all actions', async () => {
    const f = await fixture(); await f.pair()
    await expect(f.terminal.captureSyntheticPcm(Buffer.alloc(320))).rejects.toThrow('VOICE_TERMINAL_CAPTURE_FORBIDDEN')
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    await expect(f.terminal.captureSyntheticPcm(Buffer.alloc(320), 'wake')).rejects.toThrow('VOICE_TERMINAL_CAPTURE_FORBIDDEN')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('prevents a second connection from taking over an already-open device session', async () => {
    const f = await fixture(); await f.pair()
    const second = f.client(); await second.connect()
    await expect(second.openVoice()).rejects.toThrow('HARDWARE_DEVICE_ALREADY_CONNECTED')
    expect((await f.terminal.sendPacket({ type: 'heartbeat' })).state).toBe('accepted')
    expect(f.bridge.snapshot().terminals).toHaveLength(1)
  })
  it('uses a fresh voice session on reconnect and rejects a previous session packet', async () => {
    const f = await fixture(), paired = await f.pair(); await f.terminal.close()
    await until(() => f.bridge.snapshot().terminals.length === 0)
    const second = f.client(); await second.connect(); const next = await second.openVoice()
    expect(next.sessionId).not.toBe(paired.session.sessionId)
    await expect((second as any).request('packet', { packet: { protocolVersion: 1, deviceId: next.deviceId, roomId: next.roomId, sessionId: paired.session.sessionId, sequence: 0, payload: { type: 'heartbeat' } } })).rejects.toThrow('VOICE_TERMINAL_SESSION_INVALID')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('processes fresh mute while ASR is pending and discards the old transcript before submission', async () => {
    const started = Promise.withResolvers<void>(), transcript = Promise.withResolvers<string>()
    const f = await fixture({ transcribe: async () => { started.resolve(); return transcript.promise } }); await f.pair()
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const capture = f.terminal.captureSyntheticPcm(Buffer.alloc(320)); await started.promise
    expect((await f.terminal.sendPacket({ type: 'status', muted: true, light: 'muted' })).state).toBe('accepted')
    transcript.resolve('This late text must not submit')
    expect((await capture).state).toBe('discarded'); expect(f.submit).not.toHaveBeenCalled()
  })
  it('revokes a connected identity and prevents late ASR or the same certificate from resuming access', async () => {
    const started = Promise.withResolvers<void>(), transcript = Promise.withResolvers<string>()
    const f = await fixture({ transcribe: async () => { started.resolve(); return transcript.promise } }), paired = await f.pair()
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const outcome = f.terminal.captureSyntheticPcm(Buffer.alloc(320)).then(value => ({ value }), error => ({ error }))
    await started.promise; expect(f.bridge.revoke(paired.active.deviceId)).toBe(true); transcript.resolve('Late revoked transcript')
    expect(await outcome).toHaveProperty('error'); await pause(10)
    expect(f.submit).not.toHaveBeenCalled()
    const second = f.client(); await second.connect(); await expect(second.waitForIdentity(20)).rejects.toThrow('HARDWARE_LOCAL_APPROVAL_REQUIRED')
    expect(f.bridge.snapshot().terminals).toHaveLength(0)
  })

  it('rechecks direct identity revocation when ASR completes before the transport sweep', async () => {
    const started = Promise.withResolvers<void>(), transcript = Promise.withResolvers<string>()
    const f = await fixture({ transcribe: async () => { started.resolve(); return transcript.promise } }), paired = await f.pair()
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const outcome = f.terminal.captureSyntheticPcm(Buffer.alloc(320)).then(value => ({ value }), error => ({ error }))
    await started.promise; expect(f.identities.revoke(paired.active.deviceId)).toBe(true); transcript.resolve('Must not reach admission')
    await outcome
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('consumes a pairing ticket once and binds possession proof to its TLS connection', async () => {
    const f = await fixture(); await f.terminal.connect()
    const ticket = f.identities.createTicket().ticket
    const challenge = await (f.terminal as any).request('pairing-begin', { ticket, name: 'Synthetic', requestedScopes: ['voice.button'] })
    const second = f.client(); await second.connect()
    await expect((second as any).request('pairing-begin', { ticket, name: 'Replay', requestedScopes: ['voice.button'] })).rejects.toThrow('HARDWARE_REQUEST_REJECTED')
    await expect((second as any).request('pairing-proof', { challengeId: challenge.challenge.challengeId, signature: 'a'.repeat(86) })).rejects.toThrow('HARDWARE_PAIRING_STATE_INVALID')
    expect(f.identities.list()).toEqual([]); expect(f.submit).not.toHaveBeenCalled()
  })
  it('returns unknown for an ambiguous admission failure and never retries', async () => {
    const f = await fixture({ submit: async () => { throw new Error('fake provider failure') } }); await f.pair()
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const result = await f.terminal.captureSyntheticPcm(Buffer.alloc(320))
    expect(result.state).toBe('unknown'); expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('closes oversized frames and idle sessions instead of silently buffering indefinitely', async () => {
    const f = await fixture({ idleTimeoutMs: 60 }); await f.terminal.connect()
    await f.terminal.sendRawTestFrame({ type: 'hello', requestId: randomUUID(), extra: 'x'.repeat(70_000) })
    await until(() => f.bridge.snapshot().connections === 0)
    const second = f.client(); await second.connect(); await pause(100)
    expect(f.bridge.snapshot().connections).toBe(0)
  })
  it('reports playback as sent, separately acknowledges it and never claims acoustic proof', async () => {
    const f = await fixture(), paired = await f.pair()
    await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const playbackId = randomUUID()
    expect(f.bridge.play(paired.active.deviceId, { playbackId, audioSequence: 0, audio: Buffer.from('synthetic WAV fixture').toString('base64'), final: true })).toEqual({ state: 'sent' })
    await until(() => f.terminal.outputs.some(output => output.type === 'playback'))
    expect(f.bridge.snapshot().terminals[0]?.playbackPending).toBe(1)
    await f.terminal.sendPacket({ type: 'playback-ack', playbackId, audioSequence: 0 })
    expect(f.bridge.snapshot().terminals[0]).toMatchObject({ playbackPending: 0, physicalMuteVerified: false })
  })
  it('forwards cooperative ASR cancellation across the authenticated bridge without submitting late work', async () => {
    let finish!: (text: string) => void
    const f = await fixture({ transcribe: () => new Promise(resolve => { finish = resolve }) })
    await f.pair(); await f.terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const capture = f.terminal.captureSyntheticPcm(Buffer.alloc(320)).then(value => ({ value }), error => ({ error }))
    await until(() => f.transcribe.mock.calls.length === 1)
    const signal = (f.transcribe.mock.calls[0] as unknown as [string, unknown, AbortSignal])[2]
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(false)
    await f.terminal.close(); await until(() => signal.aborted)
    await capture; finish('late synthetic instruction'); await pause(0)
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('cleans up owned sockets and refuses restart after close', async () => {
    const f = await fixture(); await f.pair(); await f.bridge.close()
    expect(f.bridge.snapshot()).toMatchObject({ enabled: false, connections: 0, terminals: [] })
    await expect(f.bridge.start()).rejects.toThrow('HARDWARE_BRIDGE_CLOSED')
  })
})
