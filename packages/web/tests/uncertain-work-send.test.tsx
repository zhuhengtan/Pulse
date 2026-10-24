import { expect, it, vi } from 'vitest'
import { ApiError, submitWorkMessage, type PulseWebTransport, type WebMessage } from '../src/transport.js'
const payload = { requestId: 'send-test-123', text: 'Generate report', delivery: 'whenIdle' as const }
const accepted: WebMessage = { id: 'msg-send-test-123', role: 'user', text: payload.text, runId: 'run-confirmed', createdAt: new Date(0).toISOString() }
function transport(items: WebMessage[], status?: number, detail?: string) {
  const request = vi.fn(async () => { if (!status) throw new TypeError('Connection lost'); return new Response(JSON.stringify({ error: detail }), { status }) })
  const messages = vi.fn(async () => ({ items, revision: 1 }))
  return { request, messages, subscribe: vi.fn() } as PulseWebTransport & { request: typeof request; messages: typeof messages }
}
it('recovers an accepted send after response loss without another POST', async () => {
  const t = transport([accepted]); expect(await submitWorkMessage(t, 'conv', payload)).toEqual({ runId: 'run-confirmed' }); expect(t.request).toHaveBeenCalledTimes(1)
})
it('reconciles busy responses only against the exact persisted request', async () => {
  const t = transport([accepted], 409, 'CONVERSATION_BUSY'); expect(await submitWorkMessage(t, 'conv', payload)).toEqual({ runId: 'run-confirmed' })
  await expect(submitWorkMessage(transport([{ ...accepted, id: 'msg-other' }], 409, 'CONVERSATION_BUSY'), 'conv', payload)).rejects.toBeInstanceOf(ApiError)
})
it.each([{ text: 'different' }, { attachments: [{ id: 'other' }] }, { skills: ['other'] }, { mentionedFiles: ['other'] }, { bodyTruncated: true }, { runId: undefined }, { role: 'assistant' }])('does not infer acceptance from mismatching or incomplete evidence %j', async change => {
  const t = transport([{ ...accepted, ...change } as WebMessage]); await expect(submitWorkMessage(t, 'conv', payload)).rejects.toThrow('Connection lost'); expect(t.request).toHaveBeenCalledTimes(1)
})
it.each([[401, 'UNAUTHORIZED'], [409, 'REQUEST_ID_REUSED'], [403, 'FORBIDDEN']])('preserves explicit rejection %s', async (status, detail) => {
  const t = transport([accepted], status as number, detail as string); await expect(submitWorkMessage(t, 'conv', payload)).rejects.toBeInstanceOf(ApiError); expect(t.messages).not.toHaveBeenCalled()
})

it('waits for delayed durable admission without issuing another write', async () => {
  vi.useFakeTimers()
  try {
    const t = transport([])
    t.messages.mockResolvedValueOnce({items:[],revision:0}).mockResolvedValue({items:[accepted],revision:1})
    const result = submitWorkMessage(t, 'conv', payload)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toEqual({runId:'run-confirmed'}); expect(t.request).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
