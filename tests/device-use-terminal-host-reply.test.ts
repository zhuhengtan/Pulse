import { expect, it, vi } from 'vitest'
import { createVoiceTerminalReplyHostIO as create } from '../packages/server/src/device-use/voice-terminal-host-reply.js'
const metadata = { requestId: 'r', deviceId: 'd', roomId: 'room', sessionId: 'session', captureId: 'capture' }
const admission = { messageId: 'r', runId: 'run', state: 'queued' }
const signal = () => new AbortController().signal
const options = { enabled: true, pollIntervalMs: 1 }
const message = { id: 'final', role: 'assistant', text: 'Hello.', runId: 'run', replyToId: 'msg-r' }
const snapshot = (state = 'completed') => ({ receipts: [{ ...admission, state }], messages: [message] })
const final = (text = 'Hello.') => ({ requestId: 'r', replyId: `reply-${'a'.repeat(64)}`, final: true as const, text })
const wav = (size = 44) => { const b = Buffer.alloc(size); b.write('RIFF'); b.write('WAVE', 8); return b.toString('base64') }
it('defaults off and sends only the verified Host payloads', async () => {
  const request = vi.fn(async (path: string) => path.includes('transcribe') ? { text: 'heard' } : admission)
  const send = vi.fn(), io = create(request, send)
  expect(io.reply).toBeUndefined(); expect(io.synthesize).toBeUndefined(); expect(io.send).toBe(send)
  expect(await io.transcribe('wav', metadata)).toBe('heard'); expect(await io.submit('heard', metadata)).toEqual(admission)
  expect(request.mock.calls.map(c => c[0])).toEqual(['/api/voice/transcribe', '/api/assistant/messages'])
  const calls = (request.mock.calls as unknown as [string, { body: string }][])
  expect(JSON.parse(calls[0]![1].body)).toEqual({ audio: 'wav' })
  expect(JSON.parse(calls[1]![1].body)).toEqual({ text: 'heard', requestId: 'r', delivery: 'immediate', inputMode: 'voice' })
})
it('flat submit receipt flows through queued to exact final and stable reply ID', async () => {
  let gets = 0
  const io = create(async (_path, init) => {
    if (init.method === 'POST') return admission
    const view = snapshot(++gets === 1 ? 'queued' : 'completed')
    return { ...view, messages: [message, ...[{ role: 'user' }, { runId: 'other' }, { replyToId: 'msg-other' }, { messageKind: 'pre_reply' }].map(p => ({ ...message, id: 'noise', text: 'bad', ...p }))] }
  }, vi.fn(), options)
  const receipt = await io.submit('hello', metadata), a = await io.reply!(receipt, metadata, signal()), b = await io.reply!(receipt, metadata, signal())
  expect(a.text).toBe('Hello.'); expect(a.replyId).toBe(b.replyId)
})
it('fails closed for wrong request/run, missing exact final and failed receipts', async () => {
  const io = create(async () => snapshot(), vi.fn(), options)
  await expect(io.reply!({ ...admission, messageId: 'wrong' }, metadata, signal())).rejects.toThrow('MISMATCH')
  for (const view of [ { ...snapshot(), receipts: [{ ...admission, runId: 'wrong' }] }, ...['failed', 'interrupted', 'cancelled'].map(snapshot), { ...snapshot(), messages: [{ ...message, runId: 'wrong' }] } ]) {
    const adapter = create(async () => view, vi.fn(), options)
    await expect(adapter.reply!(admission, metadata, signal())).rejects.toThrow()
  }
})
it('aborts a callback ignoring signal and quarantines until actual settlement', async () => {
  let release!: (v: unknown) => void
  const io = create(() => new Promise(resolve => { release = resolve }), vi.fn(), options), c = new AbortController()
  const promise = io.reply!(admission, metadata, c.signal); c.abort()
  await expect(promise).rejects.toThrow('ABORTED'); expect(io.diagnostics()).toEqual({ active: 1, quarantined: 1 })
  release(snapshot()); await Promise.resolve(); expect(io.diagnostics().active).toBe(0)
})
it('limits timed-out uncooperative callbacks to four without retrying submissions', async () => {
  const releases: ((v: unknown) => void)[] = [], request = vi.fn(() => new Promise(resolve => releases.push(resolve)))
  const io = create(request, vi.fn(), { ...options, requestTimeoutMs: 2 })
  for (let i = 0; i < 4; i++) await expect(io.submit('hello', metadata)).rejects.toThrow('TIMEOUT')
  expect(io.diagnostics()).toEqual({ active: 4, quarantined: 4 })
  await expect(io.reply!(admission, metadata, signal())).rejects.toThrow('CAPACITY'); expect(request).toHaveBeenCalledTimes(4)
  releases[0]!(admission); await Promise.resolve(); expect(io.diagnostics().active).toBe(3)
  await expect(io.submit('hello', metadata)).rejects.toThrow('TIMEOUT'); expect(request).toHaveBeenCalledTimes(5)
  releases.slice(1).forEach(r => r(admission)); await Promise.resolve(); expect(io.diagnostics().active).toBe(0)
})
it('validates WAV, canonical base64, mime and per-chunk limits', async () => {
  for (const response of [{ mime: 'audio/mp3', audio: wav() }, { mime: 'audio/wav', audio: wav(43) }, { mime: 'audio/wav', audio: wav() + '\n' }, { mime: 'audio/wav', audio: 'AB==' }, { mime: 'audio/wav', audio: wav(1125001) }, { mime: 'audio/wav', audio: Buffer.alloc(44).toString('base64') }]) {
    const io = create(async () => response, vi.fn(), options)
    await expect(io.synthesize!(final(), metadata, signal())).rejects.toThrow()
  }
})
it('accepts exact audio bounds and rejects excess total/text', async () => {
  const request = vi.fn(async (_path: string, init: { body?: string }) => { expect(JSON.parse(init.body!).text.length).toBeLessThanOrEqual(600); return { mime: 'audio/wav', audio: wav(1125000) } })
  const io = create(request, vi.fn(), options)
  const result = await io.synthesize!(final('x'.repeat(4800)), metadata, signal())
  expect(result.chunks).toHaveLength(8); expect(result.chunks[0]?.mime).toBe('audio/wav'); expect(result.requestId).toBe('r')
  await expect(io.synthesize!(final('x'.repeat(5400)), metadata, signal())).rejects.toThrow('AUDIO_LIMIT')
  await expect(io.synthesize!(final('x'.repeat(12001)), metadata, signal())).rejects.toThrow('FINAL_INVALID')
})
it('does not issue the next speech chunk after abort', async () => {
  const c = new AbortController(), request = vi.fn(async () => { c.abort(); return { mime: 'audio/wav', audio: wav() } })
  const io = create(request, vi.fn(), options)
  await expect(io.synthesize!(final('x'.repeat(601)), metadata, c.signal)).rejects.toThrow('ABORTED'); expect(request).toHaveBeenCalledTimes(1)
})
