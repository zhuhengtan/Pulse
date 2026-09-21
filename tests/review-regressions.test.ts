import { describe, expect, it } from 'vitest'
import { ContextMerger, PulseRuntime, apply, createAgent, createRuntimeState, importRuntimePersistence, validateStep } from '@hunterzhu/pulse-runtime'
import { createDraftProxy } from '../packages/runtime/src/dsl/context-proxy.js'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

// Regression coverage for the issues confirmed during the runtime code review.
// Each block names the failure mode it guards against.

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })
const resume = (step = 'next') => ({ programId: 'test', programVersion: '1', step, locals: {} })
const hang = async (): Promise<never> => await new Promise<never>(() => undefined)

describe('prototype pollution through context paths', () => {
  const marker = `pulse_polluted_${process.pid}`
  const untouched = (): boolean => !(marker in ({} as Record<string, unknown>))

  it('rejects __proto__ segments in a Lane ContextDelta without touching Object.prototype', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'root', resume('start'))
    const result = validateStep(state, root.id, { actions: [], contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'set', path: ['__proto__', marker], value: 'owned' }] }, next: resume() })
    expect('rejection' in result && result.rejection.code).toBe('INVALID_CONTEXT_PATH')
    expect(untouched()).toBe(true)
  })

  it('rejects constructor/prototype segments too', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'root', resume('start'))
    for (const path of [['constructor', 'prototype', marker], ['safe', 'prototype', marker]]) {
      const result = validateStep(state, root.id, { actions: [], contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'set', path, value: 1 }] }, next: resume() })
      expect('rejection' in result && result.rejection.code).toBe('INVALID_CONTEXT_PATH')
    }
    expect(untouched()).toBe(true)
  })

  it('ContextMerger refuses a poisoned MergeProposal as a conflict', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'root', resume('start'))
    state.mergeProposals.set('p1', { id: 'p1', agentId: root.agentId, sourceLaneId: root.id, baseGlobalVersion: 0, createdAt: 1, delta: { target: 'global', baseVersion: 0, ops: [{ op: 'set', path: ['__proto__', marker], value: 1 }] } })
    const plan = new ContextMerger(state).plan(root.agentId)
    expect(plan.appliedProposalIds).toEqual([])
    expect(plan.conflicts.map((conflict) => conflict.proposalId)).toEqual(['p1'])
    expect(untouched()).toBe(true)
  })

  it('draft proxies refuse unsafe keys instead of recording them as ops', () => {
    const { draft, changes } = createDraftProxy<Record<string, unknown>>({ byUser: {} })
    expect(() => { (draft.byUser as Record<string, unknown>)['__proto__'] = { polluted: true } }).toThrow('UNSAFE_CONTEXT_PATH')
    expect(() => { draft.constructor = 'x' }).toThrow('UNSAFE_CONTEXT_PATH')
    expect(changes().ops).toEqual([])
    expect(untouched()).toBe(true)
  })
})

describe('lock cleanup on cancellation', () => {
  const lockProgram = (id: string): LaneProgram => ({ id, version: '1', step: ({ lane }) => lane.resume.step === 'start'
    ? { actions: [{ type: 'submit_effects', effects: [{ key: 'e', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'db', mode: 'exclusive' }] }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point(id, 'done') }
    : { actions: [{ type: 'complete', result: { ok: true } }], next: point(id, 'done') } })

  it('drops the queued lock request of a cancelled lock-blocked Effect', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, maxRunning: { tool: 4 }, effectExecutor: hang })
    runtime.createAgent('holder', lockProgram('holder'))
    runtime.tick()
    const blocked = runtime.createAgent('blocked', lockProgram('blocked'))
    runtime.tick()
    const blockedEffect = [...runtime.state.effects.values()].find((effect) => effect.agentId === blocked.agentId)!
    expect(blockedEffect.state).toBe('queued')
    expect(runtime.resourceLocks.queued('db')).toBe(1)

    runtime.cancelAgent(blocked.agentId, 'USER_REQUESTED')
    runtime.tick()
    expect(runtime.state.effects.get(blockedEffect.id)?.state).toBe('cancelled')
    expect(runtime.resourceLocks.queued('db')).toBe(0)

    const holderEffect = [...runtime.state.effects.values()].find((effect) => effect.agentId !== blocked.agentId)!
    runtime.completeEffect(holderEffect.id, { value: { done: 1 } })
    runtime.tick()
    expect(runtime.resourceLocks.isHeld('db', 'exclusive')).toBe(false)

    const third = runtime.createAgent('third', lockProgram('third'))
    for (let index = 0; index < 3; index++) runtime.tick()
    expect([...runtime.state.effects.values()].find((effect) => effect.agentId === third.agentId)?.state).toBe('running')
  })
})

describe('cancellation cascades through the Lane subtree', () => {
  it('cancel_lane cancels grandchildren and their running Effects', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, effectExecutor: hang })
    // Root forks child, child forks grandchild and parks on its own Effect, grandchild runs a
    // never-ending tool Effect. Once that Effect is running the root cancels the child Lane.
    const program: LaneProgram = { id: 'tree', version: '1', step: ({ lane }) => {
      switch (lane.resume.step) {
        case 'start': return { actions: [{ type: 'fork', lanes: [{ key: 'child', goal: 'child', program: point('tree', 'child-start') }] }], next: point('tree', 'root-wait') }
        case 'child-start': return { actions: [{ type: 'fork', lanes: [{ key: 'grandchild', goal: 'grandchild', program: point('tree', 'gc-start') }] }], next: point('tree', 'child-wait') }
        case 'gc-start': return { actions: [{ type: 'submit_effects', effects: [{ key: 'gc', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('tree', 'gc-done') }
        case 'root-wait': {
          const child = [...runtime.state.lanes.values()].find((candidate) => candidate.ownerLaneId === lane.id)
          const grandchild = child && [...runtime.state.lanes.values()].find((candidate) => candidate.ownerLaneId === child.id)
          if (grandchild && [...runtime.state.effects.values()].some((effect) => effect.ownerLaneId === grandchild.id && effect.state === 'running')) return { actions: [{ type: 'cancel_lane', laneId: child.id, reason: 'SUPERSEDED' }], next: point('tree', 'root-after-cancel') }
          return { actions: [{ type: 'submit_effects', effects: [{ key: 'poll', kind: 'tool', concurrencyClass: 'tool', input: { poll: true } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('tree', 'root-wait') }
        }
        case 'child-wait': return { actions: [{ type: 'submit_effects', effects: [{ key: 'park', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('tree', 'child-done') }
        default: return { actions: [{ type: 'complete', result: null }], next: point('tree', lane.resume.step) }
      }
    } }
    const agent = runtime.createAgent('tree', program, 'agent-tree')
    for (let index = 0; index < 10; index++) {
      runtime.tick()
      for (const effect of runtime.state.effects.values()) if (effect.state === 'running' && (effect.input as { poll?: boolean }).poll) runtime.completeEffect(effect.id, { value: null })
    }
    const lanes = [...runtime.state.lanes.values()]
    const root = lanes.find((lane) => lane.id === agent.laneId)!
    const child = lanes.find((lane) => lane.ownerLaneId === root.id)!
    const grandchild = lanes.find((lane) => lane.ownerLaneId === child.id)!
    expect(child.status).toBe('cancelled')
    expect(child.cancelReason).toBe('SUPERSEDED')
    expect(grandchild.status).toBe('cancelled')
    expect(grandchild.cancelReason).toBe('SUPERSEDED')
    for (const owner of [child, grandchild]) {
      const effect = [...runtime.state.effects.values()].find((candidate) => candidate.ownerLaneId === owner.id)!
      expect(effect.state).toBe('cancelled')
      expect(effect.outcome?.status).toBe('cancelled')
    }
    expect(runtime.state.events.filter((event) => event.type === 'lane.cancelled').map((event) => event.laneId).sort()).toEqual([child.id, grandchild.id].sort())
  })
})

describe('global context versions are contiguous', () => {
  it('records every intermediate version when one merge applies several proposals', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'root', resume('start'))
    state.mergeProposals.set('p1', { id: 'p1', agentId: root.agentId, sourceLaneId: root.id, baseGlobalVersion: 0, createdAt: 1, delta: { target: 'global', baseVersion: 0, ops: [{ op: 'set', path: ['a'], value: 1 }] } })
    state.mergeProposals.set('p2', { id: 'p2', agentId: root.agentId, sourceLaneId: root.id, baseGlobalVersion: 0, createdAt: 2, delta: { target: 'global', baseVersion: 0, ops: [{ op: 'set', path: ['b'], value: 2 }] } })
    const plan = new ContextMerger(state).commit(root.agentId)
    expect(plan.conflicts).toEqual([])
    const agent = state.agents.get(root.agentId)!
    expect(agent.latestGlobalVersion).toBe(2)
    expect(agent.globalVersions.get(1)).toEqual({ a: 1 })
    expect(agent.globalVersions.get(2)).toEqual({ a: 1, b: 2 })
  })
})

describe('late completion of a quarantined Effect', () => {
  it('reconciles the quarantine entry and keeps the snapshot restorable', async () => {
    let finish: ((value: unknown) => void) | undefined
    const runtime = new PulseRuntime({ maxTickMs: 1000, effectExecutor: () => new Promise((resolve) => { finish = resolve }) as never })
    const program: LaneProgram = { id: 'q', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'w', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write', cancelGraceMs: 0 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('q', 'done') }
      : { actions: [{ type: 'complete', result: null }], next: point('q', 'done') } }
    const agent = runtime.createAgent('q', program)
    runtime.tick()
    const effect = [...runtime.state.effects.values()][0]!
    runtime.cancelAgent(agent.agentId, 'USER_REQUESTED')
    runtime.tick()
    expect(runtime.state.effects.get(effect.id)?.state).toBe('reconcile_required')
    expect(runtime.quarantine.has(effect.id)).toBe(true)
    expect(runtime.state.lanes.get(agent.laneId)?.unresolvedEffectIds).toContain(effect.id)

    // The Runtime must never auto-settle an in-doubt Effect on later ticks.
    runtime.tick()
    expect(runtime.state.effects.get(effect.id)?.state).toBe('reconcile_required')

    finish!({ value: { wrote: true }, sideEffectState: 'applied', executionState: 'succeeded' })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    runtime.tick()
    const after = runtime.state.effects.get(effect.id)!
    expect(after.state).toBe('cancelled')
    expect(after.sideEffectState).toBe('applied')
    expect(runtime.quarantine.has(effect.id)).toBe(false)
    expect(runtime.state.lanes.get(agent.laneId)?.unresolvedEffectIds ?? []).not.toContain(effect.id)
    expect(() => importRuntimePersistence(runtime.exportPersistence())).not.toThrow()
  })

  it('refuses to persist a snapshot that could not be restored', async () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000 })
    runtime.createAgent('q', { id: 'q', version: '1', step: () => ({ actions: [{ type: 'complete', result: null }], next: point('q', 'done') }) })
    runtime.tick()
    // Corrupt the quarantine bookkeeping the way the old late-completion path did.
    runtime.quarantine.add('ghost-effect', runtime.state.now, 'TEST')
    let saved = 0
    await expect(runtime.persist({ load: async () => undefined, save: async () => { saved++ } })).rejects.toThrow()
    expect(saved).toBe(0)
  })
})

describe('Effect dispatch order', () => {
  it('dispatches the highest effective priority first when a class is saturated', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, maxRunning: { tool: 1 }, effectExecutor: hang })
    runtime.createAgent('prio', { id: 'prio', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [
      { key: 'low', kind: 'tool', concurrencyClass: 'tool', input: {}, priority: -1 },
      { key: 'urgent', kind: 'tool', concurrencyClass: 'tool', input: {}, priority: 5 },
    ], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('prio', 'done') }) })
    runtime.tick()
    const running = [...runtime.state.effects.values()].filter((effect) => effect.state === 'running')
    expect(running.map((effect) => effect.key)).toEqual(['urgent'])
  })
})

describe('control proposals do not drop a wait resolution', () => {
  it('parks propose_cancel while the owner already has a wait ResumeInput', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'owner', resume('start'))
    const childA = { id: 'lane-a', agentId: root.agentId, ownerLaneId: root.id, status: 'ready' as const, version: 0, goal: 'a', resume: resume('start'), contextSnapshotVersion: 0, context: { version: 0, history: [], state: {} }, children: new Set<string>(), priority: 0, enqueueSeq: 1, readySince: 0, ownedEffectIds: new Set<string>() }
    const childB = { ...childA, id: 'lane-b', goal: 'b' }
    state.lanes.set(childA.id, childA)
    state.lanes.set(childB.id, childB)
    root.children.add(childA.id)
    root.children.add(childB.id)
    root.pendingResumeInput = { type: 'wait', resolution: { waitId: 'wait-1', status: 'satisfied', dependencies: {} } }
    const proposal = validateStep(state, childA.id, { actions: [{ type: 'propose_cancel', laneId: childB.id, reason: 'SUPERSEDED' }], next: resume() })
    expect('mutations' in proposal).toBe(true)
    if ('mutations' in proposal) apply(state, proposal.mutations)
    const owner = state.lanes.get(root.id)!
    expect(owner.pendingResumeInput?.type).toBe('wait')
    expect(owner.pendingControlProposals).toEqual([{ type: 'cancel_lane', laneId: childB.id, reason: 'SUPERSEDED', fromLaneId: childA.id }])
  })
})

describe('child Agent creation failures stay on the Effect', () => {
  it('fails the Agent Effect instead of throwing out of tick() when the Lane cap is hit', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, maxTotalLanes: 1 })
    runtime.register({ id: 'child', version: '1', step: () => ({ actions: [{ type: 'complete', result: null }], next: point('child', 'done') }) })
    runtime.createAgent('parent', { id: 'parent', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'spawn', kind: 'agent', concurrencyClass: 'agent', input: { programId: 'child', programVersion: '1', goal: 'child' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('parent', 'done') }
      : { actions: [{ type: 'complete', result: null }], next: point('parent', 'done') } })
    expect(() => runtime.tick()).not.toThrow()
    const effect = [...runtime.state.effects.values()].find((candidate) => candidate.key === 'spawn')!
    expect(effect.state).toBe('failed')
    expect(effect.outcome?.error?.code).toBe('CHILD_AGENT_CREATE_FAILED')
    expect(effect.outcome?.error?.message).toBe('MAX_TOTAL_LANES')
    expect(runtime.state.agents.size).toBe(1)
  })
})

describe('persistence failures are observable', () => {
  it('emits persistence.failed and keeps the state dirty until a later flush succeeds', async () => {
    let fail = true
    const backend = { load: async () => undefined, save: async () => { if (fail) throw new Error('DISK_FULL') } }
    const runtime = new PulseRuntime({ maxTickMs: 1000, persistenceBackend: backend })
    runtime.createAgent('p', { id: 'p', version: '1', step: () => ({ actions: [{ type: 'complete', result: null }], next: point('p', 'done') }) })
    runtime.tick()
    await expect(runtime.flushPersistence()).rejects.toThrow('DISK_FULL')
    expect(runtime.state.events.some((event) => event.type === 'persistence.failed')).toBe(true)
    fail = false
    await expect(runtime.flushPersistence()).resolves.toBeUndefined()
    expect(runtime.state.events.some((event) => event.type === 'persistence.recovered')).toBe(true)
  })
})
