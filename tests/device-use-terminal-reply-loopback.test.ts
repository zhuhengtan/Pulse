import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HardwareIdentityRegistry } from '../packages/server/src/device-use/hardware-identity.js'
import { HardwareLoopbackBridge, hardwareTestCertificateFingerprint } from '../packages/server/src/device-use/hardware-bridge.js'
import { HardwareVirtualTerminal } from '../packages/server/src/device-use/hardware-virtual-terminal.js'
import { createVoiceTerminalReplyHostIO } from '../packages/server/src/device-use/voice-terminal-host-reply.js'
import { hardwareTestTlsAvailable, temporaryHardwareTestTls } from './helpers/hardware-test-tls.js'

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await pause() } throw new Error('TEST_CONDITION_TIMEOUT') }
const close: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose() })
function wav() { const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40); return b.toString('base64') }

describe.skipIf(!hardwareTestTlsAvailable)('correlated synthetic terminal final reply over authenticated loopback', () => {
  let pki: Awaited<ReturnType<typeof temporaryHardwareTestTls>>
  beforeAll(async () => { pki = await temporaryHardwareTestTls() })
  afterAll(async () => { await pki?.close() })
  async function fixture(options: { enableReplies?: boolean; negotiate?: boolean; replyTimeoutMs?: number; beforeSpeech?: () => Promise<void>; wrongRun?: boolean } = {}) {
    const identities = new HardwareIdentityRegistry({ hostId: 'reply-loopback-host', temporaryTestOnly: true })
    close.push(async () => identities.clear())
    let requestId = ''
    const request = vi.fn(async (path: string, init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal }) => {
      if (path === '/api/voice/transcribe') return { text: 'Synthetic request only' }
      if (path === '/api/assistant/messages') { requestId = JSON.parse(init.body!).requestId; return { messageId: requestId, runId: 'mock-run', state: 'queued' } }
      if (path === '/api/assistant') return { receipts: [{ messageId: requestId, runId: options.wrongRun ? 'foreign-run' : 'mock-run', state: 'completed' }], messages: [
        { id: 'pre-reply', role: 'assistant', text: 'Do not speak this', messageKind: 'pre_reply', replyToId: `msg-${requestId}`, runId: 'mock-run' },
        { id: 'final-message', role: 'assistant', text: 'Synthetic final answer.', replyToId: `msg-${requestId}`, runId: 'mock-run' },
      ] }
      if (path === '/api/voice/speech') { await options.beforeSpeech?.(); return { audio: wav(), mime: 'audio/wav' } }
      throw new Error('UNEXPECTED_HOST_ROUTE')
    })
    const voice = createVoiceTerminalReplyHostIO(request, () => {}, { enabled: true, pollIntervalMs: 1 })
    const bridge = new HardwareLoopbackBridge({ mode: 'ephemeral-loopback-test', identities, tls: pki.server, voice, enableReplies: options.enableReplies ?? true, replyTimeoutMs: options.replyTimeoutMs ?? 1000 })
    close.push(() => bridge.close())
    const address = await bridge.start(); if (address.state !== 'listening') throw new Error('not listening')
    const terminal = new HardwareVirtualTerminal({ mode: 'ephemeral-loopback-test', port: address.port, tls: pki.client, pinnedServerFingerprint: hardwareTestCertificateFingerprint(pki.server.cert), expectedHostId: 'reply-loopback-host' })
    close.push(() => terminal.close())
    await terminal.connect()
    const pending = await terminal.pair(identities.createTicket().ticket, 'Synthetic reply terminal', ['voice.button'])
    const active = bridge.approvePairing(pending.requestId, { roomId: 'reply-room', scopes: ['voice.button'] })
    await terminal.waitForIdentity(); const session = await terminal.openVoice(options.negotiate === false ? {} : { replyProtocolVersion: 1 })
    await terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    return { bridge, terminal, active, session, request, voice }
  }
  it('routes the exact final/TTS to its original session and distinguishes receipt/start/completion', async () => {
    const f = await fixture()
    const admission = await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    expect(admission.state).toBe('submitted')
    await until(() => f.terminal.outputs.some(p => p.type === 'playback'))
    const final = f.terminal.outputs.find(p => p.type === 'final-reply')!, playback = f.terminal.outputs.find(p => p.type === 'playback')!
    expect(final).toMatchObject({ requestId: admission.requestId, text: 'Synthetic final answer.', sessionId: f.session.sessionId, deviceId: f.active.deviceId, roomId: 'reply-room' })
    expect(playback).toMatchObject({ requestId: admission.requestId, replyId: final.replyId, sessionId: f.session.sessionId, mime: 'audio/wav', audioSequence: 0, final: true })
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('sent')
    await expect(f.terminal.reportPlayback(playback, 'completed')).rejects.toThrow('VOICE_TERMINAL_CHUNKS_PENDING')
    await f.terminal.acknowledgePlayback(playback)
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('received')
    await f.terminal.reportPlayback(playback, 'started')
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('started')
    await f.terminal.reportPlayback(playback, 'completed')
    expect(f.bridge.snapshot().replies[0]).toMatchObject({ phase: 'completed', evidence: 'terminal-reported' })
    const submits = f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')
    expect(submits).toHaveLength(1)
  })
  it.each([{ enableReplies: false }, { negotiate: false }])('keeps automatic replies off unless both sides opt in: %j', async options => {
    const f = await fixture(options)
    expect((await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))).state).toBe('submitted')
    await pause(25)
    expect(f.request.mock.calls.some(([path]) => path === '/api/assistant' || path === '/api/voice/speech')).toBe(false)
    expect(f.bridge.snapshot().replies).toEqual([])
  })
  it('rejects a changed run and never synthesizes another request final', async () => {
    const f = await fixture({ wrongRun: true })
    await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    await until(() => f.bridge.snapshot().replies[0]?.phase === 'failed')
    expect(f.terminal.outputs.some(p => p.type === 'playback' || p.type === 'final-reply')).toBe(false)
    expect(f.request.mock.calls.some(([path]) => path === '/api/voice/speech')).toBe(false)
  })
  it('does not deliver late TTS after mute and preserves the admitted request without resubmitting', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ beforeSpeech: () => pending })
    await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    await until(() => f.request.mock.calls.some(([path]) => path === '/api/voice/speech'))
    await f.terminal.sendPacket({ type: 'status', muted: true, light: 'muted' })
    release(); await until(() => f.voice.diagnostics().active === 0); await pause()
    expect(f.terminal.outputs.some(p => p.type === 'playback')).toBe(false)
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('superseded')
    expect(f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')).toHaveLength(1)
  })
  it.each(['new-turn', 'disconnect', 'revoke'] as const)('isolates late TTS after %s without reusing the former generation', async action => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ beforeSpeech: () => pending })
    await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    await until(() => f.request.mock.calls.some(([path]) => path === '/api/voice/speech'))
    if (action === 'new-turn') await f.terminal.sendPacket({ type: 'capture-start', captureId: 'new-generation', trigger: 'button' })
    else if (action === 'disconnect') { await f.terminal.close(); await until(() => f.bridge.snapshot().connections === 0) }
    else f.bridge.revoke(f.active.deviceId)
    release(); await until(() => f.voice.diagnostics().active === 0); await pause()
    expect(f.terminal.outputs.some(p => p.type === 'playback')).toBe(false)
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('superseded')
    expect(f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')).toHaveLength(1)
  })
  it('rejects a forged reply association and keeps its genuine receipt pending', async () => {
    const f = await fixture(); await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    await until(() => f.terminal.outputs.some(p => p.type === 'playback'))
    const playback = f.terminal.outputs.find(p => p.type === 'playback')!
    await f.terminal.acknowledgePlayback(playback)
    await expect(f.terminal.reportPlayback({ ...playback, replyId: 'foreign-reply' }, 'started')).rejects.toThrow('VOICE_TERMINAL_CORRELATION')
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('received')
    await f.terminal.reportPlayback(playback, 'started'); await f.terminal.reportPlayback(playback, 'completed')
  })
  it('records missing playback receipt as unknown without replaying', async () => {
    const f = await fixture({ replyTimeoutMs: 80 })
    await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    await until(() => f.terminal.outputs.some(p => p.type === 'playback'))
    await until(() => f.bridge.snapshot().replies[0]?.phase === 'unknown')
    await f.terminal.sendPacket({ type: 'heartbeat' }); await pause(20)
    expect(f.terminal.outputs.filter(p => p.type === 'playback')).toHaveLength(1)
    expect(f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')).toHaveLength(1)
  })
  it('keeps a decoder error separate from completion', async () => {
    const f = await fixture(); await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    await until(() => f.terminal.outputs.some(p => p.type === 'playback'))
    const playback = f.terminal.outputs.find(p => p.type === 'playback')!
    await f.terminal.reportPlayback(playback, 'error', 'DECODER_ERROR')
    expect(f.bridge.snapshot().replies[0]).toMatchObject({ phase: 'error', errorCode: 'DECODER_ERROR' })
    await expect(f.terminal.reportPlayback(playback, 'completed')).rejects.toThrow()
  })
})
