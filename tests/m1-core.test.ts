import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, validateStep, DependencyGraph, detectDependencyCycle } from '@pulse/runtime'
import type { LaneStepOutput, TargetRef } from '@pulse/runtime'

const resume = (step = 'next') => ({ programId: 'test', programVersion: '1', step, locals: {} })
function setup() {
  const state = createRuntimeState()
  const { root } = createAgent(state, 'root', resume('start'))
  return { state, root }
}

describe('M1-1 deterministic transaction boundary', () => {
  it('rejects multiple Wait sources atomically', () => {
    const { state, root } = setup()
    const before = structuredClone(state)
    const output: LaneStepOutput = {
      actions: [
        { type: 'submit_effects', effects: [{ key: 'read', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } },
        { type: 'wait', spec: { mode: 'all', dependencies: [], onUnsatisfied: 'resume_with_error', reason: 'dependency' } },
      ],
      next: resume(),
    }
    const result = validateStep(state, root.id, output)
    expect('rejection' in result && result.rejection.code).toBe('MULTIPLE_WAIT_SOURCES')
    expect(state.lanes.size).toBe(before.lanes.size)
    expect(state.effects.size).toBe(before.effects.size)
    expect(state.waits.size).toBe(before.waits.size)
  })

  it('resolves LocalRef effects and applies all mutations together', () => {
    const { state, root } = setup()
    const result = validateStep(state, root.id, {
      actions: [{ type: 'submit_effects', effects: [
        { key: 'one', kind: 'tool', concurrencyClass: 'tool', input: { value: 1 } },
        { key: 'two', kind: 'tool', concurrencyClass: 'tool', input: { value: 2 } },
      ], wait: { onUnsatisfied: 'resume_with_error' } }],
      next: resume('after-tools'),
    })
    expect('mutations' in result).toBe(true)
    if ('mutations' in result) apply(state, result.mutations)
    expect(state.effects.size).toBe(2)
    expect(state.waits.size).toBe(1)
    expect(state.lanes.get(root.id)?.status).toBe('waiting')
    const wait = [...state.waits.values()][0]!
    expect(wait.spec.dependencies.map((d) => d.target.kind)).toEqual(['effect', 'effect'])
  })

  it('does not leave a half-created fork after invalid context version', () => {
    const { state, root } = setup()
    const result = validateStep(state, root.id, {
      actions: [{ type: 'fork', lanes: [{ key: 'child', goal: 'child', program: resume(), contextVersion: 99 }] }],
      next: resume(),
    })
    expect('rejection' in result && result.rejection.code).toBe('UNKNOWN_CONTEXT_VERSION')
    expect(state.lanes.size).toBe(1)
  })

  it('keeps apply deterministic for accepted terminal transactions', () => {
    const { state, root } = setup()
    const output: LaneStepOutput = { actions: [{ type: 'complete', result: { ok: true } }], next: resume() }
    const first = validateStep(state, root.id, output)
    expect('mutations' in first).toBe(true)
    if ('mutations' in first) apply(state, first.mutations)
    expect(state.lanes.get(root.id)?.status).toBe('succeeded')
    expect(state.results.size).toBe(1)
  })
})

describe('dependency graph and deadlock edge semantics', () => {
  it('covers self, sibling, ancestor and ownership cases without false positives', () => {
    const cases: Array<{ edges: Array<{ from: TargetRef; to: TargetRef; kind?: 'wait' | 'ownership' }>; cycle: boolean }> = [
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'a' } }], cycle: true },
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'b' } }, { from: { kind: 'lane', id: 'b' }, to: { kind: 'lane', id: 'a' } }], cycle: true },
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'b' } }, { from: { kind: 'lane', id: 'b' }, to: { kind: 'lane', id: 'c' } }], cycle: false },
      { edges: [{ from: { kind: 'lane', id: 'main' }, to: { kind: 'lane', id: 'child' }, kind: 'ownership' }], cycle: false },
      { edges: [{ from: { kind: 'lane', id: 'main' }, to: { kind: 'lane', id: 'child' } }, { from: { kind: 'lane', id: 'child' }, to: { kind: 'lane', id: 'grandchild' } }], cycle: false },
      { edges: [{ from: { kind: 'effect', id: 'e1' }, to: { kind: 'lane', id: 'a' } }, { from: { kind: 'lane', id: 'a' }, to: { kind: 'effect', id: 'e1' } }], cycle: true },
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'b' } }, { from: { kind: 'lane', id: 'b' }, to: { kind: 'lane', id: 'c' } }, { from: { kind: 'lane', id: 'c' }, to: { kind: 'lane', id: 'a' } }], cycle: true },
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'b' } }, { from: { kind: 'lane', id: 'b' }, to: { kind: 'lane', id: 'c' } }, { from: { kind: 'lane', id: 'd' }, to: { kind: 'lane', id: 'c' } }], cycle: false },
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'b' }, kind: 'ownership' }, { from: { kind: 'lane', id: 'b' }, to: { kind: 'lane', id: 'a' }, kind: 'ownership' }], cycle: false },
      { edges: [{ from: { kind: 'lane', id: 'a' }, to: { kind: 'lane', id: 'b' } }, { from: { kind: 'lane', id: 'b' }, to: { kind: 'lane', id: 'c' } }, { from: { kind: 'lane', id: 'c' }, to: { kind: 'lane', id: 'd' } }, { from: { kind: 'lane', id: 'd' }, to: { kind: 'lane', id: 'a' } }], cycle: true },
    ]
    for (const item of cases) expect(detectDependencyCycle(item.edges)).toBe(item.cycle)
  })

  it('exposes strongly connected components for diagnostics', () => {
    const graph = new DependencyGraph()
    graph.add({ kind: 'lane', id: 'a' }, { kind: 'lane', id: 'b' })
    graph.add({ kind: 'lane', id: 'b' }, { kind: 'lane', id: 'a' })
    expect(graph.stronglyConnectedComponents().some((component) => component.length === 2)).toBe(true)
  })
})
