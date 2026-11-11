import { z } from 'zod'

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const requestIdentity = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/)
export const voiceTerminalReplyOriginSchema = z.object({ deviceId: identity, roomId: identity, sessionId: identity, captureId: identity, requestId: requestIdentity, generation: z.number().int().nonnegative().safe() }).strict()
export const voiceTerminalFinalReplySchema = z.object({ requestId: requestIdentity, replyId: identity, final: z.literal(true), text: z.string().min(1).max(20000) }).strict()
export const voiceTerminalPlaybackReportSchema = z.object({ requestId: requestIdentity, replyId: identity, playbackId: identity, stage: z.enum(['received', 'started', 'completed', 'error']), errorCode: identity.optional() }).strict()
export type VoiceTerminalReplyOrigin = z.infer<typeof voiceTerminalReplyOriginSchema>
export type VoiceTerminalFinalReply = z.infer<typeof voiceTerminalFinalReplySchema>
export type VoiceTerminalPlaybackReport = z.infer<typeof voiceTerminalPlaybackReportSchema>
export type VoiceTerminalReplyPhase = 'awaiting-reply' | 'awaiting-tts' | 'synthesizing' | 'sent' | 'received' | 'started' | 'completed' | 'error' | 'failed' | 'unknown' | 'superseded'
export interface VoiceTerminalReplyRecord { origin: VoiceTerminalReplyOrigin; admissionConfirmed?: boolean; phase: VoiceTerminalReplyPhase; reply?: VoiceTerminalFinalReply; playbackId?: string; chunkCount?: number; ackCount?: number; errorCode?: string; evidence: 'terminal-reported' }
const preSend = new Set<VoiceTerminalReplyPhase>(['awaiting-reply', 'awaiting-tts', 'synthesizing'])
const inFlight = new Set<VoiceTerminalReplyPhase>(['sent', 'received', 'started'])
function reject(code: string): never { throw new Error(`VOICE_TERMINAL_${code}`) }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const result = schema.safeParse(raw); if (!result.success) reject('INVALID'); return result.data }
function copy(record: VoiceTerminalReplyRecord): VoiceTerminalReplyRecord { return structuredClone(record) }
/** In-memory, bounded, non-replaying ledger. Receipts are terminal reports, not acoustic evidence. */
export class VoiceTerminalReplyLedger {
  private readonly records = new Map<string, VoiceTerminalReplyRecord>()
  private readonly maxRecords: number
  constructor(options: { maxRecords?: number } = {}) {
    this.maxRecords = options.maxRecords ?? 1024
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) reject('LIMIT_INVALID')
  }
  accept(origin: VoiceTerminalReplyOrigin): VoiceTerminalReplyRecord {
    const valid = parse(voiceTerminalReplyOriginSchema, origin)
    if (this.records.has(valid.requestId)) reject('DUPLICATE')
    if (this.records.size >= this.maxRecords) reject('CAPACITY')
    const record: VoiceTerminalReplyRecord = { origin: valid, phase: 'awaiting-reply', evidence: 'terminal-reported' }
    this.records.set(valid.requestId, record); return copy(record)
  }
  /** Only the coordinator receiving the actual submission receipt may call this. */
  confirmAdmission(requestId: string): VoiceTerminalReplyRecord {
    const record = this.require(requestId)
    record.admissionConfirmed = true
    return copy(record)
  }
  finalReply(requestId: string, raw: unknown): VoiceTerminalReplyRecord {
    const reply = parse(voiceTerminalFinalReplySchema, raw), record = this.require(requestId)
    if (reply.requestId !== requestId) reject('CORRELATION')
    if (record.phase !== 'awaiting-reply') reject('STATE')
    record.reply = reply; record.phase = 'awaiting-tts'; return copy(record)
  }
  synthesizing(requestId: string): VoiceTerminalReplyRecord {
    const record = this.require(requestId)
    if (record.phase !== 'awaiting-tts') reject('STATE')
    record.phase = 'synthesizing'; return copy(record)
  }
  sent(requestId: string, replyId: string, playbackId: string, chunkCount: number): VoiceTerminalReplyRecord {
    const record = this.require(requestId)
    parse(identity, playbackId)
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 32) reject('INVALID')
    if (record.reply?.replyId !== replyId) reject('CORRELATION')
    if (record.phase !== 'synthesizing') reject('STATE')
    record.playbackId = playbackId; record.chunkCount = chunkCount; record.ackCount = 0; record.phase = 'sent'; return copy(record)
  }
  /** Broker must authenticate session and verify that this sequence was actually sent. */
  acknowledgeChunk(requestId: string, playbackId: string, sequence: number): VoiceTerminalReplyRecord {
    const record = this.require(requestId)
    if (record.playbackId !== playbackId) reject('CORRELATION')
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= (record.chunkCount ?? 0)) reject('INVALID')
    if (!inFlight.has(record.phase) && record.phase !== 'completed') reject('STATE')
    if (sequence < (record.ackCount ?? 0)) return copy(record)
    if (sequence !== record.ackCount) reject('ACK_ORDER')
    record.ackCount++
    if (record.phase === 'sent') record.phase = 'received'
    return copy(record)
  }
  report(raw: VoiceTerminalPlaybackReport): VoiceTerminalReplyRecord {
    const input = parse(voiceTerminalPlaybackReportSchema, raw), record = this.require(input.requestId)
    if (record.reply?.replyId !== input.replyId || record.playbackId !== input.playbackId) reject('CORRELATION')
    if (input.stage === 'received' && !record.ackCount) reject('CHUNKS_PENDING')
    if (input.stage === 'completed' && record.ackCount !== record.chunkCount) reject('CHUNKS_PENDING')
    if (input.stage !== 'error' && input.errorCode !== undefined) reject('INVALID')
    if (record.phase === input.stage) {
      if (input.stage === 'error' && record.errorCode !== (input.errorCode ?? 'VOICE_TERMINAL_PLAYBACK_ERROR')) reject('STATE')
      return copy(record)
    }
    const previous = { received: 'sent', started: 'received', completed: 'started' } as const
    if (input.stage === 'error' ? !inFlight.has(record.phase) : record.phase !== previous[input.stage]) reject('STATE')
    record.phase = input.stage
    if (input.stage === 'error') record.errorCode = input.errorCode ?? 'VOICE_TERMINAL_PLAYBACK_ERROR'
    return copy(record)
  }
  invalidateSession(sessionId: string, reason: string): VoiceTerminalReplyRecord[] {
    parse(identity, reason)
    const changed: VoiceTerminalReplyRecord[] = []
    for (const record of this.records.values()) if (record.origin.sessionId === sessionId && (preSend.has(record.phase) || inFlight.has(record.phase))) {
      record.phase = preSend.has(record.phase) ? 'superseded' : 'unknown'; record.errorCode = reason; changed.push(copy(record))
    }
    return changed
  }
  /** Submission or delivery may have happened; unknown never authorizes retry. */
  unknown(requestId: string, reason: string): VoiceTerminalReplyRecord {
    parse(identity, reason)
    const record = this.require(requestId)
    if (preSend.has(record.phase) || inFlight.has(record.phase)) {
      record.phase = 'unknown'; record.errorCode = reason
    }
    return copy(record)
  }
  fail(requestId: string, reason: string): VoiceTerminalReplyRecord {
    parse(identity, reason)
    const record = this.require(requestId)
    if (preSend.has(record.phase) || inFlight.has(record.phase)) {
      record.phase = preSend.has(record.phase) ? 'failed' : 'unknown'; record.errorCode = reason
    }
    return copy(record)
  }
  get(requestId: string): VoiceTerminalReplyRecord | undefined { const record = this.records.get(requestId); return record ? copy(record) : undefined }
  list(): VoiceTerminalReplyRecord[] { return [...this.records.values()].map(copy) }
  private require(requestId: string): VoiceTerminalReplyRecord { return this.records.get(requestId) ?? reject('NOT_FOUND') }
}
