import { z } from 'zod'
import { VoiceTerminalBroker, type VoiceTerminalIdentity, type VoiceTerminalIO } from './voice-terminal.js'

export const terminalDiagnosticActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable') }).strict(),
  z.object({ action: z.literal('disable') }).strict(),
  z.object({ action: z.literal('finish-cleanup') }).strict(),
  z.object({ action: z.literal('run'), scenario: z.enum(['playback-complete', 'playback-timeout', 'callback-quarantine']) }).strict(),
])
type Scenario = 'playback-complete' | 'playback-timeout' | 'callback-quarantine'
interface Callback { kind: 'asr' | 'reply'; signal: AbortSignal | undefined }
interface Playback { requestId: string; replyId: string; playbackId: string; audioSequence: number }
export interface TerminalDiagnosticSnapshot {
  enabled: boolean; simulated: true; productionListener: false; persistentPairing: false; busy: boolean; scenario?: Scenario
  cleanup: { state: 'idle' | 'running' | 'unconfirmed' | 'completed'; pendingCallbacks: number }
  session: { state: 'absent' | 'open' | 'closed'; sessionId?: string; generation?: number; reportedMuted?: boolean }
  callbacks: { asrPending: number; asrQuarantined: number; replyPending: number; replyQuarantined: number }
  reply?: { requestId: string; phase: string; ackCount?: number; chunkCount?: number; errorCode?: string; admissionConfirmed: boolean }
  timeline: { at: number; event: string }[]; lastError?: string
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 2))
function diagnosticWav(): string {
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40)
  return wav.toString('base64')
}
/** Fixed in-process synthetic scenarios only. No socket, filesystem, model,
 * account, credential, pairing registry, microphone or device adapter exists here. */
export class TerminalDiagnostics {
  private enabled = false
  private closed = false
  private busy = false
  private operation: Promise<TerminalDiagnosticSnapshot> | undefined
  private broker: VoiceTerminalBroker | undefined
  private principal: VoiceTerminalIdentity | undefined
  private sequence = 0
  private scenario: Scenario | undefined
  private session: TerminalDiagnosticSnapshot['session'] = { state: 'absent' }
  private cleanup: TerminalDiagnosticSnapshot['cleanup'] = { state: 'idle', pendingCallbacks: 0 }
  private readonly callbacks = new Set<Callback>()
  private readonly timeline: TerminalDiagnosticSnapshot['timeline'] = []
  private releaseSyntheticCallback: (() => void) | undefined
  private lastError: string | undefined
  private sessionClosed(): void { const { generation: _generation, ...session } = this.session; this.session = { ...session, state: 'closed' } }
  private event(event: string): void { this.timeline.push({ at: Date.now(), event }); if (this.timeline.length > 48) this.timeline.shift() }
  snapshot(): TerminalDiagnosticSnapshot {
    const records = this.broker?.replySnapshot() ?? [], record = records.at(-1)
    const sessions = this.broker?.snapshot() ?? []
    if (this.session.state === 'open' && !sessions.length) this.sessionClosed()
    const reply = record ? { requestId: record.origin.requestId, phase: record.phase, admissionConfirmed: record.admissionConfirmed === true, ...(record.ackCount !== undefined ? { ackCount: record.ackCount } : {}), ...(record.chunkCount !== undefined ? { chunkCount: record.chunkCount } : {}), ...(record.errorCode ? { errorCode: record.errorCode } : {}) } : undefined
    return structuredClone({ enabled: this.enabled, simulated: true, productionListener: false, persistentPairing: false, busy: this.busy,
      ...(this.scenario ? { scenario: this.scenario } : {}), cleanup: this.cleanup, session: this.session,
      callbacks: { asrPending: [...this.callbacks].filter(c => c.kind === 'asr').length, asrQuarantined: [...this.callbacks].filter(c => c.kind === 'asr' && c.signal?.aborted).length, replyPending: [...this.callbacks].filter(c => c.kind === 'reply').length, replyQuarantined: [...this.callbacks].filter(c => c.kind === 'reply' && c.signal?.aborted).length },
      ...(reply ? { reply } : {}), timeline: this.timeline, ...(this.lastError ? { lastError: this.lastError } : {}),
    })
  }
  act(raw: unknown): Promise<TerminalDiagnosticSnapshot> {
    if (this.closed) return Promise.reject(new Error('DEVICE_TERMINAL_DIAGNOSTICS_CLOSED'))
    if (this.busy) return Promise.reject(new Error('DEVICE_TERMINAL_DIAGNOSTICS_BUSY'))
    const parsed = terminalDiagnosticActionSchema.safeParse(raw)
    if (!parsed.success) return Promise.reject(new Error('DEVICE_TERMINAL_DIAGNOSTICS_INVALID'))
    const input = parsed.data
    if (input.action !== 'enable' && input.action !== 'disable' && !this.enabled) return Promise.reject(new Error('DEVICE_TERMINAL_DIAGNOSTICS_DISABLED'))
    this.busy = true; this.lastError = undefined
    const operation = (async () => {
      try {
        if (input.action === 'enable') { if (!this.enabled) { this.enabled = true; this.event('enabled') } }
        else if (input.action === 'disable') { await this.disposeScenario(); this.enabled = false; this.event('disabled') }
        else if (input.action === 'finish-cleanup') { await this.finishCleanup() }
        else { await this.run(input.scenario) }
      } catch {
        this.lastError = 'DEVICE_TERMINAL_DIAGNOSTICS_FAILED'; this.event('scenario-failed')
        throw new Error(this.lastError)
      } finally { this.busy = false }
      return this.snapshot()
    })()
    this.operation = operation
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined }).catch(() => {})
    return operation
  }
  private async tracked<T>(kind: Callback['kind'], signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const callback: Callback = { kind, signal }; this.callbacks.add(callback)
    try { return await work() } finally { this.callbacks.delete(callback) }
  }
  private async until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000
    while (!condition()) { if (Date.now() >= deadline) throw new Error('DIAGNOSTIC_INTERNAL_TIMEOUT'); await pause() }
  }
  private packet(payload: unknown) {
    if (!this.broker || !this.principal || !this.session.sessionId) throw new Error('DIAGNOSTIC_SESSION_ABSENT')
    return this.broker.receive(this.principal, { protocolVersion: 1, deviceId: this.principal.deviceId, roomId: this.principal.roomId, sessionId: this.session.sessionId, sequence: this.sequence++, payload })
  }
  private async run(scenario: Scenario): Promise<void> {
    await this.disposeScenario()
    this.timeline.length = 0; this.scenario = scenario; this.cleanup = { state: 'idle', pendingCallbacks: 0 }; this.sequence = 0
    let playback: Playback | undefined
    let resolveAsr!: (text: string) => void
    const stalledAsr = scenario === 'callback-quarantine' ? new Promise<string>(resolve => { resolveAsr = resolve }) : undefined
    if (stalledAsr) this.releaseSyntheticCallback = () => resolveAsr('Late synthetic transcript')
    const io: VoiceTerminalIO = {
      send: (_principal, packet) => {
        if (packet.type === 'playback') { playback = { requestId: String(packet.requestId), replyId: String(packet.replyId), playbackId: String(packet.playbackId), audioSequence: Number(packet.audioSequence) }; this.event('playback-sent') }
        else if (packet.type === 'final-reply') this.event('final-reply-available')
        else if (packet.type === 'stop-playback') this.event('playback-stop-requested')
      },
      transcribe: (_wav, _request, signal) => this.tracked('asr', signal, async () => { this.event('asr-started'); return stalledAsr ?? 'Synthetic diagnostic request' }),
      submit: async () => { this.event('synthetic-admission-confirmed'); return { simulated: true } },
      reply: (_admission, request, signal) => this.tracked('reply', signal, async () => ({ requestId: request.requestId, replyId: 'diagnostic-reply', final: true as const, text: 'Synthetic diagnostic reply' })),
      synthesize: (reply, request, signal) => this.tracked('reply', signal, async () => ({ requestId: request.requestId, replyId: reply.replyId, chunks: [{ audio: diagnosticWav(), mime: 'audio/wav' as const }] })),
    }
    this.broker = new VoiceTerminalBroker(io, { enableReplies: true, replyTimeoutMs: 80, idleTimeoutMs: 60_000 })
    this.principal = { deviceId: 'simulated-diagnostic-terminal', roomId: 'simulated-diagnostic-room', connectionId: 'in-process-diagnostic' }
    this.broker.register({ deviceId: this.principal.deviceId, roomId: this.principal.roomId, allowButton: true, allowWake: false })
    const session = this.broker.open(this.principal, { protocolVersions: [1], replyProtocolVersion: 1, deviceId: this.principal.deviceId, roomId: this.principal.roomId, audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } })
    this.session = { state: 'open', sessionId: session.sessionId, generation: 0, reportedMuted: true }; this.event('session-opened')
    await this.packet({ type: 'status', muted: false, light: 'idle' }); this.session.reportedMuted = false
    await this.packet({ type: 'capture-start', captureId: 'synthetic-capture', trigger: 'button' }); this.session.generation = 1
    await this.packet({ type: 'audio', captureId: 'synthetic-capture', audioSequence: 0, pcm: Buffer.alloc(32).toString('base64') })
    const capture = this.packet({ type: 'capture-end', captureId: 'synthetic-capture' })
    if (scenario === 'callback-quarantine') {
      await this.until(() => this.callbacks.size > 0)
      this.broker.close(this.principal); this.sessionClosed(); this.event('session-closed')
      await capture
      const pendingCallbacks = this.broker.closeReplies().pendingCallbacks
      this.cleanup = { state: pendingCallbacks ? 'unconfirmed' : 'completed', pendingCallbacks }
      this.event('callback-quarantined'); this.event('cleanup-unconfirmed'); return
    }
    await capture; await this.until(() => Boolean(playback))
    if (scenario === 'playback-timeout') { await this.until(() => this.broker!.replySnapshot().at(-1)?.phase === 'unknown'); this.event('playback-timeout'); return }
    const output = playback!
    await this.packet({ type: 'playback-ack', playbackId: output.playbackId, audioSequence: output.audioSequence }); this.event('playback-received')
    await this.packet({ type: 'playback-status', requestId: output.requestId, replyId: output.replyId, playbackId: output.playbackId, stage: 'started' }); this.event('playback-started')
    await this.packet({ type: 'playback-status', requestId: output.requestId, replyId: output.replyId, playbackId: output.playbackId, stage: 'completed' }); this.event('playback-completed')
  }
  private async finishCleanup(): Promise<void> {
    if (this.broker && this.principal && this.session.state === 'open') { this.broker.close(this.principal); this.sessionClosed(); this.event('session-closed') }
    this.cleanup = { ...this.cleanup, state: 'running' }; this.event('cleanup-started')
    this.releaseSyntheticCallback?.(); this.releaseSyntheticCallback = undefined
    await this.until(() => this.callbacks.size === 0)
    const pendingCallbacks = this.broker?.closeReplies().pendingCallbacks ?? 0
    this.cleanup = { state: pendingCallbacks ? 'unconfirmed' : 'completed', pendingCallbacks }
    if (pendingCallbacks) throw new Error('DIAGNOSTIC_CLEANUP_UNCONFIRMED')
    this.event('cleanup-completed')
  }
  private async disposeScenario(): Promise<void> {
    if (this.broker && this.principal) { this.broker.close(this.principal); this.sessionClosed() }
    await this.finishCleanup()
  }
  async close(): Promise<void> {
    this.closed = true
    await this.operation?.catch(() => {})
    await this.disposeScenario(); this.enabled = false
  }
}
