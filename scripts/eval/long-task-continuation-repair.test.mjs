import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluationBlockReason, evaluationSystemPrompt } from './long-task-lib.mjs'
test('safe Runtime completion retains a provider failure stop cause', () => {
 assert.match(evaluationBlockReason({ outcome: { status: 'succeeded', text: 'S2: PROVIDER_NETWORK_ERROR: TimeoutError' } }), /provider_block/)
})
test('partially known usage must stop, without treating its known totals as complete', () => {
 assert.equal(evaluationBlockReason({ outerAttempts: 19, usage: { inputTokens: 470578, outputTokens: 93027, budget: { unknown: 1 }, fieldCompleteness: { inputTokens: { status: 'partial' } } } }), 'unknown_usage_after_provider_attempt')
})
test('unknown fields and zero generation are not confused with failure', () => {
 assert.equal(evaluationBlockReason({ outerAttempts: 0 }), undefined)
 assert.equal(evaluationBlockReason({ outerAttempts: 1, usage: { inputTokens: 1, outputTokens: 2 } }), undefined)
})

test('evaluation policy rejects historical progress as permanent system instructions', () => {
 const prompt = evaluationSystemPrompt({ productCalls: 183, evaluatorCalls: null })
 assert.match(prompt, /183次产品上限/); assert.match(prompt, /评测额外上限：未设置/)
 assert.match(prompt, /当前文件版本和后续实际检查/)
 assert.doesNotMatch(prompt, /8\/9|7\/9|LT02|consumedCostUnknown/)
 assert.throws(() => evaluationSystemPrompt({ productCalls: 183, checks: ['old failure'] }), /EVAL_PROMPT_STATE_FORBIDDEN/)
 assert.throws(() => evaluationSystemPrompt({ productCalls: 257 }), /EVAL_PROMPT_BUDGET_INVALID/)
})
