import { expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { isUnreadFileWindow } from '../packages/runtime/src/dsl/read-continuation.js'

it('keeps file versions and already observed windows separate', () => {
  const rows: any = {
    'result-1': { tool: 'fs.read', value: { path: 'large', hash: 'v1', offset: 0, nextOffset: 3000 } },
    'result-2': { tool: 'fs.read', value: { path: 'large', hash: 'v1', offset: 3000, nextOffset: 6000 } },
    'result-3': { tool: 'fs.apply_patch', value: { path: 'large', hash: 'v2', changed: true } },
  }
  const ctx: any = { results: { meta: (ref: string) => ({ toolName: rows[ref].tool, outcomeStatus: 'succeeded' }), read: (ref: string) => rows[ref].value } }
  const call = (offset: number) => ({ toolName: 'fs.read', input: { path: 'large', offset } })
  expect(isUnreadFileWindow(ctx, call(3000), ['result-1'])).toBe(true)
  expect(isUnreadFileWindow(ctx, call(3000), ['result-1', 'result-2'])).toBe(false)
  expect(isUnreadFileWindow(ctx, call(6000), ['result-1', 'result-2'])).toBe(true)
  expect(isUnreadFileWindow(ctx, call(6000), ['result-1', 'result-2', 'result-3'])).toBe(false)
  expect(isUnreadFileWindow(ctx, call(6000), ['result-3', 'result-1', 'result-2'])).toBe(false)
  expect(isUnreadFileWindow(ctx, call(0), ['result-1', 'result-2', 'result-3'])).toBe(true)
  expect(isUnreadFileWindow(ctx, { toolName: 'fs.search', input: { path: 'large' } }, ['result-1'])).toBe(false)
})

it.each([true, false])('executes genuine mixed-batch pagination without opening a repeated-read bypass (%s)', async unread => {
  let models = 0
  const dispatched: any[] = [], requests: any[] = []
  const program = defineLaneProgram({ id: 'mixed-pages', version: '1', includeLaneHistory: true }, b => {
    b.addReActLoopStep('work', {
      instruction: 'Implement the change', toolAllow: ['fs.read', 'fs.search', 'fs.write'], maxTurns: 8,
      preserveReadContinuations: true, blockReadOnlyTools: () => true,
      onMaxTurns: () => ({ fail: { code: 'NO_PROGRESS', message: 'bounded' } }),
      onFinish: ref => ({ complete: { value: ref } }),
    })
  })
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') {
      dispatched.push(e.input)
      const { name, arguments: a } = e.input as any
      return { value: name === 'fs.read' ? { path: a.path, hash: 'v1', content: 'page', offset: a.offset ?? 0, nextOffset: (a.offset ?? 0) + 3000 } : { path: 'out', hash: 'v2', changed: true } }
    }
    requests.push(e.input); models++
    if (models === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'large', offset: 0 } }] } }
    if (models === 2 || !unread) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'large', offset: unread ? 3000 : 0 } }, { name: 'fs.search', input: { path: 'large', query: 'known' } }] } }
    if (models === 3) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'out', content: 'change' } }] } }
    return { value: { text: 'done' } }
  } })
  const { agentId } = r.createAgent({ goal: 'Implement change', program })
  const result = await r.start(agentId).outcome()
  expect(dispatched.filter(c => c.name === 'fs.search')).toHaveLength(0)
  expect(dispatched.filter(c => c.name === 'fs.read')).toHaveLength(unread ? 2 : 1)
  if (unread) {
    expect(result.status).toBe('succeeded')
    expect(JSON.stringify(requests[2])).toContain('These other calls were NOT executed: fs.search')
    expect(dispatched.some(c => c.name === 'fs.write')).toBe(true)
  } else {
    expect(result.status).toBe('failed')
    expect(models).toBeLessThanOrEqual(5)
  }
})
