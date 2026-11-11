import { describe, expect, it, vi } from 'vitest'
import { VoiceTerminalReplyCoordinator, type VoiceTerminalReplyIO } from '../packages/server/src/device-use/voice-terminal-replies.js'
const origin = { deviceId: 'd', roomId: 'r', sessionId: 's', captureId: 'c', requestId: 'q', generation: 1 }
const reply = { requestId: 'q', replyId: 'reply', final: true as const, text: 'Hi' }
const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8)
function fixture(extra: Partial<VoiceTerminalReplyIO> = {}) {
  const send = vi.fn()
  const io: VoiceTerminalReplyIO = { submit: async () => ({}), reply: async () => reply, synthesize: async () => ({ requestId: 'q', replyId: 'reply', chunks: Array.from({ length: 3 }, () => ({ audio: wav.toString('base64'), mime: 'audio/wav' as const })) }), isCurrent: () => true, send, ...extra }
  const coordinator = new VoiceTerminalReplyCoordinator(io, { enabled: true })
  return { io, send, coordinator }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
describe('reply coordinator', () => {
  it('defaults off', async () => { const f = fixture(); await expect(new VoiceTerminalReplyCoordinator(f.io).submit('hi', origin)).rejects.toThrow('VOICE_TERMINAL_DISABLED'); f.coordinator.close() })
  it('returns admission without waiting for reply and streams within window two', async () => {
    const f = fixture(); await f.coordinator.submit('hi', origin); await tick()
    expect(f.send).toHaveBeenCalledTimes(2)
    const id = f.coordinator.get('q')!.playbackId!
    f.coordinator.acknowledgeChunk(origin, id, 0); expect(f.send).toHaveBeenCalledTimes(3)
    const report = (stage: 'started' | 'completed') => f.coordinator.report(origin, { requestId: 'q', replyId: 'reply', playbackId: id, stage })
    report('started'); expect(() => report('completed')).toThrow('VOICE_TERMINAL_CHUNKS_PENDING')
    f.coordinator.acknowledgeChunk(origin, id, 1); f.coordinator.acknowledgeChunk(origin, id, 2); report('completed')
    expect(f.coordinator.get('q')?.phase).toBe('completed'); f.coordinator.close()
  })
  it('quarantines an uncooperative callback honestly on close', async () => {
    let resolve!: (value: typeof reply) => void
    const f = fixture({ reply: () => new Promise(done => { resolve = done }) })
    await f.coordinator.submit('hi', origin); await tick()
    expect(f.coordinator.close().pendingCallbacks).toBe(1)
    resolve(reply); await tick(); expect(f.send).not.toHaveBeenCalled(); expect(f.coordinator.get('q')?.phase).toBe('unknown')
  })
  it('keeps uncertain submit and send outcomes non-replayable', async () => {
    const f = fixture({ submit: async () => { throw new Error('lost receipt') } })
    expect((await f.coordinator.submit('hi', origin)).phase).toBe('unknown')
    await expect(f.coordinator.submit('hi', origin)).rejects.toThrow('VOICE_TERMINAL_DUPLICATE'); f.coordinator.close()
    const g = fixture({ send: () => { throw new Error('lost socket') } }); await g.coordinator.submit('hi', origin); await tick()
    expect(g.coordinator.get('q')?.phase).toBe('unknown'); g.coordinator.close()
  })
})
it('accepts WAV chunk boundary and rejects oversize, aggregate overflow, and noncanonical base64', async () => {
  const bytes = Buffer.alloc(1_125_000); bytes.write('RIFF'); bytes.write('WAVE', 8)
  const audio = bytes.toString('base64')
  for (const [chunks, phase] of [
    [[audio], 'sent'],
    [[audio + 'AAAA'], 'failed'],
    [Array(9).fill(audio), 'failed'],
    [[wav.toString('base64').slice(0, -2) + 'B='], 'failed'],
  ] as const) {
    const f = fixture({ synthesize: async () => ({ requestId: 'q', replyId: 'reply', chunks: chunks.map(audio => ({ audio, mime: 'audio/wav' })) }) })
    await f.coordinator.submit('hi', origin); await tick()
    expect(f.coordinator.get('q')?.phase).toBe(phase); f.coordinator.close()
  }
})
it('aborts invalidated session callbacks without claiming they settled', async () => {
  let signal!: AbortSignal
  let finish!: (value: typeof reply) => void
  const f = fixture({ reply: (_admission, _origin, input) => { signal = input; return new Promise(resolve => { finish = resolve }) } })
  await f.coordinator.submit('hi', origin); await tick()
  f.coordinator.invalidateSession('s', 'VOICE_TERMINAL_NEW_TURN')
  expect(signal.aborted).toBe(true); expect(f.coordinator.close().pendingCallbacks).toBe(1)
  finish(reply); await tick(); expect(f.send).not.toHaveBeenCalled()
})
it('sends best-effort stop on invalidation without pretending playback completed', async () => {
  const stop = vi.fn(), f = fixture({ stop })
  await f.coordinator.submit('hi', origin); await tick(); f.coordinator.invalidateSession('s', 'VOICE_TERMINAL_NEW_TURN')
  expect(stop).toHaveBeenCalledWith(origin); expect(f.coordinator.get('q')?.phase).toBe('unknown'); f.coordinator.close()
})
it('does not confirm admission when pending submit is invalidated, even if provider later resolves', async () => {
  let settle!: (value: unknown) => void
  const submit = vi.fn(() => new Promise(resolve => { settle = resolve }))
  const f = fixture({ submit })
  const pending = f.coordinator.submit('hi', origin)
  await tick()
  f.coordinator.invalidateSession('s', 'VOICE_TERMINAL_MUTED')
  const record = await pending
  expect(record.phase).toBe('superseded'); expect(record.admissionConfirmed).not.toBe(true)
  settle({ accepted: true }); await tick()
  expect(f.coordinator.get('q')?.admissionConfirmed).not.toBe(true)
  await expect(f.coordinator.submit('hi', origin)).rejects.toThrow('VOICE_TERMINAL_DUPLICATE')
  expect(submit).toHaveBeenCalledTimes(1); f.coordinator.close()
})
it('records an observed submission receipt independently of reply outcome', async () => {
  const f = fixture({ reply: async () => { throw new Error('no reply') } })
  expect((await f.coordinator.submit('hi', origin)).admissionConfirmed).toBe(true)
  await tick(); expect(f.coordinator.get('q')?.admissionConfirmed).toBe(true); f.coordinator.close()
})
