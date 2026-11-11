import { expect, it, vi } from 'vitest'
import { VoiceTerminalBroker, type VoiceTerminalIO, type VoiceTerminalRequest } from '../packages/server/src/device-use/voice-terminal.js'
import type { VoiceTerminalFinalReply } from '../packages/server/src/device-use/voice-terminal-turns.js'
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
function fixture(overrides: Partial<VoiceTerminalIO> = {}, timeout = 1000) {
  const send = vi.fn(), principal = { connectionId: 'connection', deviceId: 'device', roomId: 'room' }
  const broker = new VoiceTerminalBroker({ send, transcribe: async () => 'Synthetic only', submit: async () => ({}), reply: async (_a, request) => ({ requestId: request.requestId, replyId: 'reply', final: true, text: 'Final' }), synthesize: async () => { throw new Error('unused') }, ...overrides }, { enableReplies: true, replyTimeoutMs: timeout })
  broker.register({ deviceId: 'device', roomId: 'room', allowButton: true, allowWake: false })
  const session = broker.open(principal, { protocolVersions: [1], deviceId: 'device', roomId: 'room', replyProtocolVersion: 1, audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } })
  let sequence = 0
  const packet = (payload: unknown) => broker.receive(principal, { protocolVersion: 1, deviceId: 'device', roomId: 'room', sessionId: session.sessionId, sequence: sequence++, payload })
  async function capture() {
    await packet({ type: 'status', muted: false, light: 'idle' })
    await packet({ type: 'capture-start', captureId: 'capture', trigger: 'button' })
    await packet({ type: 'audio', captureId: 'capture', audioSequence: 0, pcm: Buffer.alloc(32).toString('base64') })
    return packet({ type: 'capture-end', captureId: 'capture' })
  }
  return { broker, principal, packet, capture, send }
}
it.each(['timeout', 'stop'] as const)('does not emit a late final from a reply provider ignoring %s abort', async action => {
  let finish!: (reply: VoiceTerminalFinalReply) => void, metadata!: VoiceTerminalRequest, signal!: AbortSignal
  const f = fixture({ reply: (_admission, request, input) => { metadata = request; signal = input; return new Promise(resolve => { finish = resolve }) } }, action === 'timeout' ? 10 : 1000)
  const result = await f.capture(); expect(result.state).toBe('submitted'); await tick()
  if (action === 'timeout') await tick(20)
  else await f.packet({ type: 'stop-playback' })
  expect(signal.aborted).toBe(true)
  finish({ requestId: metadata.requestId, replyId: 'late-reply', final: true, text: 'Must never be emitted' }); await tick()
  expect(f.send.mock.calls.some(([, packet]) => packet.type === 'final-reply' || packet.type === 'playback')).toBe(false)
  f.broker.close(f.principal); expect(f.broker.closeReplies().pendingCallbacks).toBe(0)
})
it('counts an uncooperative ASR callback even without Host diagnostics', async () => {
  let finish!: (text: string) => void
  const f = fixture({ transcribe: () => new Promise(resolve => { finish = resolve }) })
  const capture = f.capture(); await tick()
  f.broker.close(f.principal); expect(f.broker.closeReplies().pendingCallbacks).toBe(1)
  expect((await capture).state).toBe('discarded')
  finish('late'); await tick(); expect(f.broker.closeReplies().pendingCallbacks).toBe(0)
})

it('never reports submitted when stop interrupts an admission without a receipt', async () => {
  let finish!: (receipt: unknown) => void
  const submit = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const f = fixture({ submit })
  const capture = f.capture(); await tick(); expect(submit).toHaveBeenCalledTimes(1)
  await f.packet({ type: 'stop-playback' })
  expect((await capture).state).toBe('unknown')
  expect(f.broker.replySnapshot()[0]).toMatchObject({ phase: 'superseded' })
  expect(f.broker.replySnapshot()[0]?.admissionConfirmed).not.toBe(true)
  finish({ accepted: true }); await tick()
  expect(f.broker.replySnapshot()[0]?.admissionConfirmed).not.toBe(true)
  f.broker.close(f.principal); expect(f.broker.closeReplies().pendingCallbacks).toBe(0)
})

it('keeps the ordinary H5 request ID within its bound for maximum-length capture IDs', async () => {
  const submit = vi.fn(async () => ({})), f = fixture({ submit })
  const captureId = 'c'.repeat(128)
  await f.packet({ type: 'status', muted: false, light: 'idle' })
  await f.packet({ type: 'capture-start', captureId, trigger: 'button' })
  await f.packet({ type: 'audio', captureId, audioSequence: 0, pcm: Buffer.alloc(32).toString('base64') })
  const receipt = await f.packet({ type: 'capture-end', captureId })
  expect(receipt.state).toBe('submitted')
  expect(receipt.requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
  expect((submit.mock.calls as unknown as [string, VoiceTerminalRequest][])[0]?.[1].captureId).toBe(captureId)
  await tick(); f.broker.close(f.principal); f.broker.closeReplies()
})
