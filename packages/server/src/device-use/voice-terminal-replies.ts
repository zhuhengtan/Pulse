import { randomUUID } from 'node:crypto'
import { VoiceTerminalReplyLedger, type VoiceTerminalReplyOrigin, type VoiceTerminalReplyRecord, type VoiceTerminalPlaybackReport, type VoiceTerminalFinalReply } from './voice-terminal-turns.js'

export interface VoiceTerminalReplyChunk { requestId: string; replyId: string; playbackId: string; audioSequence: number; audio: string; final: boolean }
export interface VoiceTerminalReplyIO {
  submit(text: string, origin: VoiceTerminalReplyOrigin, signal: AbortSignal): Promise<unknown>
  reply(admission: unknown, origin: VoiceTerminalReplyOrigin, signal: AbortSignal): Promise<VoiceTerminalFinalReply>
  synthesize(reply: VoiceTerminalFinalReply, origin: VoiceTerminalReplyOrigin, signal: AbortSignal): Promise<{ requestId: string; replyId: string; chunks: { audio: string; mime: 'audio/wav' }[] }>
  /** Must check authenticated session AND generation, including mute/revoke/capture changes. */
  isCurrent(origin: VoiceTerminalReplyOrigin): boolean
  stop?(origin: VoiceTerminalReplyOrigin): void
  send(origin: VoiceTerminalReplyOrigin, chunk: VoiceTerminalReplyChunk): void
}
interface Flight { chunks: { audio: string; mime: 'audio/wav' }[]; next: number; timer: ReturnType<typeof setTimeout>; pumping: boolean }
const active = new Set(['awaiting-reply', 'awaiting-tts', 'synthesizing', 'sent', 'received', 'started'])
/** Opt-in orchestration only: no credentials, persistence, networking, or replay. */
export class VoiceTerminalReplyCoordinator {
  private readonly ledger: VoiceTerminalReplyLedger
  private readonly flights = new Map<string, Flight>()
  private readonly callbacks = new Map<AbortController, VoiceTerminalReplyOrigin>()
  private readonly timeoutMs: number
  private readonly maxPending: number
  private closed = false
  constructor(private readonly io: VoiceTerminalReplyIO, private readonly options: { enabled?: boolean; ledger?: VoiceTerminalReplyLedger; timeoutMs?: number; maxPending?: number } = {}) {
    this.ledger = options.ledger ?? new VoiceTerminalReplyLedger()
    this.timeoutMs = options.timeoutMs ?? 30000; this.maxPending = options.maxPending ?? 4
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 180000 || !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 32) throw new Error('VOICE_TERMINAL_LIMIT_INVALID')
  }
  private current(origin: VoiceTerminalReplyOrigin): void {
    if (this.closed || !this.options.enabled) throw new Error('VOICE_TERMINAL_DISABLED')
    if (!this.io.isCurrent({ ...origin })) throw new Error('VOICE_TERMINAL_STALE')
  }
  private record(origin: VoiceTerminalReplyOrigin): VoiceTerminalReplyRecord {
    this.current(origin)
    const record = this.ledger.get(origin.requestId)
    if (!record || Object.keys(record.origin).some(key => record.origin[key as keyof VoiceTerminalReplyOrigin] !== origin[key as keyof VoiceTerminalReplyOrigin])) throw new Error('VOICE_TERMINAL_CORRELATION')
    return record
  }
  /** Abort is cooperative; capacity remains reserved until the callback really settles. */
  private async invoke<T>(origin: VoiceTerminalReplyOrigin, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.callbacks.size >= this.maxPending) throw new Error('VOICE_TERMINAL_CAPACITY')
    const controller = new AbortController(); this.callbacks.set(controller, { ...origin })
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error('VOICE_TERMINAL_CLOSED'); return work(controller.signal) })
    void operation.finally(() => this.callbacks.delete(controller)).catch(() => {})
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('VOICE_TERMINAL_CALLBACK_ABORTED')), { once: true })
      timer = setTimeout(() => controller.abort(), this.timeoutMs)
    })
    try { return await Promise.race([operation, aborted]) } finally { clearTimeout(timer) }
  }
  async submit(text: string, origin: VoiceTerminalReplyOrigin): Promise<VoiceTerminalReplyRecord> {
    this.current(origin)
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('VOICE_TERMINAL_INVALID')
    if (this.callbacks.size >= this.maxPending) throw new Error('VOICE_TERMINAL_CAPACITY')
    const accepted = this.ledger.accept(origin)
    try {
      const admission = await this.invoke(origin, signal => this.io.submit(text, { ...accepted.origin }, signal)); this.ledger.confirmAdmission(origin.requestId); this.record(accepted.origin)
      void this.respond(admission, accepted.origin)
    }
    catch { this.ledger.unknown(origin.requestId, 'VOICE_TERMINAL_SUBMISSION_UNKNOWN') }
    return this.ledger.get(origin.requestId)!
  }
  private async respond(admission: unknown, origin: VoiceTerminalReplyOrigin): Promise<void> {
    try {
      const reply = await this.invoke(origin, signal => this.io.reply(admission, { ...origin }, signal))
      this.record(origin)
      await this.finalReply(origin, reply)
    } catch { this.ledger.fail(origin.requestId, 'VOICE_TERMINAL_REPLY_FAILED'); this.release(origin.requestId) }
  }
  async finalReply(origin: VoiceTerminalReplyOrigin, raw: unknown): Promise<VoiceTerminalReplyRecord> {
    this.record(origin)
    if (this.callbacks.size >= this.maxPending || this.flights.size >= this.maxPending) throw new Error('VOICE_TERMINAL_CAPACITY')
    const record = this.ledger.finalReply(origin.requestId, raw)
    this.ledger.synthesizing(origin.requestId)
    try {
      const output = await this.invoke(origin, signal => this.io.synthesize({ ...record.reply! }, { ...record.origin }, signal))
      const latest = this.record(record.origin)
      if (latest.phase !== 'synthesizing') throw new Error('VOICE_TERMINAL_STATE')
      if (!output || output.requestId !== origin.requestId || output.replyId !== record.reply!.replyId || !Array.isArray(output.chunks) || !output.chunks.length || output.chunks.length > 32) throw new Error('VOICE_TERMINAL_AUDIO_INVALID')
      if (output.chunks.reduce((total, chunk) => total + (typeof chunk?.audio === 'string' ? chunk.audio.length : 12_000_001), 0) > 12_000_000) throw new Error('VOICE_TERMINAL_AUDIO_INVALID')
      const chunks = output.chunks.map(chunk => {
        if (!chunk || chunk.mime !== 'audio/wav' || typeof chunk.audio !== 'string' || chunk.audio.length > 1_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.audio)) throw new Error('VOICE_TERMINAL_AUDIO_INVALID')
        const wav = Buffer.from(chunk.audio, 'base64')
        if (wav.toString('base64') !== chunk.audio || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VOICE_TERMINAL_AUDIO_INVALID')
        return { audio: chunk.audio, mime: 'audio/wav' as const }
      })
      this.ledger.sent(origin.requestId, record.reply!.replyId, randomUUID(), chunks.length)
      const timer = setTimeout(() => { this.stop(origin.requestId); this.ledger.unknown(origin.requestId, 'VOICE_TERMINAL_PLAYBACK_TIMEOUT'); this.release(origin.requestId) }, this.timeoutMs)
      this.flights.set(origin.requestId, { chunks, next: 0, timer, pumping: false }); this.pump(origin.requestId)
    } catch { this.ledger.fail(origin.requestId, 'VOICE_TERMINAL_REPLY_FAILED'); this.release(origin.requestId) }
    return this.ledger.get(origin.requestId)!
  }
  private pump(requestId: string): void {
    const flight = this.flights.get(requestId)
    if (!flight || flight.pumping) return
    flight.pumping = true
    try {
      while (this.flights.get(requestId) === flight) {
        const record = this.ledger.get(requestId)!
        this.record(record.origin)
        if (!active.has(record.phase) || flight.next >= flight.chunks.length || flight.next - (record.ackCount ?? 0) >= 2) break
        const sequence = flight.next++
        this.io.send({ ...record.origin }, { requestId, replyId: record.reply!.replyId, playbackId: record.playbackId!, audioSequence: sequence, audio: flight.chunks[sequence]!.audio, final: sequence === flight.chunks.length - 1 })
      }
    } catch { this.stop(requestId); this.ledger.unknown(requestId, 'VOICE_TERMINAL_SEND_UNKNOWN'); this.release(requestId) }
    finally { flight.pumping = false }
  }
  acknowledgeChunk(origin: VoiceTerminalReplyOrigin, playbackId: string, sequence: number): VoiceTerminalReplyRecord {
    const record = this.record(origin), flight = this.flights.get(origin.requestId)
    if (!flight || sequence >= flight.next) throw new Error('VOICE_TERMINAL_ACK_UNSENT')
    this.ledger.acknowledgeChunk(origin.requestId, playbackId, sequence)
    this.pump(record.origin.requestId); return this.ledger.get(origin.requestId)!
  }
  report(origin: VoiceTerminalReplyOrigin, report: VoiceTerminalPlaybackReport): VoiceTerminalReplyRecord {
    this.record(origin)
    if (origin.requestId !== report.requestId) throw new Error('VOICE_TERMINAL_CORRELATION')
    const record = this.ledger.report(report)
    if (record.phase === 'completed' || record.phase === 'error') this.release(origin.requestId)
    return record
  }
  private stop(requestId: string): void {
    const record = this.ledger.get(requestId)
    if (record && ['sent', 'received', 'started'].includes(record.phase)) {
      try { this.io.stop?.({ ...record.origin }) } catch { /* Stop is best-effort, never evidence of completion. */ }
    }
  }
  private release(requestId: string): void { const flight = this.flights.get(requestId); if (flight) { clearTimeout(flight.timer); flight.chunks = []; this.flights.delete(requestId) } }
  invalidateSession(sessionId: string, reason: string): VoiceTerminalReplyRecord[] {
    for (const [controller, origin] of this.callbacks) if (origin.sessionId === sessionId) controller.abort()
    for (const record of this.ledger.list()) if (record.origin.sessionId === sessionId) this.stop(record.origin.requestId)
    const records = this.ledger.invalidateSession(sessionId, reason)
    for (const record of records) this.release(record.origin.requestId)
    return records
  }
  close(): { pendingCallbacks: number } {
    this.closed = true
    for (const controller of this.callbacks.keys()) controller.abort()
    for (const record of this.ledger.list()) this.stop(record.origin.requestId)
    for (const record of this.ledger.list()) if (active.has(record.phase)) this.ledger.unknown(record.origin.requestId, 'VOICE_TERMINAL_CLOSED')
    for (const id of this.flights.keys()) this.release(id)
    return { pendingCallbacks: this.callbacks.size }
  }
  get(requestId: string): VoiceTerminalReplyRecord | undefined { return this.ledger.get(requestId) }
  list(): VoiceTerminalReplyRecord[] { return this.ledger.list() }
}
