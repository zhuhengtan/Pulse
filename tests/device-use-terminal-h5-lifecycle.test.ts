import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { VoiceService } from '../packages/server/src/voice/service.js'
import { HardwareIdentityRegistry } from '../packages/server/src/device-use/hardware-identity.js'
import { HardwareLoopbackBridge, hardwareTestCertificateFingerprint } from '../packages/server/src/device-use/hardware-bridge.js'
import { HardwareVirtualTerminal } from '../packages/server/src/device-use/hardware-virtual-terminal.js'
import { createVoiceTerminalReplyHostIO } from '../packages/server/src/device-use/voice-terminal-host-reply.js'
import { hardwareTestTlsAvailable, temporaryHardwareTestTls } from './helpers/hardware-test-tls.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks() } })
function wav() { const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40); return b.toString('base64') }
const poll = { timeout: 15000, interval: 10 }

describe.skipIf(!hardwareTestTlsAvailable)('real H5 admission and synthetic authenticated terminal lifecycle', () => {
  let pki: Awaited<ReturnType<typeof temporaryHardwareTestTls>>
  beforeAll(async () => { pki = await temporaryHardwareTestTls() })
  afterAll(async () => { await pki?.close() })
  async function fixture(options: { holdSpeech?: boolean; loseAdmission?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-terminal-h5-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const host = createLocalHost({ cwd: dir, dataDir: dir, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', mockResponse: 'Synthetic H5 final reply.', jarvis: { enabled: false } })
    cleanup.push(() => host.close())
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    cleanup.push(() => server.stop())
    let releaseSpeech!: () => void
    const speechGate = new Promise<void>(resolve => { releaseSpeech = resolve })
    vi.spyOn(VoiceService.prototype, 'transcribe').mockResolvedValue({ text: 'Synthetic terminal request.' })
    const speech = vi.spyOn(VoiceService.prototype, 'speech').mockImplementation(async () => { if (options.holdSpeech) await speechGate; return { mime: 'audio/wav', audio: wav() } })
    await host.init(); const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    // These are real HTTP calls, including local-session authorization. No fetch interception.
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    expect(session.ok).toBe(true)
    const cookie = session.headers.get('set-cookie'); if (!cookie) throw new Error('TEST_SESSION_COOKIE_MISSING')
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }
    let admittedId = ''
    const request = vi.fn(async (path: string, init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal }) => {
      const response = await fetch(`${base}${path}`, { ...init, headers })
      const result = await response.json()
      if (!response.ok) throw new Error(`HTTP_${response.status}: ${JSON.stringify(result)}`)
      if (path === '/api/assistant/messages') { admittedId = result.messageId; if (options.loseAdmission) throw new Error('TEST_ADMISSION_RESPONSE_LOST_AFTER_COMMIT') }
      return result
    })
    const voice = createVoiceTerminalReplyHostIO(request, () => {}, { enabled: true, pollIntervalMs: 5 })
    const identities = new HardwareIdentityRegistry({ hostId: 'h5-lifecycle-test', temporaryTestOnly: true })
    cleanup.push(async () => identities.clear())
    const bridge = new HardwareLoopbackBridge({ mode: 'ephemeral-loopback-test', identities, tls: pki.server, voice, enableReplies: true, replyTimeoutMs: 15000 })
    cleanup.push(() => bridge.close())
    const address = await bridge.start(); if (address.state !== 'listening') throw new Error('TEST_BRIDGE_NOT_LISTENING')
    const terminal = new HardwareVirtualTerminal({ mode: 'ephemeral-loopback-test', port: address.port, tls: pki.client, pinnedServerFingerprint: hardwareTestCertificateFingerprint(pki.server.cert), expectedHostId: 'h5-lifecycle-test' })
    cleanup.push(() => terminal.close())
    // Always release mock speech before closing HTTP resources, even after failed assertions.
    cleanup.push(async () => { releaseSpeech() })
    await terminal.connect()
    const pending = await terminal.pair(identities.createTicket().ticket, 'H5 synthetic terminal', ['voice.button'])
    const active = bridge.approvePairing(pending.requestId, { roomId: 'test-room', scopes: ['voice.button'] })
    await terminal.waitForIdentity(); const voiceSession = await terminal.openVoice({ replyProtocolVersion: 1 })
    await terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const view = async () => { const response = await fetch(`${base}/api/assistant`, { headers }); expect(response.ok).toBe(true); return response.json() }
    const completed = async () => { await expect.poll(async () => { const data = await view(); const receipt = data.receipts.find((r: { messageId: string }) => r.messageId === admittedId); if (receipt?.state === 'failed') throw new Error(JSON.stringify(receipt)); return receipt?.state }, poll).toBe('completed'); return view() }
    return { host, terminal, bridge, active, voiceSession, request, speech, releaseSpeech, completed, view, voice, admittedId: () => admittedId }
  }
  it('uses the real assistant queue and final view for correlated playback', async () => {
    const f = await fixture(), admission = await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    expect(admission.state).toBe('submitted')
    const view = await f.completed()
    expect(view.messages.find((m: { id: string }) => m.id === `msg-${admission.requestId}`)).toMatchObject({ role: 'user', inputMode: 'voice' })
    await expect.poll(() => f.terminal.outputs.some(p => p.type === 'playback'), poll).toBe(true)
    const final = f.terminal.outputs.find(p => p.type === 'final-reply')!, playback = f.terminal.outputs.find(p => p.type === 'playback')!
    expect(final).toMatchObject({ requestId: admission.requestId, text: 'Synthetic H5 final reply.', sessionId: f.voiceSession.sessionId })
    expect(playback).toMatchObject({ requestId: admission.requestId, replyId: final.replyId })
    await f.terminal.acknowledgePlayback(playback); await f.terminal.reportPlayback(playback, 'started'); await f.terminal.reportPlayback(playback, 'completed')
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('completed')
    expect(f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')).toHaveLength(1)
  }, 25000)
  it.each(['disconnect', 'revoke'] as const)('suppresses late real HTTP speech after %s without replaying admission', async action => {
    const f = await fixture({ holdSpeech: true })
    await f.terminal.captureSyntheticPcm(Buffer.alloc(3200)); await f.completed()
    await expect.poll(() => f.speech.mock.calls.length, poll).toBe(1)
    if (action === 'disconnect') { await f.terminal.close(); await expect.poll(() => f.bridge.snapshot().connections, poll).toBe(0) }
    else f.bridge.revoke(f.active.deviceId)
    f.releaseSpeech()
    await expect.poll(() => f.voice.diagnostics().active, poll).toBe(0)
    expect(f.terminal.outputs.some(p => p.type === 'playback')).toBe(false)
    expect(f.bridge.snapshot().replies[0]?.phase).toBe('superseded')
    expect(f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')).toHaveLength(1)
    const view = await f.view(); expect(view.receipts.filter((r: { messageId: string }) => r.messageId === f.admittedId())).toHaveLength(1)
  }, 25000)
  it('keeps a committed but lost admission response unknown without retry or playback', async () => {
    const f = await fixture({ loseAdmission: true })
    const result = await f.terminal.captureSyntheticPcm(Buffer.alloc(3200))
    expect(result.state).toBe('unknown'); await f.completed()
    await f.terminal.sendPacket({ type: 'heartbeat' }); await f.terminal.sendPacket({ type: 'heartbeat' })
    expect(f.request.mock.calls.filter(([path]) => path === '/api/assistant/messages')).toHaveLength(1)
    expect(f.speech).not.toHaveBeenCalled(); expect(f.terminal.outputs.some(p => p.type === 'playback' || p.type === 'final-reply')).toBe(false)
    const view = await f.view(); expect(view.receipts.filter((r: { messageId: string }) => r.messageId === f.admittedId())).toHaveLength(1)
  }, 25000)
})
