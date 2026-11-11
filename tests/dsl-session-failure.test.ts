import { afterEach, expect, it, vi } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { Outcome } from '@hunterzhu/pulse-runtime'

afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const runtime = new PulseRuntime()
  const program = { id: 'session-failure', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'session-failure', programVersion: '1', step: 'done', locals: {} } }) }
  const { agentId } = runtime.createAgent('session', program)
  let reject!: (reason?: unknown) => void
  vi.spyOn(runtime, 'runAgent').mockReturnValue(new Promise<Outcome>((_resolve, fail) => { reject = fail }))
  const session = runtime.start(agentId)
  return { runtime, session, reject }
}

it.each([new Error('PERSISTENCE_REPLACEMENT_FAILED'), undefined])('observes execution rejection before outcome is requested and fails a waiting stream (%s)', async reason => {
  const { runtime, session, reject } = fixture()
  const waiting = vi.spyOn(runtime, 'waitForActivity')
  const consumed = (async () => { for await (const _event of session.stream()) { /* drain */ } })()
  const observed = consumed.then(() => ({ failed: false }), error => ({ failed: true, error }))
  await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
  reject(reason)
  // Leave outcome unobserved for a turn: Vitest must see no unhandled rejection.
  await new Promise(resolve => setTimeout(resolve, 0))
  await expect(observed).resolves.toEqual({ failed: true, error: reason })
  await expect(session.outcome()).rejects.toBe(reason)
  expect([...runtime.state.lanes.values()][0]?.status).not.toBe('succeeded')
}, 2_000)

it('observes a later failure after an early stream return without changing outcome', async () => {
  const { session, reject } = fixture()
  const iterator = session.stream(-1)[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  await iterator.return?.()
  const reason = new Error('LATE_PERSISTENCE_FAILURE')
  reject(reason)
  await new Promise(resolve => setTimeout(resolve, 0))
  await expect(session.outcome()).rejects.toBe(reason)
})

it('propagates a persistence failure after a terminal lane instead of ending the stream', async () => {
  const runtime = new PulseRuntime()
  const program = { id: 'terminal-flush', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: {} }], next: { programId: 'terminal-flush', programVersion: '1', step: 'done', locals: {} } }) }
  const { agentId } = runtime.createAgent('terminal', program)
  const reason = new Error('FINAL_FLUSH_FAILED')
  vi.spyOn(runtime, 'flushPersistence').mockRejectedValueOnce(reason)
  const session = runtime.start(agentId)
  const consumed = (async () => { for await (const _event of session.stream()) { /* drain */ } })()
  await expect(consumed).rejects.toBe(reason)
  await expect(session.outcome()).rejects.toBe(reason)
  await expect(runtime.shutdown()).resolves.toMatchObject({ status: 'stopped' })
})

it('drains normal completion facts and preserves cancellation and shutdown', async () => {
  for (const cancel of [false, true]) {
    const runtime = new PulseRuntime()
    const program = { id: 'settlement', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: {} }], next: { programId: 'settlement', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('settlement', program)
    if (cancel) runtime.requestCancel(agentId, 'USER_REQUESTED')
    const session = runtime.start(agentId)
    const facts: number[] = []
    for await (const event of session.stream()) if (event.kind === 'fact') facts.push(event.seq)
    await expect(session.outcome()).resolves.toMatchObject({ status: cancel ? 'cancelled' : 'succeeded' })
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.at(-1)).toBe(runtime.state.events.at(-1)?.seq)
    await expect(runtime.shutdown()).resolves.toMatchObject({ status: 'stopped' })
  }
})
