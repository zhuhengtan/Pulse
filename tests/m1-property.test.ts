import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, serializeRuntimeState, validateStep } from '@hunterzhu/pulse-runtime'
import type { LaneStepOutput, RuntimeError } from '@hunterzhu/pulse-runtime'

const resume = (step = 'next') => ({ programId: 'property', programVersion: '1', step, locals: {} })

function random(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x1_0000_0000
  }
}

function generatedOutput(next: () => number, index: number): LaneStepOutput {
  const mode = index % 4
  if (mode === 0) return { actions: [{ type: 'complete', result: { seed: Math.floor(next() * 10_000) } }], next: resume('done') }
  if (mode === 1) {
    const failure: RuntimeError = { code: `GENERATED_${index}`, message: 'generated failure', retryable: false }
    return { actions: [{ type: 'fail', error: failure }], next: resume('failed') }
  }
  if (mode === 2) {
    const count = 1 + Math.floor(next() * 3)
    const effects = Array.from({ length: count }, (_, effectIndex) => ({ key: `effect-${index}-${effectIndex}`, kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { value: Math.floor(next() * 100) } }))
    return { actions: [{ type: 'submit_effects', effects, wait: { onUnsatisfied: 'resume_with_error' } }], next: resume(`after-${index}`) }
  }
  return { actions: [
    { type: 'submit_effects', effects: [{ key: `duplicate-${index}`, kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } },
    { type: 'wait', spec: { mode: 'all', dependencies: [], onUnsatisfied: 'resume_with_error', reason: 'dependency' } },
  ], next: resume(`invalid-${index}`) }
}

describe('M1 deterministic transaction property probes', () => {
  it('keeps accepted generated transactions applicable and rejected ones atomic', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const next = random(seed)
      for (let index = 0; index < 32; index++) {
        const state = createRuntimeState()
        const { root } = createAgent(state, `agent-${seed}-${index}`, resume('start'))
        const before = JSON.stringify(serializeRuntimeState(state))
        const result = validateStep(state, root.id, generatedOutput(next, index))
        if ('rejection' in result) {
          expect(JSON.stringify(serializeRuntimeState(state))).toBe(before)
        } else {
          expect(() => apply(state, result.mutations)).not.toThrow()
        }
      }
    }
  })
})
