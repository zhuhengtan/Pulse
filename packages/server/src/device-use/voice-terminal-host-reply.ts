import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { VoiceTerminalIO, VoiceTerminalRequest } from './voice-terminal.js'
import { voiceTerminalFinalReplySchema, type VoiceTerminalFinalReply } from './voice-terminal-turns.js'

export type VoiceTerminalHostRequest = (path: string, init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal }) => Promise<unknown>
export interface VoiceTerminalSpeech { requestId: string; replyId: string; chunks: { audio: string; mime: 'audio/wav' }[] }
export interface VoiceTerminalReplyHostIO extends VoiceTerminalIO {
  reply?(admission: unknown, metadata: VoiceTerminalRequest, signal: AbortSignal): Promise<VoiceTerminalFinalReply>
  synthesize?(reply: VoiceTerminalFinalReply, metadata: VoiceTerminalRequest, signal: AbortSignal): Promise<VoiceTerminalSpeech>
  diagnostics(): { active: number; quarantined: number }
}
const receiptSchema = z.object({ messageId: z.string(), runId: z.string().min(1), state: z.string() })
const viewSchema = z.object({ receipts: z.array(receiptSchema), messages: z.array(z.object({ id: z.string().min(1), role: z.string(), text: z.string(), runId: z.string().optional(), replyToId: z.string().optional(), messageKind: z.string().optional() })) })
function check(signal: AbortSignal): void { if (signal.aborted) throw new Error('VOICE_TERMINAL_ABORTED') }
function bounded<T>(actual: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  check(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new Error('VOICE_TERMINAL_ABORTED')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('VOICE_TERMINAL_HOST_TIMEOUT')) }, ms)
    signal.addEventListener('abort', abort, { once: true })
    actual.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  check(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('VOICE_TERMINAL_ABORTED')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** No network client, credentials or terminal-supplied principal. Callback is trusted Host transport. */
export function createVoiceTerminalReplyHostIO(request: VoiceTerminalHostRequest, send: VoiceTerminalIO['send'], options: { enabled?: boolean; pollIntervalMs?: number; requestTimeoutMs?: number } = {}): VoiceTerminalReplyHostIO {
  const timeout = options.requestTimeoutMs ?? 30000, interval = options.pollIntervalMs ?? 250
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30000 || !Number.isFinite(interval) || interval < 1 || interval > 10000) throw new Error('VOICE_TERMINAL_LIMIT_INVALID')
  const active = new Set<{ quarantined: boolean }>()
  async function invoke(path: '/api/assistant' | '/api/voice/transcribe' | '/api/assistant/messages' | '/api/voice/speech', init: { method: 'GET' | 'POST'; body?: string }, signal = new AbortController().signal): Promise<unknown> {
    check(signal)
    if (active.size >= 4) throw new Error('VOICE_TERMINAL_HOST_CAPACITY')
    const entry = { quarantined: false }; active.add(entry)
    let actual: Promise<unknown>
    try { actual = Promise.resolve(request(path, { ...init, signal })) } catch (error) { active.delete(entry); throw error }
    // Local timeout/abort cannot prove a Host request stopped. Only actual settlement releases capacity.
    actual.then(() => active.delete(entry), () => active.delete(entry))
    try { const value = await bounded(actual, signal, timeout); check(signal); return value }
    catch (error) { if (active.has(entry)) entry.quarantined = true; throw error }
  }
  const base: VoiceTerminalReplyHostIO = {
    send,
    diagnostics: () => ({ active: active.size, quarantined: [...active].filter(e => e.quarantined).length }),
    async transcribe(audio, _metadata, signal) {
      const result = z.object({ text: z.string() }).parse(await invoke('/api/voice/transcribe', { method: 'POST', body: JSON.stringify({ audio }) }, signal))
      return result.text
    },
    submit(text, metadata) { return invoke('/api/assistant/messages', { method: 'POST', body: JSON.stringify({ text, requestId: metadata.requestId, delivery: 'immediate', inputMode: 'voice' }) }) },
  }
  if (options.enabled !== true) return base
  return { ...base,
    async reply(admission, metadata, signal) {
      check(signal)
      const receipt = receiptSchema.parse(admission)
      if (receipt.messageId !== metadata.requestId) throw new Error('VOICE_TERMINAL_RECEIPT_MISMATCH')
      if (['failed', 'interrupted', 'cancelled'].includes(receipt.state)) throw new Error('VOICE_TERMINAL_RUN_FAILED')
      for (;;) {
        const view = viewSchema.parse(await invoke('/api/assistant', { method: 'GET' }, signal))
        const receipts = view.receipts.filter(r => r.messageId === metadata.requestId)
        if (receipts.some(r => r.runId !== receipt.runId)) throw new Error('VOICE_TERMINAL_RUN_CHANGED')
        if (receipts.some(r => ['failed', 'interrupted', 'cancelled'].includes(r.state))) throw new Error('VOICE_TERMINAL_RUN_FAILED')
        if (receipts.some(r => r.state === 'completed')) {
          const messages = view.messages.filter(m => m.role === 'assistant' && m.messageKind !== 'pre_reply' && m.replyToId === `msg-${metadata.requestId}` && m.runId === receipt.runId)
          const text = messages.map(m => m.text).join('\n')
          if (!messages.length || !text.trim() || text.length > 20000) throw new Error('VOICE_TERMINAL_FINAL_INVALID')
          return voiceTerminalFinalReplySchema.parse({ requestId: metadata.requestId, replyId: `reply-${createHash('sha256').update(JSON.stringify(messages.map(m => m.id))).digest('hex')}`, final: true, text })
        }
        await delay(interval, signal)
      }
    },
    async synthesize(raw, metadata, signal) {
      check(signal)
      const reply = voiceTerminalFinalReplySchema.parse(raw)
      if (reply.requestId !== metadata.requestId || !/^reply-[a-f0-9]{64}$/.test(reply.replyId) || !reply.text.trim() || reply.text.length > 12000) throw new Error('VOICE_TERMINAL_FINAL_INVALID')
      const pieces: string[] = []; let rest = reply.text
      while (rest.length) {
        let end = Math.min(rest.length, 600)
        if (end < rest.length) {
          const last = [...rest.slice(0, end).matchAll(/[.!?。！？\n]\s*/g)].at(-1)
          if (last) end = last.index + last[0].length
          if (/^[\uDC00-\uDFFF]$/.test(rest[end] ?? '')) end--
        }
        pieces.push(rest.slice(0, end)); rest = rest.slice(end)
      }
      if (pieces.length > 32) throw new Error('VOICE_TERMINAL_CHUNK_LIMIT')
      const chunks: { audio: string; mime: 'audio/wav' }[] = []; let total = 0
      for (const text of pieces) {
        const result = z.object({ mime: z.literal('audio/wav'), audio: z.string().min(1).max(1500000) }).parse(await invoke('/api/voice/speech', { method: 'POST', body: JSON.stringify({ text }) }, signal))
        const audio = result.audio
        if (audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) throw new Error('VOICE_TERMINAL_AUDIO_INVALID')
        const bytes = Buffer.from(audio, 'base64')
        if (bytes.toString('base64') !== audio || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VOICE_TERMINAL_WAV_INVALID')
        total += audio.length
        if (total > 12000000) throw new Error('VOICE_TERMINAL_AUDIO_LIMIT')
        chunks.push({ audio, mime: 'audio/wav' })
      }
      check(signal)
      return { requestId: metadata.requestId, replyId: reply.replyId, chunks }
    },
  }
}
