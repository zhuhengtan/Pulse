import { describe, expect, it } from 'vitest'
import { defineTool, ToolRegistry } from '@pulse/tool-sdk'
import { z } from 'zod'

describe('ToolContext and manifest contract', () => {
  it('passes stable execution correlation and supports resource resolution', async () => {
    let seen: { effectId: string; attemptId: string; laneId: string; aborted: boolean } | undefined
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'contextual', input: z.object({ value: z.number() }), output: z.object({ value: z.number() }),
      description: 'contextual tool', locks: [{ resource: 'file', mode: 'exclusive' }],
      resolveResources: () => [{ resource: 'file', mode: 'exclusive' }],
      execute: (input, context) => { seen = { effectId: context.effectId, attemptId: context.attemptId, laneId: context.laneId, aborted: context.signal.aborted }; return input },
    }))
    const controller = new AbortController()
    const detailed = await registry.executeDetailed('contextual', { value: 4 }, { toolCallId: 'call-1', effectId: 'effect-1', attemptId: 'attempt-1', agentId: 'agent-1', laneId: 'lane-1', signal: controller.signal, emit: () => {} })
    expect(seen).toEqual({ effectId: 'effect-1', attemptId: 'attempt-1', laneId: 'lane-1', aborted: false })
    expect(detailed.output).toEqual({ value: 4 })
    expect(registry.resolveResources('contextual', { value: 4 })).toEqual([{ resource: 'file', mode: 'exclusive' }])
  })

  it('uses trusted workspace locks when a tool does not resolve resources', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'read', description: 'read', sideEffectPolicy: 'read', input: z.object({}), output: z.object({}), execute: () => ({}) }))
    registry.register(defineTool({ name: 'write', description: 'write', sideEffectPolicy: 'write', input: z.object({}), output: z.object({}), execute: () => ({}) }))
    registry.register(defineTool({ name: 'none', description: 'none', sideEffectPolicy: 'none', input: z.object({}), output: z.object({}), execute: () => ({}) }))
    registry.register(defineTool({ name: 'explicit-none', description: 'explicit none', sideEffectPolicy: 'write', locks: [], input: z.object({}), output: z.object({}), execute: () => ({}) }))
    expect(registry.admission('read', {}).locks).toEqual([{ resource: 'workspace', mode: 'shared' }])
    expect(registry.admission('write', {}).locks).toEqual([{ resource: 'workspace', mode: 'exclusive' }])
    expect(registry.admission('none', {}).locks).toEqual([])
    expect(registry.admission('explicit-none', {}).locks).toEqual([])
  })

  it('treats external tools as remote side effects with unsafe retry defaults', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'remote-job', description: 'remote job', sideEffectPolicy: 'external', input: z.object({}), output: z.object({}), execute: () => ({}) }))
    expect(registry.admission('remote-job', {})).toMatchObject({ sideEffectPolicy: 'external', retrySafety: 'unsafe', locks: [{ resource: 'external:remote-job', mode: 'exclusive' }] })
  })

  it('rejects manifests that do not declare abort support', () => {
    const registry = new ToolRegistry()
    expect(() => registry.register(defineTool({ name: 'unsafe', description: 'unsafe', supportsAbortSignal: false, input: z.object({}), output: z.object({}), execute: () => ({}) }))).toThrow('TOOL_ABORT_SIGNAL_REQUIRED')
  })

  it('enforces Host allow/deny policy before discovery, admission, and execution', async () => {
    const registry = new ToolRegistry({ allow: ['read', 'blocked'], deny: ['blocked'] })
    registry.register(defineTool({ name: 'read', description: 'read', tags: ['safe'], input: z.object({}), output: z.object({ ok: z.boolean() }), execute: () => ({ ok: true }) }))
    registry.register(defineTool({ name: 'blocked', description: 'blocked', tags: ['unsafe'], input: z.object({}), output: z.object({ ok: z.boolean() }), execute: () => ({ ok: true }) }))
    expect(registry.list().map((manifest) => manifest.name)).toEqual(['read'])
    expect(registry.discover({}).map((result) => result.manifest.name)).toEqual(['read'])
    expect(registry.get('blocked')).toBeUndefined()
    expect(() => registry.admission('blocked', {})).toThrow('TOOL_NOT_ALLOWED:blocked')
    await expect(registry.execute('blocked', {}, new AbortController().signal)).rejects.toThrow('TOOL_NOT_ALLOWED:blocked')
  })
})
