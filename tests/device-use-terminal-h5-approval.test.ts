import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { VoiceService } from '../packages/server/src/voice/service.js'
import { HardwareIdentityRegistry } from '../packages/server/src/device-use/hardware-identity.js'
import { HardwareLoopbackBridge, hardwareTestCertificateFingerprint } from '../packages/server/src/device-use/hardware-bridge.js'
import { HardwareVirtualTerminal } from '../packages/server/src/device-use/hardware-virtual-terminal.js'
import { createVoiceTerminalReplyHostIO } from '../packages/server/src/device-use/voice-terminal-host-reply.js'
import { hardwareTestTlsAvailable, temporaryHardwareTestTls } from './helpers/hardware-test-tls.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function wav() { const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40); return b.toString('base64') }

describe.skipIf(!hardwareTestTlsAvailable || process.platform === 'win32')('real H5 admission and approval through a synthetic authenticated terminal', () => {
  let pki: Awaited<ReturnType<typeof temporaryHardwareTestTls>>
  beforeAll(async () => { pki = await temporaryHardwareTestTls() })
  afterAll(async () => { await pki?.close() })
  it.each(['approved', 'denied', 'revoked-before-approval'] as const)('preserves Device Use approval and exact final delivery: %s', async scenario => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-terminal-h5-approval-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const profile = { provider: 'openai-compatible' as const, defaultModel: 'fixture', baseURL: 'http://127.0.0.1:12345/v1' }
    const host = createLocalHost({ cwd: directory, dataDir: directory, provider: profile, providerProfiles: { fixture: profile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', approvalMode: 'ask', jarvis: { enabled: false } }); cleanup.push(() => host.close())
    await host.deviceUse.configure({ enabled: true, mode: 'simulator' }); await host.deviceUse.discover(); await host.deviceUse.enroll({ deviceId: 'sim:light', roomId: 'test-room' })
    const grant = (await host.deviceUse.grant({ deviceId: 'sim:light', actions: ['power', 'brightness'], expiresInMinutes: 10, brightnessMax: 40 })).grants[0]!
    const originalFetch = globalThis.fetch.bind(globalThis)
    let modelCalls = 0, base = ''
    vi.stubGlobal('fetch', vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const address = String(url)
      if (address.startsWith(profile.baseURL + '/')) {
        const tool = modelCalls++ === 0
        const message = tool ? { content: '', tool_calls: [{ id: 'terminal-device-action', function: { name: 'device_set', arguments: JSON.stringify({ deviceId: 'sim:light', requestId: `terminal-h5-${scenario}`, desiredState: { power: true, brightness: 30 }, deadline: Date.now() + 30_000, authorizationRef: grant.authorizationRef }) } }] } : { content: `Synthetic final for ${scenario}.` }
        return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
      }
      if (!base || !address.startsWith(base + '/')) throw new Error('UNEXPECTED_NETWORK_DESTINATION')
      return originalFetch(url, init)
    }))
    vi.spyOn(VoiceService.prototype, 'transcribe').mockResolvedValue({ text: 'Set the simulated lamp to 30%, with ordinary approval.' })
    const speech = vi.spyOn(VoiceService.prototype, 'speech').mockResolvedValue({ audio: wav(), mime: 'audio/wav' })
    const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: directory }); cleanup.push(() => server.stop())
    base = `http://127.0.0.1:${(await server.start()).port}`
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    expect(session.status).toBe(200)
    const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const admissions: any[] = [], receiptStates: string[] = []
    const request = async (path: string, init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal }) => {
      expect(['/api/voice/transcribe', '/api/voice/speech', '/api/assistant/messages', '/api/assistant']).toContain(path)
      const response = await fetch(base + path, { ...init, headers }); const result = await response.json()
      if (!response.ok) throw new Error(`HOST_HTTP_${response.status}:${JSON.stringify(result)}`)
      if (path === '/api/assistant/messages') admissions.push(result)
      if (path === '/api/assistant') for (const item of (result as any).receipts ?? []) receiptStates.push(item.state)
      return result
    }
    const voice = createVoiceTerminalReplyHostIO(request, () => {}, { enabled: true, pollIntervalMs: 10 })
    const identities = new HardwareIdentityRegistry({ hostId: 'h5-approval-test', temporaryTestOnly: true }); cleanup.push(async () => identities.clear())
    const bridge = new HardwareLoopbackBridge({ mode: 'ephemeral-loopback-test', identities, tls: pki.server, voice, enableReplies: true, replyTimeoutMs: 10_000 }); cleanup.push(() => bridge.close())
    const address = await bridge.start(); if (address.state !== 'listening') throw new Error('not listening')
    const terminal = new HardwareVirtualTerminal({ mode: 'ephemeral-loopback-test', port: address.port, tls: pki.client, pinnedServerFingerprint: hardwareTestCertificateFingerprint(pki.server.cert), expectedHostId: 'h5-approval-test' }); cleanup.push(() => terminal.close())
    await terminal.connect(); const pending = await terminal.pair(identities.createTicket().ticket, 'Synthetic only', ['voice.button'])
    bridge.approvePairing(pending.requestId, { roomId: 'test-room', scopes: ['voice.button'] }); await terminal.waitForIdentity(); const terminalSession = await terminal.openVoice({ replyProtocolVersion: 1 })
    await terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    // Exercise the protocol's maximum capture ID against the real H5 128-char request bound.
    const captureId = 'maximum-capture-'.padEnd(128, 'x')
    await terminal.sendPacket({ type: 'capture-start', captureId, trigger: 'button' })
    await terminal.sendPacket({ type: 'audio', captureId, audioSequence: 0, pcm: Buffer.alloc(3200).toString('base64') })
    const admission = await terminal.sendPacket({ type: 'capture-end', captureId })
    expect(admission.requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
    expect(admission.state).toBe('submitted'); expect(admissions).toHaveLength(1); expect(admissions[0]).toMatchObject({ messageId: admission.requestId, state: 'queued' })
    let snapshot: any
    await expect.poll(async () => { snapshot = await fetch(base + `/api/runs/${admissions[0].runId}/state`, { headers }).then(r => r.json()); return snapshot.interactions?.some((g: any) => g.kind === 'approval') }, { timeout: 5000, interval: 20 }).toBe(true)
    expect((await host.deviceUse.status()).commands).toEqual([])
    expect(speech).not.toHaveBeenCalled(); expect(terminal.outputs.some(p => p.type === 'playback')).toBe(false)
    if (scenario === 'revoked-before-approval') await host.deviceUse.revoke({ authorizationRef: grant.authorizationRef })
    const interaction = snapshot.interactions.find((g: any) => g.kind === 'approval')
    const response = await fetch(base + `/api/runs/${admissions[0].runId}/replies`, { method: 'POST', headers, body: JSON.stringify({ conversationId: admissions[0].conversationId, groupId: interaction.groupId, requestId: `test-decision-${scenario}`, answers: interaction.items.map((item: any) => ({ effectId: item.effectId, value: { approved: scenario !== 'denied' } })) }) })
    expect(response.status, await response.text()).toBe(200)
    if (scenario === 'denied') {
      await expect.poll(() => bridge.snapshot().replies[0]?.phase, { timeout: 5000, interval: 20 }).toBe('failed')
      const deniedView = await fetch(base + '/api/assistant', { headers }).then(r => r.json()) as any
      expect(deniedView.receipts.find((r: any) => r.messageId === admission.requestId)?.state).toBe('failed')
      expect((await host.deviceUse.status()).commands).toEqual([])
      expect(terminal.outputs.some(p => p.type === 'playback')).toBe(false)
      expect(speech).not.toHaveBeenCalled()
      await expect.poll(() => voice.diagnostics().active).toBe(0)
      return
    }
    await expect.poll(() => terminal.outputs.some(p => p.type === 'playback'), { timeout: 5000, interval: 20 }).toBe(true)
    const output = terminal.outputs.find(p => p.type === 'playback')!, final = terminal.outputs.find(p => p.type === 'final-reply')!
    expect(final).toMatchObject({ text: `Synthetic final for ${scenario}.`, requestId: admission.requestId, sessionId: terminalSession.sessionId })
    expect(output).toMatchObject({ requestId: admission.requestId, replyId: final.replyId, sessionId: terminalSession.sessionId })
    await terminal.acknowledgePlayback(output); await terminal.reportPlayback(output, 'started'); await terminal.reportPlayback(output, 'completed')
    expect(bridge.snapshot().replies[0]?.phase).toBe('completed')
    const view = await fetch(base + '/api/assistant', { headers }).then(r => r.json()) as any
    expect(view.receipts.filter((r: any) => r.messageId === admission.requestId)).toMatchObject([{ state: 'completed', runId: admissions[0].runId }])
    expect(view.messages.find((m: any) => m.id === `msg-${admission.requestId}`)).toMatchObject({ role: 'user', inputMode: 'voice' })
    expect(view.messages.find((m: any) => m.text === final.text)).toMatchObject({ runId: admissions[0].runId, replyToId: `msg-${admission.requestId}`, messageKind: 'reply' })
    expect(receiptStates).toContain('replying')
    const commands = (await host.deviceUse.status()).commands
    if (scenario === 'approved') expect(commands).toMatchObject([{ status: 'observed', evidence: { source: 'simulator' } }])
    else if (scenario === 'denied') expect(commands).toEqual([])
    else { expect(commands).toMatchObject([{ status: 'failed', reason: 'DEVICE_NOT_AUTHORIZED' }]); expect((await host.deviceUse.status()).devices.find(d => d.deviceId === 'sim:light')?.state.power).toBe(false) }
    expect(speech).toHaveBeenCalledWith(`Synthetic final for ${scenario}.`)
    // Finish any outstanding polling callback before resource closure.
    await expect.poll(() => voice.diagnostics().active).toBe(0)
  }, 15_000)
})
