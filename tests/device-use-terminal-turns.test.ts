import { describe, expect, it } from 'vitest'
import { VoiceTerminalReplyLedger } from '../packages/server/src/device-use/voice-terminal-turns.js'
const origin = { deviceId: 'd', roomId: 'r', sessionId: 's', captureId: 'c', requestId: 'q', generation: 1 }
function setup(chunks = 2) {
  const ledger = new VoiceTerminalReplyLedger()
  ledger.accept(origin); ledger.finalReply('q', { requestId: 'q', replyId: 'reply', final: true, text: 'Hello' }); ledger.synthesizing('q'); ledger.sent('q', 'reply', 'play', chunks)
  const report = (stage: 'received' | 'started' | 'completed' | 'error') => ledger.report({ requestId: 'q', replyId: 'reply', playbackId: 'play', stage })
  return { ledger, report }
}
describe('terminal reply ledger', () => {
  it('streams after first ACK but only completes after every ordered ACK', () => {
    const { ledger, report } = setup()
    expect(() => report('started')).toThrow('VOICE_TERMINAL_STATE')
    expect(() => report('received')).toThrow('VOICE_TERMINAL_CHUNKS_PENDING')
    expect(() => ledger.acknowledgeChunk('q', 'play', 1)).toThrow('VOICE_TERMINAL_ACK_ORDER')
    ledger.acknowledgeChunk('q', 'play', 0); report('received'); report('started'); report('started')
    expect(() => report('completed')).toThrow('VOICE_TERMINAL_CHUNKS_PENDING')
    ledger.acknowledgeChunk('q', 'play', 0); expect(ledger.get('q')?.ackCount).toBe(1)
    ledger.acknowledgeChunk('q', 'play', 1); report('completed'); report('completed')
    ledger.invalidateSession('s', 'disconnect'); ledger.fail('q', 'late'); expect(ledger.get('q')?.phase).toBe('completed')
    expect(() => report('started')).toThrow('VOICE_TERMINAL_STATE')
  })
  it('never replays unknown results or accepts mismatched receipts', () => {
    const { ledger, report } = setup()
    expect(() => ledger.acknowledgeChunk('q', 'wrong', 0)).toThrow('VOICE_TERMINAL_CORRELATION')
    ledger.invalidateSession('s', 'disconnect'); expect(ledger.get('q')?.phase).toBe('unknown')
    expect(() => report('error')).toThrow('VOICE_TERMINAL_STATE')
    expect(() => ledger.sent('q', 'reply', 'play', 2)).toThrow('VOICE_TERMINAL_STATE')
  })
  it('validates final replies once and isolates caller mutations', () => {
    const ledger = new VoiceTerminalReplyLedger(); ledger.accept(origin)
    expect(() => ledger.finalReply('q', { requestId: 'wrong', replyId: 'reply', final: true, text: 'Hi' })).toThrow('VOICE_TERMINAL_CORRELATION')
    expect(() => ledger.finalReply('q', { requestId: 'q', replyId: 'reply', final: true, text: 'x'.repeat(20001) })).toThrow('VOICE_TERMINAL_INVALID')
    const reply = { requestId: 'q', replyId: 'reply', final: true, text: 'Hi' }; ledger.finalReply('q', reply); reply.text = 'changed'
    expect(() => ledger.finalReply('q', reply)).toThrow('VOICE_TERMINAL_STATE')
    ledger.list()[0]!.origin.deviceId = 'changed'; expect(ledger.get('q')?.origin.deviceId).toBe('d'); expect(ledger.get('q')?.reply?.text).toBe('Hi')
    ledger.invalidateSession('s', 'new-turn'); expect(ledger.get('q')?.phase).toBe('superseded')
  })
  it('bounds retention without evicting unknown records and preserves terminal errors', () => {
    const ledger = new VoiceTerminalReplyLedger({ maxRecords: 1 }); ledger.accept(origin); ledger.fail('q', 'failed')
    expect(ledger.get('q')?.phase).toBe('failed')
    expect(() => ledger.accept(origin)).toThrow('VOICE_TERMINAL_DUPLICATE')
    expect(() => ledger.accept({ ...origin, requestId: 'q2' })).toThrow('VOICE_TERMINAL_CAPACITY')
    const f = setup(); f.report('error'); f.ledger.invalidateSession('s', 'disconnect'); expect(f.ledger.get('q')?.phase).toBe('error')
    expect(() => f.report('completed')).toThrow()
  })
})

it('retains ambiguous submissions and accepts bounded long request identities', () => {
  const ledger = new VoiceTerminalReplyLedger(), requestId = 'q'.repeat(256)
  ledger.accept({ ...origin, requestId }); ledger.unknown(requestId, 'receipt-lost')
  expect(ledger.get(requestId)?.phase).toBe('unknown')
  expect(() => ledger.finalReply(requestId, { requestId, replyId: 'r', final: true, text: 'Hi' })).toThrow('VOICE_TERMINAL_STATE')
  ledger.fail(requestId, 'later'); expect(ledger.get(requestId)?.phase).toBe('unknown')
  expect(() => ledger.accept({ ...origin, requestId: 'q'.repeat(257) })).toThrow('VOICE_TERMINAL_INVALID')
  expect(() => setup(33)).toThrow('VOICE_TERMINAL_INVALID')
  expect(setup(32).ledger.get('q')?.chunkCount).toBe(32)
})
