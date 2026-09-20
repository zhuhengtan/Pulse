import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, validateStep } from '@pulse/runtime'

const point = (step: string) => ({ programId: 'visibility', programVersion: '1', step, locals: {} })

describe('lane ResultRef visibility', () => {
  it('isolates sibling lanes and admits an explicitly referenced result', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'root', point('start'))
    const fork = validateStep(state, root.id, {
      actions: [{ type: 'fork', lanes: [
        { key: 'producer', goal: 'producer', program: point('work') },
        { key: 'sibling', goal: 'sibling', program: point('work') },
      ] }],
      next: point('wait'),
    })
    expect('rejection' in fork).toBe(false)
    if ('rejection' in fork) return
    apply(state, fork.mutations)

    const [producerId, siblingId] = [...state.lanes.get(root.id)!.children]
    const producer = state.lanes.get(producerId!)!
    const sibling = state.lanes.get(siblingId!)!
    const produced = validateStep(state, producer.id, { actions: [{ type: 'complete', result: { answer: 42 } }], next: point('done') })
    expect('rejection' in produced).toBe(false)
    if ('rejection' in produced) return
    apply(state, produced.mutations)
    const resultId = [...state.results.keys()][0]!

    const hidden = validateStep(state, sibling.id, { actions: [{ type: 'complete', result: { answer: 'should-not-read' }, derivedFrom: [resultId] }], next: point('done') })
    expect(hidden).toMatchObject({ rejection: { code: 'RESULT_NOT_VISIBLE' } })

    const explicit = validateStep(state, root.id, {
      actions: [{ type: 'fork', lanes: [{ key: 'consumer', goal: 'consumer', program: point('work'), inputResultRefs: [resultId] }] }],
      next: point('wait'),
    })
    expect('rejection' in explicit).toBe(false)
    if ('rejection' in explicit) return
    apply(state, explicit.mutations)
    const consumerId = [...state.lanes.get(root.id)!.children].find((id) => id !== producer.id && id !== sibling.id)!
    const consumer = state.lanes.get(consumerId)!
    const accepted = validateStep(state, consumer.id, { actions: [{ type: 'complete', result: { answer: 42 }, derivedFrom: [resultId] }], next: point('done') })
    expect('rejection' in accepted).toBe(false)
  })
})
