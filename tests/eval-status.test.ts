import { describe, expect, it } from 'vitest'
// @ts-expect-error Script helper is intentionally native JavaScript.
import { evaluationStatus } from '../scripts/eval/status.mjs'

describe('evaluation acceptance accounting', () => {
  it('requires successful exit, runtime success, and accepted task evidence', () => {
    const result = { status: 'succeeded', taskOutcome: { status: 'accepted' } }
    expect(evaluationStatus({ code: 0 }, result)).toBe('succeeded')
    expect(evaluationStatus({ code: 1 }, result)).toBe('failed')
    expect(evaluationStatus({ code: 0 }, { status: 'succeeded' })).toBe('failed')
    expect(evaluationStatus({ code: 1 }, { status: 'succeeded', taskOutcome: { status: 'unverifiable' } })).toBe('failed')
    expect(evaluationStatus({ code: 0, timedOut: true }, result)).toBe('timeout')
  })
})
