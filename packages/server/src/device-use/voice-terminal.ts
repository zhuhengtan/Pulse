import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { VoiceTerminalReplyCoordinator } from './voice-terminal-replies.js'
import { voiceTerminalFinalReplySchema, voiceTerminalPlaybackReportSchema, type VoiceTerminalReplyOrigin, type VoiceTerminalFinalReply } from './voice-terminal-turns.js'

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
export const voiceTerminalHelloSchema = z.object({ protocolVersions: z.array(z.literal(1)).min(1).max(4), deviceId: identity, roomId: identity, replyProtocolVersion: z.literal(1).optional(), audio: z.object({ codec: z.literal('pcm_s16le'), sampleRate: z.literal(16000), channels: z.literal(1) }).strict() }).strict()
const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture-start'), captureId: identity, trigger: z.enum(['button', 'wake']) }).strict(),
  z.object({ type: z.literal('audio'), captureId: identity, audioSequence: z.number().int().nonnegative().safe(), pcm: z.string().max(21336).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  z.object({ type: z.literal('capture-end'), captureId: identity }).strict(),
  z.object({ type: z.literal('status'), muted: z.boolean(), light: z.enum(['idle', 'listening', 'speaking', 'muted', 'error']), batteryPercent: z.number().min(0).max(100).optional() }).strict(),
  z.object({ type: z.literal('stop-playback') }).strict(),
  z.object({ type: z.literal('playback-ack'), playbackId: identity, audioSequence: z.number().int().nonnegative().safe() }).strict(),
  voiceTerminalPlaybackReportSchema.extend({ type: z.literal('playback-status') }).strict(),
  z.object({ type: z.literal('heartbeat') }).strict(),
])
export const voiceTerminalPacketSchema = z.object({ protocolVersion: z.literal(1), deviceId: identity, roomId: identity, sessionId: z.string().uuid(), sequence: z.number().int().nonnegative().safe(), payload }).strict()
export interface VoiceTerminalIdentity { connectionId: string; deviceId: string; roomId: string }
export interface VoiceTerminalGrant { deviceId: string; roomId: string; allowButton: boolean; allowWake: boolean }
export interface VoiceTerminalRequest { deviceId: string; roomId: string; sessionId: string; captureId: string; requestId: string }
export interface VoiceTerminalIO {
  /** Trust belongs to the host's authenticated transport, never a field in hello. */
  send(identity: VoiceTerminalIdentity, packet: Record<string, unknown>): void
  /** Abort is cooperative: a settled callback, not abort delivery, releases capacity. */
  transcribe(wav: string, request: VoiceTerminalRequest, signal?: AbortSignal): Promise<string>
  /** Route to the ordinary assistant queue with this idempotent requestId. */
  submit(text: string, request: VoiceTerminalRequest): Promise<unknown>
  /** Optional trusted Host hooks. Neither runs unless Host and terminal explicitly opt in. */
  reply?(admission: unknown, request: VoiceTerminalRequest, signal: AbortSignal): Promise<VoiceTerminalFinalReply>
  synthesize?(reply: VoiceTerminalFinalReply, request: VoiceTerminalRequest, signal: AbortSignal): Promise<{ requestId: string; replyId: string; chunks: { audio: string; mime: 'audio/wav' }[] }>
  diagnostics?(): { active: number; quarantined: number }
}
interface Capture { id: string; generation: number; startedAt: number; frames: Buffer[]; bytes: number; sequence: number }
interface Transcription { session: Session; controller: AbortController; cancel(reason: string): void }
interface Playback { id: string; sent: number; acknowledged: number; ended: boolean }
interface Session {
  identity: VoiceTerminalIdentity; id: string; sequence: number; generation: number; lastSeen: number; repliesEnabled: boolean
  captureIds: Set<string>; muted: boolean; light: string; batteryPercent?: number; capture?: Capture | undefined; playback?: Playback | undefined
}
export type VoiceTerminalResult = { state: 'accepted' | 'duplicate' | 'resync-required' | 'discarded' | 'submitted' | 'unknown'; requestId?: string }

/** In-process protocol engine. It opens no port, pairs nothing and stores no credentials. */
export class VoiceTerminalBroker {
  private readonly grants = new Map<string, VoiceTerminalGrant>()
  private readonly sessions = new Map<string, Session>()
  private readonly transcriptions = new Set<Transcription>()
  private readonly now: () => number
  private readonly replies: VoiceTerminalReplyCoordinator | undefined
  constructor(private readonly io: VoiceTerminalIO, private readonly options: { now?: () => number; maxCaptureMs?: number; idleTimeoutMs?: number; transcriptionTimeoutMs?: number; enableReplies?: boolean; replyTimeoutMs?: number } = {}) {
    this.now = options.now ?? Date.now
    if (options.enableReplies && (!io.reply || !io.synthesize)) throw new Error('VOICE_TERMINAL_REPLY_CONFIGURATION_REQUIRED')
    if (options.enableReplies) this.replies = new VoiceTerminalReplyCoordinator({
      submit: (text, origin) => io.submit(text, origin),
      reply: async (admission, origin, signal) => {
        const final = voiceTerminalFinalReplySchema.parse(await io.reply!(admission, origin, signal))
        if (signal.aborted || !this.currentOrigin(origin) || final.requestId !== origin.requestId) throw new Error('VOICE_TERMINAL_REPLY_SUPERSEDED')
        const session = this.sessions.get(origin.deviceId)!
        this.output(session, { type: 'final-reply', ...final })
        return final
      },
      synthesize: (final, origin, signal) => io.synthesize!(final, origin, signal),
      isCurrent: origin => this.currentOrigin(origin),
      stop: origin => { const session = this.sessions.get(origin.deviceId); if (session?.id === origin.sessionId) this.stopPlayback(session) },
      send: (origin, chunk) => {
        if (!this.currentOrigin(origin)) throw new Error('VOICE_TERMINAL_REPLY_SUPERSEDED')
        this.play(this.sessions.get(origin.deviceId)!.identity, chunk)
      },
    }, { enabled: true, ...(options.replyTimeoutMs !== undefined ? { timeoutMs: options.replyTimeoutMs } : {}) })
    if (options.transcriptionTimeoutMs !== undefined && (!Number.isFinite(options.transcriptionTimeoutMs) || options.transcriptionTimeoutMs < 1 || options.transcriptionTimeoutMs > 180_000)) throw new Error('VOICE_TERMINAL_LIMIT_INVALID')
    if (options.maxCaptureMs !== undefined && (!Number.isFinite(options.maxCaptureMs) || options.maxCaptureMs < 1 || options.maxCaptureMs > 30_000)) throw new Error('VOICE_TERMINAL_LIMIT_INVALID')
    if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 1)) throw new Error('VOICE_TERMINAL_LIMIT_INVALID')
  }
  register(grant: VoiceTerminalGrant): void {
    identity.parse(grant.deviceId); identity.parse(grant.roomId)
    if (typeof grant.allowButton !== 'boolean' || typeof grant.allowWake !== 'boolean') throw new Error('VOICE_TERMINAL_GRANT_INVALID')
    if (!this.grants.has(grant.deviceId) && this.grants.size >= 128) throw new Error('VOICE_TERMINAL_CAPACITY')
    // Re-enrollment cannot silently move an existing session or extend its grant.
    this.revoke(grant.deviceId); this.grants.set(grant.deviceId, { ...grant })
  }
  revoke(deviceId: string): void { this.grants.delete(deviceId); const session = this.sessions.get(deviceId); if (session) this.close(session.identity) }
  /** Caller supplies a verified principal from mTLS/host authentication. Never pass hello as principal. */
  open(principal: VoiceTerminalIdentity, raw: unknown): { protocolVersion: 1; sessionId: string; nextSequence: 0; replyProtocolVersion?: 1 } {
    const hello = voiceTerminalHelloSchema.parse(raw), grant = this.grants.get(principal.deviceId)
    if (!principal.connectionId || !grant || hello.deviceId !== principal.deviceId || hello.roomId !== principal.roomId || grant.roomId !== principal.roomId) throw new Error('VOICE_TERMINAL_UNAUTHORIZED')
    const previous = this.sessions.get(principal.deviceId)
    if (previous) throw new Error('VOICE_TERMINAL_ALREADY_CONNECTED')
    const session: Session = { identity: { ...principal }, id: randomUUID(), sequence: 0, generation: 0, lastSeen: this.now(), repliesEnabled: Boolean(this.replies && hello.replyProtocolVersion === 1), muted: true, light: 'muted', captureIds: new Set() }
    this.sessions.set(principal.deviceId, session)
    // Privacy-safe until a fresh device status explicitly reports an unmuted mic.
    return { protocolVersion: 1, sessionId: session.id, nextSequence: 0, ...(session.repliesEnabled ? { replyProtocolVersion: 1 as const } : {}) }
  }
  private active(principal: VoiceTerminalIdentity): Session {
    const session = this.sessions.get(principal.deviceId)
    if (!session || session.identity.connectionId !== principal.connectionId || session.identity.roomId !== principal.roomId || !this.grants.has(principal.deviceId)) throw new Error('VOICE_TERMINAL_SESSION_INVALID')
    if (this.now() - session.lastSeen > (this.options.idleTimeoutMs ?? 15_000)) { this.close(principal); throw new Error('VOICE_TERMINAL_OFFLINE') }
    return session
  }
  private currentOrigin(origin: VoiceTerminalReplyOrigin): boolean {
    const session = this.sessions.get(origin.deviceId)
    return Boolean(session && session.id === origin.sessionId && session.identity.roomId === origin.roomId && session.generation === origin.generation && session.repliesEnabled && !session.muted && this.grants.has(origin.deviceId) && this.now() - session.lastSeen <= (this.options.idleTimeoutMs ?? 15_000))
  }
  replySnapshot() { return this.replies?.list() ?? [] }
  /** Abort isolates callbacks; unresolved providers are not claimed to have stopped. */
  closeReplies(): { pendingCallbacks: number } {
    const result = this.replies?.close() ?? { pendingCallbacks: 0 }
    return { pendingCallbacks: result.pendingCallbacks + this.transcriptions.size + (this.io.diagnostics?.().active ?? 0) }
  }
  private output(session: Session, value: Record<string, unknown>): void {
    this.io.send(session.identity, { protocolVersion: 1, deviceId: session.identity.deviceId, roomId: session.identity.roomId, sessionId: session.id, ...value })
  }
  private stopPlayback(session: Session): void {
    session.playback = undefined
    this.output(session, { type: 'stop-playback' })
  }
  private cancelTranscriptions(session: Session): void {
    this.replies?.invalidateSession(session.id, 'VOICE_TERMINAL_SESSION_SUPERSEDED')
    for (const job of this.transcriptions) if (job.session === session) job.cancel('VOICE_TERMINAL_TRANSCRIBE_CANCELLED')
  }
  /** Cancellation isolates a result immediately, but never pretends the underlying callback stopped. */
  private transcribe(wav: string, request: VoiceTerminalRequest, session: Session): Promise<string> {
    const controller = new AbortController()
    let resolveResult!: (text: string) => void, rejectResult!: (error: unknown) => void
    const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    let timer: ReturnType<typeof setTimeout>
    const job: Transcription = { session, controller, cancel: reason => {
      if (controller.signal.aborted) return
      clearTimeout(timer)
      const error = new Error(reason)
      rejectResult(error); controller.abort(error)
    } }
    this.transcriptions.add(job)
    timer = setTimeout(() => job.cancel('VOICE_TERMINAL_TRANSCRIBE_TIMEOUT'), this.options.transcriptionTimeoutMs ?? 60_000)
    timer.unref?.()
    const settled = () => { clearTimeout(timer); this.transcriptions.delete(job) }
    try {
      // Keep both handlers attached even after timeout/disconnect. An uncooperative
      // callback remains quarantined in the four-slot bound until it really settles.
      Promise.resolve(this.io.transcribe(wav, request, controller.signal)).then(text => { settled(); if (!controller.signal.aborted) resolveResult(text) }, cause => { settled(); if (!controller.signal.aborted) rejectResult(cause) })
    } catch (cause) { settled(); rejectResult(cause) }
    return result
  }
  close(principal: VoiceTerminalIdentity): void {
    const session = this.sessions.get(principal.deviceId)
    if (!session || session.identity.connectionId !== principal.connectionId || session.identity.roomId !== principal.roomId) return
    session.generation++; session.capture = undefined; session.playback = undefined; this.cancelTranscriptions(session)
    this.sessions.delete(principal.deviceId)
    // Disconnect is not a cancellation of any already accepted assistant/device task.
  }
  sweep(): void { for (const session of this.sessions.values()) if (this.now() - session.lastSeen > (this.options.idleTimeoutMs ?? 15_000)) this.close(session.identity) }
  snapshot(): Array<{ deviceId: string; roomId: string; sessionId: string; reportedMuted: boolean; reportedLight: string; lastSeen: number; capturing: boolean; playbackPending: number; transcriptionPending: number; transcriptionQuarantined: number; transcriptionUnavailable: boolean; physicalMuteVerified: false }> {
    this.sweep()
    return [...this.sessions.values()].map(session => ({ deviceId: session.identity.deviceId, roomId: session.identity.roomId, sessionId: session.id, reportedMuted: session.muted, reportedLight: session.light, lastSeen: session.lastSeen, capturing: Boolean(session.capture), playbackPending: session.playback ? session.playback.sent - session.playback.acknowledged : 0, transcriptionPending: this.transcriptions.size, transcriptionQuarantined: [...this.transcriptions].filter(job => job.controller.signal.aborted).length, transcriptionUnavailable: this.transcriptions.size >= 4, physicalMuteVerified: false }))
  }
  async receive(principal: VoiceTerminalIdentity, raw: unknown): Promise<VoiceTerminalResult> {
    const packet = voiceTerminalPacketSchema.parse(raw), session = this.active(principal)
    if (packet.deviceId !== principal.deviceId || packet.roomId !== principal.roomId || packet.sessionId !== session.id) throw new Error('VOICE_TERMINAL_SESSION_INVALID')
    if (packet.sequence < session.sequence) return { state: 'duplicate' }
    if (packet.sequence > session.sequence) {
      session.generation++; session.capture = undefined; this.cancelTranscriptions(session)
      this.output(session, { type: 'resync', nextSequence: session.sequence })
      return { state: 'resync-required' }
    }
    session.sequence++; session.lastSeen = this.now()
    const event = packet.payload, grant = this.grants.get(principal.deviceId)!
    if (event.type === 'status') {
      session.muted = event.muted; session.light = event.light
      if (event.batteryPercent !== undefined) session.batteryPercent = event.batteryPercent
      if (event.muted) { session.generation++; session.capture = undefined; this.cancelTranscriptions(session); this.stopPlayback(session) }
    } else if (event.type === 'capture-start') {
      if (session.muted || !(event.trigger === 'button' ? grant.allowButton : grant.allowWake)) throw new Error('VOICE_TERMINAL_CAPTURE_FORBIDDEN')
      if (session.captureIds.has(event.captureId)) throw new Error('VOICE_TERMINAL_CAPTURE_REPLAY')
      if (session.captureIds.size >= 128) throw new Error('VOICE_TERMINAL_SESSION_CAPACITY')
      session.captureIds.add(event.captureId)
      this.stopPlayback(session); session.generation++; this.cancelTranscriptions(session)
      session.capture = { id: event.captureId, generation: session.generation, startedAt: this.now(), frames: [], bytes: 0, sequence: 0 }
      this.output(session, { type: 'light', desired: 'listening' })
    } else if (event.type === 'audio') {
      const capture = session.capture
      if (!capture || capture.id !== event.captureId || session.muted) return { state: 'discarded' }
      const bytes = Buffer.from(event.pcm, 'base64')
      if (event.audioSequence !== capture.sequence || !bytes.length || bytes.length % 2 || bytes.length > 16000 || bytes.toString('base64') !== event.pcm || capture.bytes + bytes.length > 32000 * ((this.options.maxCaptureMs ?? 30000) / 1000) || this.now() - capture.startedAt > (this.options.maxCaptureMs ?? 30000)) {
        session.generation++; session.capture = undefined; this.cancelTranscriptions(session); this.output(session, { type: 'capture-error', error: 'VOICE_TERMINAL_AUDIO_INVALID' }); return { state: 'discarded' }
      }
      capture.frames.push(bytes); capture.bytes += bytes.length; capture.sequence++
    } else if (event.type === 'capture-end') {
      const capture = session.capture; session.capture = undefined
      if (!capture || capture.id !== event.captureId || !capture.bytes || session.muted || this.now() - capture.startedAt > (this.options.maxCaptureMs ?? 30000)) return { state: 'discarded' }
      const request: VoiceTerminalRequest = { deviceId: principal.deviceId, roomId: principal.roomId, sessionId: session.id, captureId: capture.id, requestId: `voice-terminal-${session.id}-${createHash('sha256').update(capture.id).digest('hex')}` }
      const current = () => this.sessions.get(principal.deviceId) === session && this.grants.has(principal.deviceId) && !session.muted && session.generation === capture.generation && this.now() - session.lastSeen <= (this.options.idleTimeoutMs ?? 15_000)
      if (this.transcriptions.size >= 4) { this.output(session, { type: 'capture-error', error: 'VOICE_TERMINAL_ASR_UNAVAILABLE' }); return { state: 'discarded', requestId: request.requestId } }
      const wav = pcmWav(Buffer.concat(capture.frames)); capture.frames.length = 0
      let text: string
      try { text = await this.transcribe(wav, request, session) }
      catch (cause) { if (current()) this.output(session, { type: 'capture-error', error: cause instanceof Error && cause.message === 'VOICE_TERMINAL_TRANSCRIBE_TIMEOUT' ? cause.message : 'VOICE_TERMINAL_TRANSCRIBE_FAILED' }); return { state: 'discarded', requestId: request.requestId } }
      if (!current() || typeof text !== 'string' || !text.trim() || text.length > 20_000) return { state: 'discarded', requestId: request.requestId }
      // After submit begins its result may be unknown; never blindly replay on reconnect.
      try {
        if (session.repliesEnabled && this.replies) {
          const record = await this.replies.submit(text.trim(), { ...request, generation: capture.generation })
          return { state: record.admissionConfirmed === true ? 'submitted' : 'unknown', requestId: request.requestId }
        }
        await this.io.submit(text.trim(), request); return { state: 'submitted', requestId: request.requestId } }
      catch { return { state: 'unknown', requestId: request.requestId } }
    } else if (event.type === 'stop-playback') { this.replies?.invalidateSession(session.id, 'VOICE_TERMINAL_PLAYBACK_STOPPED'); this.stopPlayback(session) }
    else if (event.type === 'playback-status') {
      if (!session.repliesEnabled || !this.replies) return { state: 'discarded' }
      const { type: _type, ...report } = event
      const record = this.replies.get(report.requestId)
      if (!record || record.origin.sessionId !== session.id || !this.currentOrigin(record.origin)) return { state: 'discarded' }
      this.replies.report(record.origin, report)
      if (report.stage === 'completed' || report.stage === 'error') session.playback = undefined
    }
    else if (event.type === 'playback-ack') {
      const playback = session.playback
      if (!playback || playback.id !== event.playbackId) return { state: 'discarded' }
      if (event.audioSequence < playback.acknowledged) return { state: 'duplicate' }
      if (event.audioSequence !== playback.acknowledged || event.audioSequence >= playback.sent) throw new Error('VOICE_TERMINAL_PLAYBACK_ACK_INVALID')
      playback.acknowledged++
      const record = this.replies?.list().find(r => r.playbackId === event.playbackId && r.origin.sessionId === session.id)
      if (record && this.currentOrigin(record.origin)) this.replies!.acknowledgeChunk(record.origin, event.playbackId, event.audioSequence)
      if (playback.ended && playback.sent === playback.acknowledged) session.playback = undefined
    }
    return { state: 'accepted' }
  }
  /** At most two outstanding audio chunks. A transport send never means physically played. */
  play(principal: VoiceTerminalIdentity, chunk: { playbackId: string; audioSequence: number; audio: string; final: boolean; requestId?: string; replyId?: string }): { state: 'sent' } {
    const session = this.active(principal)
    identity.parse(chunk.playbackId)
    if (!Number.isSafeInteger(chunk.audioSequence) || chunk.audioSequence < 0 || typeof chunk.final !== 'boolean' || typeof chunk.audio !== 'string' || chunk.audio.length > 1_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.audio)) throw new Error('VOICE_TERMINAL_PLAYBACK_INVALID')
    if (session.muted) throw new Error('VOICE_TERMINAL_MUTED')
    if (!session.playback) {
      if (chunk.audioSequence !== 0) throw new Error('VOICE_TERMINAL_PLAYBACK_SEQUENCE')
      session.playback = { id: chunk.playbackId, sent: 0, acknowledged: 0, ended: false }
    }
    const playback = session.playback
    if (playback.id !== chunk.playbackId || playback.ended || playback.sent !== chunk.audioSequence) throw new Error('VOICE_TERMINAL_PLAYBACK_SEQUENCE')
    if (playback.sent - playback.acknowledged >= 2) throw new Error('VOICE_TERMINAL_PLAYBACK_BACKPRESSURE')
    playback.sent++; playback.ended = chunk.final
    this.output(session, { type: 'playback', ...chunk, mime: 'audio/wav' })
    return { state: 'sent' }
  }
}

function pcmWav(pcm: Buffer): string {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm]).toString('base64')
}

/** Reuse the host's existing ASR and assistant admission, without a second command executor. */
export function voiceTerminalHostIO(request: (path: string, init: { method: 'POST'; body: string; signal?: AbortSignal }) => Promise<unknown>, send: VoiceTerminalIO['send']): VoiceTerminalIO {
  return {
    send,
    async transcribe(audio, _metadata, signal) { const result = await request('/api/voice/transcribe', { method: 'POST', body: JSON.stringify({ audio }), ...(signal ? { signal } : {}) }) as { text?: unknown }; if (typeof result?.text !== 'string') throw new Error('VOICE_TERMINAL_TRANSCRIPT_INVALID'); return result.text },
    submit(text, metadata) { return request('/api/assistant/messages', { method: 'POST', body: JSON.stringify({ text, requestId: metadata.requestId, delivery: 'immediate', inputMode: 'voice' }) }) },
  }
}
