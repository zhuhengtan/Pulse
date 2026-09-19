import { describe, expect, it } from 'vitest'
import { CancellationScope, PulseRuntime, QuarantineScope, ReadyQueue, ResourceLockManager, VirtualClock } from '@pulse/runtime'

const point = (step: string) => ({ programId: 'scheduler-test', programVersion: '1', step, locals: {} })

describe('M1-2 scheduler and lifecycle primitives', () => {
  it('advances a virtual clock and fires timers deterministically', () => {
    const clock = new VirtualClock()
    const calls: string[] = []
    clock.schedule(20, () => calls.push('late'))
    clock.schedule(10, () => calls.push('early'))
    clock.advance(9)
    expect(calls).toEqual([])
    clock.advance(1)
    expect(calls).toEqual(['early'])
    clock.advance(10)
    expect(calls).toEqual(['early', 'late'])
  })

  it('orders ready work by priority, aging, then FIFO', () => {
    const queue = new ReadyQueue(10)
    queue.enqueue({ laneId: 'old-low', basePriority: 0, readySince: 0, enqueueSeq: 1 })
    queue.enqueue({ laneId: 'new-high', basePriority: 5, readySince: 20, enqueueSeq: 2 })
    expect(queue.dequeue(20)).toBe('new-high')
    expect(queue.dequeue(30)).toBe('old-low')
  })

  it('prevents a queued writer from being starved by later readers', async () => {
    const locks = new ResourceLockManager()
    const releaseRead = await locks.acquire('workspace', 'shared', 'r1')
    const writer = locks.acquire('workspace', 'exclusive', 'w1')
    const laterReader = locks.acquire('workspace', 'shared', 'r2')
    let writerGranted = false
    void writer.then((release) => { writerGranted = true; release() })
    void laterReader.then((release) => release())
    await Promise.resolve()
    expect(writerGranted).toBe(false)
    releaseRead()
    await Promise.resolve()
    expect(writerGranted).toBe(true)
  })

  it('propagates owner cancellation only to descendants', () => {
    const root = new CancellationScope('root')
    const child = new CancellationScope('child', root)
    const sibling = new CancellationScope('sibling')
    root.cancel('SUPERSEDED')
    expect(child.cancelled).toBe(true)
    expect(child.reason).toBe('SUPERSEDED')
    expect(sibling.cancelled).toBe(false)
    expect(root.canCancel(child)).toBe(true)
    expect(sibling.canCancel(child)).toBe(false)
  })

  it('returns from quarantine while retaining unresolved effect ids', () => {
    const quarantine = new QuarantineScope()
    quarantine.add('effect-1', 10)
    const result = quarantine.run(() => 'done')
    expect(result).toEqual({ value: 'done', unresolvedEffectIds: ['effect-1'] })
    expect(quarantine.reconcile('effect-1')).toBe(true)
    expect(quarantine.unresolvedEffectIds).toEqual([])
  })

  it('lets one lane wait without blocking another lane', async () => {
    const calls: string[] = []
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      await new Promise<void>((resolve) => setTimeout(resolve, effect.key === 'slow' ? 15 : 0))
      calls.push(effect.key)
      return { value: { key: effect.key } }
    } })
    const program = {
      id: 'scheduler-test', version: '1',
      step: ({ lane, resumeInput }: { lane: any; resumeInput?: any }) => {
        if (lane.resume.step === 'start') return { actions: [{ type: 'submit_effects', effects: [{ key: lane.goal, kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('done') }
        return { actions: [{ type: 'complete', result: { goal: lane.goal, resumed: resumeInput?.type } }], next: point('done') }
      },
    }
    runtime.createAgent('slow', program)
    runtime.createAgent('fast', program)
    const fastLane = [...runtime.state.lanes.values()].find((lane) => lane.goal === 'fast')!
    runtime.tick()
    expect(runtime.state.lanes.get(fastLane.id)?.status).toBe('waiting')
    await runtime.waitForIdle()
    expect(calls.sort()).toEqual(['fast', 'slow'])
    expect([...runtime.state.lanes.values()].every((lane) => lane.status === 'succeeded')).toBe(true)
  })

  it('starts fork children only after startup dependencies and resumes one join', async () => {
    const runtime = new PulseRuntime()
    const forkPoint = (step: string) => ({ programId: 'fork-test', programVersion: '1', step, locals: {} })
    const program = {
      id: 'fork-test', version: '1',
      step: ({ lane }: { lane: any }) => {
        if (lane.resume.step === 'start') return { actions: [{ type: 'fork', lanes: [
          { key: 'a', goal: 'a', program: forkPoint('child') },
          { key: 'b', goal: 'b', program: forkPoint('child'), dependsOn: [{ key: 'after-a', target: { local: 'a' }, condition: 'success' }] },
        ], join: { condition: 'settled', onUnsatisfied: 'resume_with_error' } }], next: forkPoint('joined') }
        if (lane.resume.step === 'child' && lane.goal === 'a') return { actions: [{ type: 'submit_effects', effects: [{ key: 'a-work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: forkPoint('child-done') }
        if (lane.resume.step === 'child') return { actions: [{ type: 'complete', result: { child: lane.goal } }], next: forkPoint('child') }
        if (lane.resume.step === 'child-done') return { actions: [{ type: 'complete', result: { child: lane.goal } }], next: forkPoint('child-done') }
        return { actions: [{ type: 'complete', result: { joined: true } }], next: forkPoint('joined') }
      },
    }
    const root = runtime.createAgent('root', program)
    runtime.tick()
    const children = [...runtime.state.lanes.values()].filter((lane) => lane.ownerLaneId === root.laneId)
    expect(children).toHaveLength(2)
    expect(children.find((lane) => lane.goal === 'b')?.status).toBe('waiting')
    await runtime.waitForIdle()
    expect(runtime.state.lanes.get(root.laneId)?.status).toBe('succeeded')
    expect(runtime.state.waits.size).toBe(3)
  })

  it('publishes an effect outcome only once for late completion events', () => {
    const runtime = new PulseRuntime()
    const program = { id: 'late-test', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'one', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('done') }) }
    runtime.createAgent('root', program)
    runtime.tick()
    const effect = [...runtime.state.effects.values()][0]!
    runtime.completeEffect(effect.id, { value: { ok: true } })
    runtime.completeEffect(effect.id, { value: { ok: false } })
    expect(runtime.state.results.size).toBe(1)
    expect(effect.outcome?.resultRef).toBe('result-1')
  })

  it('keeps effect identity across retry and applies virtual backoff', async () => {
    let attempts = 0
    const runtime = new PulseRuntime({ effectExecutor: async () => { attempts++; return { value: attempts } } })
    const program = { id: 'retry-test', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'one', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('done') }) }
    runtime.createAgent('root', program)
    runtime.tick()
    await runtime.waitForIdle()
    const effect = [...runtime.state.effects.values()][0]!
    const id = effect.id
    delete effect.outcome
    effect.state = 'queued'
    runtime.retryEffect(id, 10)
    expect(effect.id).toBe(id)
    expect(effect.attemptNo).toBe(2)
    runtime.clock.advance(10)
    await runtime.waitForIdle()
    expect(attempts).toBe(2)
  })
})
