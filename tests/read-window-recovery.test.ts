import { expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { reusableEvidence } from '../packages/runtime/src/dsl/evidence-reuse.js'
import { assertReadWindowInput } from '../packages/server/src/task-controller/read-window.js'
import { normalizeModelToolInput } from '../packages/runtime/src/dsl/program.js'

it('preflights oversized reads only when the new controller opts in', () => {
  expect(normalizeModelToolInput('fs.read', { path: 'report.md', maxBytes: 6000 })).toMatchObject({ maxBytes: 3000 })
  expect(normalizeModelToolInput('fs.read', { path: 'report.md', maxBytes: 6000 }, true)).toMatchObject({ maxBytes: 6000 })
  expect(() => assertReadWindowInput('fs.read', { path: 'report.md', maxBytes: 6000 })).not.toThrow()
  expect(() => assertReadWindowInput('fs.read', { path: 'report.md', maxBytes: 3000 }, 3000)).not.toThrow()
  expect(() => assertReadWindowInput('fs.write', { maxBytes: 20000 }, 3000)).not.toThrow()
  try { assertReadWindowInput('fs.read', { path: 'report.md', maxBytes: 20000 }, 3000); throw Error('expected failure') }
  catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_TOOL_INPUT', details: { diagnostics: [{ path: 'maxBytes', constraint: 'maximum 3000 bytes per window', received: 20000 }] } })
    expect((error as Error).message).toContain('nextOffset')
  }
})

it('requires matching startLine and sufficient partial-window coverage, retaining legacy semantics', () => {
  const values: any = { 'result-1': { path: 'report.md', hash: 'h', offset: 0, content: 'x'.repeat(1000), truncated: true, nextOffset: 1000 } }
  const metadata: any = { toolName: 'fs.read', outcomeStatus: 'succeeded', toolArguments: { path: 'report.md', maxBytes: 1000 } }
  const ctx: any = { results: { read: (ref: string) => values[ref], meta: () => metadata } }
  const larger = [{ toolName: 'fs.read', input: { path: 'report.md', maxBytes: 3000 } }]
  expect(reusableEvidence(ctx, larger, ['result-1'])).toEqual({ refs: ['result-1'], checksOnly: false })
  expect(reusableEvidence(ctx, larger, ['result-1'], false, 3000)).toBeUndefined()
  expect(reusableEvidence(ctx, [{ toolName: 'fs.read', input: { path: 'report.md', maxBytes: 800 } }], ['result-1'], false, 3000)?.refs).toEqual(['result-1'])
  const byLine = [{ toolName: 'fs.read', input: { path: 'report.md', startLine: 90 } }]
  expect(reusableEvidence(ctx, byLine, ['result-1'], false, 3000)).toBeUndefined()
  metadata.toolArguments = { path: 'report.md', startLine: 90, maxBytes: 3000 }
  values['result-1'].offset = 5000; values['result-1'].nextOffset = 8000
  expect(reusableEvidence(ctx, byLine, ['result-1'], false, 3000)?.refs).toEqual(['result-1'])
  metadata.toolArguments = { path: 'report.md', maxBytes: 1000 }
  values['result-1'] = { path: 'report.md', hash: 'h', offset: 0, content: 'complete', truncated: false, nextOffset: null }
  expect(reusableEvidence(ctx, larger, ['result-1'], false, 3000)?.refs).toEqual(['result-1'])
})

it('gives the model an exact unread offset instead of an opaque duplicate-read notice', async () => {
  let turns = 0
  const offsets: number[] = [], notices: string[] = []
  const program = defineLaneProgram({ id: 'read-window-recovery', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'Read the complete file.', toolAllow: ['fs.read'], reuseSettledEvidence: true, evidenceReadWindowBytes: 3000, maxTurns: 8, onFinish: () => 'finish' })
    builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
  })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    const input: any = effect.input
    if (effect.kind === 'tool') {
      const offset = input.arguments.offset ?? 0; offsets.push(offset)
      return { value: { path: 'report.md', hash: 'h', offset, content: offset ? 'tail' : 'x'.repeat(3000), nextOffset: offset ? null : 3000, truncated: !offset } }
    }
    turns++
    if (turns === 3) notices.push(JSON.stringify(input.inputs?.conversation ?? []))
    if (turns <= 3) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'report.md', maxBytes: 3000, offset: turns === 3 ? 3000 : 0 } }] } }
    return { value: { text: 'Complete file read.', finishReason: 'stop' } }
  } })
  const { agentId } = runtime.createAgent('Read complete file', program)
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(offsets).toEqual([0, 3000])
  expect(notices[0]).toContain('nextOffset')
  expect(notices[0]).toContain('3000')
})
