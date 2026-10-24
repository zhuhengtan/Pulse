import { expect, it, vi } from 'vitest'
import { contentHash, PulseRuntime } from '@hunterzhu/pulse-runtime'
import { planDecisionEvidence } from '../packages/server/src/plan-decision-evidence.js'

it('hydrates only intact public answers from the owning successful human effect', async () => {
  const runtime = new PulseRuntime(), answer = { value: 'sliding window; CSV' }
  for (const [id, mode] of ['durable', 'changed', 'private', 'tainted', 'foreign', 'failed'].entries()) {
    const ref = `result-${id}`, effectId = `effect-${id}`
    runtime.state.effects.set(effectId, { id: effectId, kind: 'human', input: { kind: 'ask', prompt: mode }, outcome: { status: mode === 'failed' ? 'failed' : 'succeeded', resultRef: ref } } as any)
    runtime.state.results.set(ref, { id: ref, privacy: mode === 'private' ? 'private' : 'public', ...(mode === 'tainted' ? { privacyTaints: ['private'] } : {}), producer: { kind: 'effect', id: mode === 'foreign' ? 'another-effect' : effectId }, contentHash: contentHash(mode === 'changed' ? { value: 'other' } : answer), storageState: 'persisted' } as any)
  }
  const load = vi.fn(async () => answer)
  expect(await planDecisionEvidence(runtime.state, load)).toEqual([
    { question: { kind: 'ask', prompt: 'durable' }, answer, resultRef: 'result-0' },
    { question: { kind: 'ask', prompt: 'changed' }, answer: null, resultRef: 'result-1', answerUnavailable: 'DECISION_BODY_UNAVAILABLE_OR_CHANGED' },
  ])
  expect(load).toHaveBeenCalledTimes(2)
})

it('does not manufacture an answer when persisted storage is missing', async () => {
  const runtime = new PulseRuntime()
  runtime.state.effects.set('human', { id: 'human', kind: 'human', input: { kind: 'ask' }, outcome: { status: 'succeeded', resultRef: 'answer' } } as any)
  runtime.state.results.set('answer', { producer: { kind: 'effect', id: 'human' }, privacy: 'public', contentHash: contentHash({ approved: true }) } as any)
  expect(await planDecisionEvidence(runtime.state, async () => { throw Error('missing') })).toMatchObject([{ answer: null, answerUnavailable: 'DECISION_BODY_UNAVAILABLE_OR_CHANGED' }])
})
