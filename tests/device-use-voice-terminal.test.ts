import { expect, it, vi } from 'vitest'
import { VoiceTerminalBroker, voiceTerminalHostIO } from '../packages/server/src/device-use/voice-terminal.js'
const principal = { connectionId: 'transport-one', deviceId: 'room-mic', roomId: 'living-room' }
const hello = { protocolVersions: [1], deviceId: principal.deviceId, roomId: principal.roomId, audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } }
function setup(options = {}) {
  const send = vi.fn(), transcribe = vi.fn(async () => '把灯调到30%'), submit = vi.fn(async () => ({ runId: 'run-one' }))
  const broker = new VoiceTerminalBroker({ send, transcribe, submit }, options)
  broker.register({ ...principal, allowButton: true, allowWake: false })
  const session = broker.open(principal, hello)
  let sequence = 0
  const packet = (payload: unknown, seq = sequence++) => ({ protocolVersion: 1, deviceId: principal.deviceId, roomId: principal.roomId, sessionId: session.sessionId, sequence: seq, payload })
  const receive = (payload: unknown) => broker.receive(principal, packet(payload))
  const unmute = () => receive({ type: 'status', muted: false, light: 'idle' })
  const start = () => receive({ type: 'capture-start', captureId: 'turn-one', trigger: 'button' })
  const audio = () => receive({ type: 'audio', captureId: 'turn-one', audioSequence: 0, pcm: Buffer.alloc(3200).toString('base64') })
  const end = () => receive({ type: 'capture-end', captureId: 'turn-one' })
  return { broker, send, transcribe, submit, session, packet, receive, unmute, start, audio, end }
}
it('requires explicit enrollment, authenticated identity, matching room and supported protocol', () => {
  const f = setup()
  expect(() => f.broker.open({ ...principal, deviceId: 'other' }, hello)).toThrow('UNAUTHORIZED')
  expect(() => f.broker.open({ ...principal, roomId: 'bedroom' }, hello)).toThrow('UNAUTHORIZED')
  expect(() => f.broker.open(principal, { ...hello, protocolVersions: [2] })).toThrow()
  expect(() => f.broker.open(principal, hello)).toThrow('ALREADY_CONNECTED')
  expect(f.broker.snapshot()[0]).toMatchObject({ reportedMuted: true, physicalMuteVerified: false })
})
it('starts private, distinguishes button and wake grants, submits one bounded WAV via normal admission', async () => {
  const f = setup()
  await expect(f.start()).rejects.toThrow('CAPTURE_FORBIDDEN')
  await f.unmute()
  await expect(f.receive({ type: 'capture-start', captureId: 'wake', trigger: 'wake' })).rejects.toThrow('CAPTURE_FORBIDDEN')
  await f.start(); await f.audio(); const result = await f.end()
  expect(result.state).toBe('submitted'); expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]?.[0]).toBe('把灯调到30%')
  expect(Buffer.from(f.transcribe.mock.calls[0]![0], 'base64').toString('ascii', 0, 4)).toBe('RIFF')
  expect(f.submit.mock.calls[0]?.[1]).toMatchObject({ deviceId: principal.deviceId, roomId: principal.roomId, requestId: expect.stringMatching(/^voice-terminal-/) })
  await expect(f.start()).rejects.toThrow('CAPTURE_REPLAY')
})
it('deduplicates packet retries and invalidates a recording across out-of-order frames', async () => {
  const f = setup(); await f.unmute(); await f.start()
  const frame = f.packet({ type: 'audio', captureId: 'turn-one', audioSequence: 0, pcm: 'AAA=' })
  expect(await f.broker.receive(principal, frame)).toEqual({ state: 'accepted' })
  expect(await f.broker.receive(principal, frame)).toEqual({ state: 'duplicate' })
  expect(await f.broker.receive(principal, { ...frame, sequence: 99 })).toEqual({ state: 'resync-required' })
  expect(await f.end()).toEqual({ state: 'discarded' }); expect(f.transcribe).not.toHaveBeenCalled()
})
it.each(['mute', 'disconnect', 'revoke', 'new-turn'])('drops late ASR after %s and never cancels a submitted device task', async action => {
  const f = setup(); await f.unmute(); await f.start(); await f.audio()
  let resolve!: (text: string) => void
  f.transcribe.mockImplementation(() => new Promise(done => { resolve = done }))
  const ending = f.end(); await vi.waitFor(() => expect(f.transcribe).toHaveBeenCalledOnce())
  if (action === 'mute') await f.receive({ type: 'status', muted: true, light: 'muted' })
  if (action === 'disconnect') f.broker.close(principal)
  if (action === 'revoke') f.broker.revoke(principal.deviceId)
  if (action === 'new-turn') await f.receive({ type: 'capture-start', captureId: 'new-turn', trigger: 'button' })
  resolve('迟到的开灯指令'); expect((await ending).state).toBe('discarded'); expect(f.submit).not.toHaveBeenCalled()
})
it('gives a reconnect a fresh session, rejects old audio and never replays prior commands or output', async () => {
  const f = setup(); await f.unmute(); await f.start(); await f.audio(); await f.end()
  const stale = f.packet({ type: 'heartbeat' }); f.broker.close(principal)
  const reopened = f.broker.open(principal, hello); expect(reopened.sessionId).not.toBe(f.session.sessionId)
  await expect(f.broker.receive(principal, stale)).rejects.toThrow('SESSION_INVALID')
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.broker.snapshot()[0]?.reportedMuted).toBe(true)
})
it('bounds recording duration, frame length, audio sequence, and heartbeat expiry', async () => {
  let now = 0; const f = setup({ now: () => now, maxCaptureMs: 1000, idleTimeoutMs: 2000 })
  await f.unmute(); await f.start(); await f.audio(); now = 1001
  expect((await f.end()).state).toBe('discarded'); expect(f.transcribe).not.toHaveBeenCalled()
  await f.receive({ type: 'capture-start', captureId: 'turn-two', trigger: 'button' })
  expect((await f.receive({ type: 'audio', captureId: 'turn-two', audioSequence: 9, pcm: 'AAA=' })).state).toBe('discarded')
  now = 4000; expect(f.broker.snapshot()).toEqual([])
})
it('reports uncertain assistant submission without retrying it', async () => {
  const f = setup(); f.submit.mockRejectedValue(new Error('transport closed after submission'))
  await f.unmute(); await f.start(); await f.audio(); expect((await f.end()).state).toBe('unknown')
  expect(f.submit).toHaveBeenCalledOnce()
})
it('separates stopping playback from capture and task execution; bounds output by observed acknowledgments', async () => {
  const f = setup(); await f.unmute()
  const play = (audioSequence: number, final = false) => f.broker.play(principal, { playbackId: 'reply-one', audioSequence, audio: 'AAA=', final })
  expect(play(0)).toEqual({ state: 'sent' }); play(1)
  expect(() => play(2)).toThrow('BACKPRESSURE')
  await f.receive({ type: 'playback-ack', playbackId: 'reply-one', audioSequence: 0 }); play(2, true)
  expect(f.broker.snapshot()[0]?.playbackPending).toBe(2)
  await f.receive({ type: 'stop-playback' }); expect(f.broker.snapshot()[0]?.playbackPending).toBe(0)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.send).toHaveBeenLastCalledWith(principal, expect.objectContaining({ type: 'stop-playback' }))
})
it('adapts ASR and admission using the existing safe routes and contains no hardware command passthrough', async () => {
  const request = vi.fn(async () => ({ text: '你好' })), io = voiceTerminalHostIO(request, vi.fn())
  const metadata = { ...principal, sessionId: 'session', captureId: 'turn', requestId: 'voice-terminal-fixture' }
  expect(await io.transcribe('wav', metadata)).toBe('你好'); await io.submit('开灯', metadata)
  expect(request.mock.calls[0]?.[0]).toBe('/api/voice/transcribe')
  expect(request.mock.calls[1]?.[0]).toBe('/api/assistant/messages')
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ text: '开灯', requestId: metadata.requestId, delivery: 'immediate', inputMode: 'voice' })
})

it('aborts a timed-out transcription, waits for actual callback settlement and permits a fresh turn', async () => {
 vi.useFakeTimers()
 try {
  const f = setup({ transcriptionTimeoutMs: 100, idleTimeoutMs: 10000 })
  let signal!: AbortSignal
  f.transcribe.mockImplementation((_audio: string, _request: unknown, abort: AbortSignal) => {
   signal = abort
   return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }))
  })
  await f.unmute(); await f.start(); await f.audio(); const ending = f.end()
  await vi.advanceTimersByTimeAsync(101)
  expect(await ending).toMatchObject({ state: 'discarded' }); expect(signal.aborted).toBe(true)
  expect(f.send).toHaveBeenCalledWith(principal, expect.objectContaining({ type: 'capture-error', error: 'VOICE_TERMINAL_TRANSCRIBE_TIMEOUT' }))
  expect(f.broker.snapshot()[0]).toMatchObject({ transcriptionPending: 0, transcriptionQuarantined: 0, transcriptionUnavailable: false })
  f.transcribe.mockResolvedValue('fresh command')
  await f.receive({ type: 'capture-start', captureId: 'fresh', trigger: 'button' })
  await f.receive({ type: 'audio', captureId: 'fresh', audioSequence: 0, pcm: 'AAA=' })
  expect(await f.receive({ type: 'capture-end', captureId: 'fresh' })).toMatchObject({ state: 'submitted' })
  expect(f.submit).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
 } finally { vi.useRealTimers() }
})
it('quarantines uncooperative ASR within four real slots and reports unavailable instead of creating more work', async () => {
 vi.useFakeTimers()
 try {
  const f = setup({ transcriptionTimeoutMs: 100, idleTimeoutMs: 10000 }), finishes: Array<(text: string) => void> = [], signals: AbortSignal[] = [], endings: Promise<unknown>[] = []
  f.transcribe.mockImplementation((_audio: string, _request: unknown, signal: AbortSignal) => new Promise(resolve => { finishes.push(resolve); signals.push(signal) }))
  await f.unmute()
  const capture = async (captureId: string) => {
   await f.receive({ type: 'capture-start', captureId, trigger: 'button' })
   await f.receive({ type: 'audio', captureId, audioSequence: 0, pcm: 'AAA=' })
   return f.receive({ type: 'capture-end', captureId })
  }
  // Do not await completion: newer captures cancel waiting, not the underlying ASR.
  for (let i = 0; i < 4; i++) { endings.push(capture(`hung-${i}`)); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  await vi.advanceTimersByTimeAsync(101); expect(await Promise.all(endings)).toEqual(Array(4).fill(expect.objectContaining({ state: 'discarded' })))
  expect(signals).toHaveLength(4); expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(f.broker.snapshot()[0]).toMatchObject({ transcriptionPending: 4, transcriptionQuarantined: 4, transcriptionUnavailable: true })
  expect(await capture('fifth')).toMatchObject({ state: 'discarded' }); expect(f.transcribe).toHaveBeenCalledTimes(4)
  expect(f.send).toHaveBeenCalledWith(principal, expect.objectContaining({ type: 'capture-error', error: 'VOICE_TERMINAL_ASR_UNAVAILABLE' }))
  finishes[0]!('late instruction'); await Promise.resolve()
  expect(f.broker.snapshot()[0]?.transcriptionPending).toBe(3); expect(f.submit).not.toHaveBeenCalled()
  f.transcribe.mockResolvedValueOnce('fresh instruction'); expect(await capture('fresh')).toMatchObject({ state: 'submitted' })
  finishes.slice(1).forEach(finish => finish('late instruction')); await Promise.resolve()
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.submit.mock.calls[0]?.[0]).toBe('fresh instruction')
  expect(f.broker.snapshot()[0]?.transcriptionPending).toBe(0); expect(vi.getTimerCount()).toBe(0)
 } finally { vi.useRealTimers() }
})
it('cancels waiting on disconnect immediately but retains the old underlying ASR across reconnect', async () => {
 const f = setup(); let finish!: (text: string) => void, signal!: AbortSignal
 f.transcribe.mockImplementation((_audio: string, _request: unknown, abort: AbortSignal) => { signal = abort; return new Promise(resolve => { finish = resolve }) })
 await f.unmute(); await f.start(); await f.audio(); const ending = f.end()
 f.broker.close(principal); expect(signal.aborted).toBe(true); expect(await ending).toMatchObject({ state: 'discarded' })
 f.broker.open(principal, hello)
 expect(f.broker.snapshot()[0]).toMatchObject({ transcriptionPending: 1, transcriptionQuarantined: 1 })
 finish('late instruction'); await Promise.resolve(); expect(f.submit).not.toHaveBeenCalled()
 expect(f.broker.snapshot()[0]?.transcriptionPending).toBe(0)
})
it('forwards cancellation to the host ASR adapter, not the already accepted assistant submission', async () => {
 const request = vi.fn(async () => ({ text: '你好' })), io = voiceTerminalHostIO(request, vi.fn()), abort = new AbortController()
 const metadata = { ...principal, sessionId: 'session', captureId: 'turn', requestId: 'fixture' }
 await io.transcribe('wav', metadata, abort.signal); await io.submit('hello', metadata)
 expect(request.mock.calls[0]?.[1]).toMatchObject({ signal: abort.signal })
 expect(request.mock.calls[1]?.[1]).not.toHaveProperty('signal')
})
it.each([0, -1, Infinity, 180001])('rejects invalid ASR timeout %s', transcriptionTimeoutMs => {
 expect(() => setup({ transcriptionTimeoutMs })).toThrow('VOICE_TERMINAL_LIMIT_INVALID')
})

it('handles a late rejection after cancellation without an unhandled rejection or submission', async () => {
 const f = setup(); let reject!: (error: Error) => void
 f.transcribe.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
 await f.unmute(); await f.start(); await f.audio(); const ending = f.end()
 await f.receive({ type: 'status', muted: true, light: 'muted' }); expect(await ending).toMatchObject({ state: 'discarded' })
 expect(f.broker.snapshot()[0]?.transcriptionQuarantined).toBe(1)
 reject(new Error('late callback failure')); await Promise.resolve()
 expect(f.broker.snapshot()[0]?.transcriptionPending).toBe(0); expect(f.submit).not.toHaveBeenCalled()
})
