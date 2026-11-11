import { expect, it } from 'vitest'
import type { EffectRecord, PulseRuntime } from '@hunterzhu/pulse-runtime'
import { assertRunCanContinue } from '../packages/server/src/run-continuation-guard.js'
const operation = (name: string, args: object) => ({ id: 'proposed', kind: 'tool', input: { name, arguments: args } } as EffectRecord)
function runtime(effects: unknown[], results: unknown[] = []) {
  return { state: { effects: new Map(effects.map((effect: any) => [effect.id, effect])), results: new Map(results.map((result: any) => [result.id, result])) } } as Pick<PulseRuntime, 'state'>
}
it('retains a denied operation across renamed effects while allowing another method and diagnosis', () => {
  const denied = operation('fs.write', { path: 'locked.txt', content: 'x' })
  const saved = runtime([{ ...denied, outcome: { status: 'failed', error: { code: 'AI_APPROVAL_DENIED', message: 'Denied', retryable: false } } }])
  expect(() => assertRunCanContinue(saved, operation('fs.write', { content: 'x', path: 'locked.txt' }))).toThrow('Denied')
  expect(() => assertRunCanContinue(saved, operation('fs.read', { path: 'locked.txt' }))).not.toThrow()
  expect(() => assertRunCanContinue(saved)).not.toThrow()
})
it('honors a manual denial without blocking unrelated inspection', () => {
  const saved = runtime([{ id: 'human', kind: 'human', input: { tools: [{ toolName: 'shell.exec', input: { command: 'node', args: ['deploy.mjs'] } }] }, outcome: { status: 'succeeded', resultRef: 'answer' } }], [{ id: 'answer', value: { approved: false, reason: 'Do not deploy' } }])
  expect(() => assertRunCanContinue(saved, operation('shell.exec', { command: 'node', args: ['deploy.mjs'] }))).toThrow('Do not deploy')
  expect(() => assertRunCanContinue(saved, operation('fs.read', { path: 'deploy.mjs' }))).not.toThrow()
})
it('leaves reserved verification and final attempts to the cumulative ledger after work allocation stops', () => {
  const saved = runtime([{ id: 'work', kind: 'llm', outcome: { status: 'failed', error: { code: 'TASK_MODEL_CALL_BUDGET_WORK_EXHAUSTED', message: 'Work allocation consumed' } } }])
  expect(() => assertRunCanContinue(saved)).not.toThrow()
})
it('permits a freshly diagnosed proposal when the old proposal was cancelled before dispatch during takeover', () => {
  const write = operation('fs.write', { path: 'output.txt', content: 'requested' })
  const saved = runtime([{ ...write, outcome: { status: 'cancelled', reason: 'CONTROLLER_TAKEOVER_PENDING_OPERATION' } }])
  expect(() => assertRunCanContinue(saved, write)).not.toThrow()
})
