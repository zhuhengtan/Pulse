import { expect, it, vi } from 'vitest'
import { FileRuntimePersistenceBackend, MonotonicClock, PulseRuntime, PulseSession, type LaneProgram } from '@hunterzhu/pulse-runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const immediate = () => new Promise<void>(resolve => setImmediate(resolve))

it.each([false, true])('waits for both parallel tools before settling the session (persistence=%s)', async persisted => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-idle-race-'))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started: string[] = []
  const program: LaneProgram = { id: 'parallel-idle', version: '1', step: ({ lane }) => lane.resume.step === 'start'
    ? { actions: [{ type: 'submit_effects', effects: ['fast', 'slow'].map(key => ({ key, kind: 'tool' as const, concurrencyClass: 'tool' as const, input: {} })), wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'parallel-idle', programVersion: '1', step: 'finish', locals: {} } }
    : { actions: [{ type: 'complete', result: { delivered: true } }], next: lane.resume } }
  const runtime = new PulseRuntime({ clock: new MonotonicClock(), maxTickMs: 0, ...(persisted ? { persistenceBackend: new FileRuntimePersistenceBackend(join(root, 'runtime.json')) } : {}), effectExecutor: async effect => {
    started.push(effect.key)
    if (effect.key === 'slow') await held
    return { value: { key: effect.key } }
  } })
  const { agentId } = runtime.createAgent('wait for both tools', program)
  const ticks = vi.spyOn(runtime, 'tick')
  const session = runtime.start(agentId)
  let settled = false
  const outcome = session.outcome().then(value => { settled = true; return value })
  try {
    await vi.waitFor(() => expect(started).toEqual(['fast', 'slow']), { timeout: 3000, interval: 5 })
    // A settled member of an all-wait must not keep cleanup runnable while
    // its sibling is still executing, burning the default 10,000 tick budget.
    for (let i = 0; i < 10_050 && !settled; i++) await immediate()
    expect(settled, JSON.stringify(runtime.state.events.filter(event => event.type === 'runtime.idle_blocked'))).toBe(false)
    expect(ticks.mock.calls.length).toBeLessThan(64)
    release()
    expect(await outcome).toMatchObject({ status: 'succeeded', resultRef: expect.any(String) })
    expect(runtime.state.agents.get(agentId)?.state).toBe('succeeded')
    expect(runtime.state.events.some(event => event.type === 'runtime.idle_blocked')).toBe(false)
  } finally { release(); await outcome; await runtime.flushPersistence(); await rm(root, { recursive: true, force: true }) }
})

it('retains the scheduler error when the root has no lane failure', async () => {
  const error = { code: 'RUNTIME_IDLE_BLOCKED', message: 'Root has not settled.', retryable: false }
  const runtime = { runAgent: async () => ({ status: 'failed', error }), state: { agents: new Map([['agent', { rootLaneId: 'root' }]]), lanes: new Map([['root', { status: 'waiting' }]]) } } as unknown as PulseRuntime
  expect(await new PulseSession(runtime, 'agent').outcome()).toMatchObject({ status: 'failed', error })
})
