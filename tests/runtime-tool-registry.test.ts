import { describe, expect, it } from 'vitest'
import { defineTool, ToolRegistry } from '@pulse/tool-sdk'
import { RuntimeToolRegistry, PulseRuntime } from '@pulse/runtime'
import { createToolEffectExecutor } from '@pulse/adapters'
import type { EffectRecord } from '@pulse/runtime'
import { z } from 'zod'

const echo = defineTool({ name: 'echo', description: 'echo input', input: z.object({ value: z.string() }), output: z.object({ value: z.string() }), execute: (input) => input })

describe('Runtime tool registry', () => {
  it('accepts Tool SDK definitions through runtime.tools.register', () => {
    const runtime = new PulseRuntime()
    runtime.tools.register(echo)
    expect(runtime.tools.list()).toEqual([expect.objectContaining({ name: 'echo', version: '1' })])
    expect(runtime.tools.compileToolSet('default').tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(runtime.exportPersistence().compatibility?.toolVersions).toMatchObject({ echo: '1' })
  })

  it('keeps allow/deny policy and schema admission fail-closed', async () => {
    const registry = new RuntimeToolRegistry({ allow: ['echo'], deny: ['blocked'] })
    registry.register(echo)
    expect(registry.isAllowed('blocked')).toBe(false)
    await expect(registry.execute('echo', { value: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
  })

  it('filters manifest workspace and network permissions before discovery or execution', () => {
    const remote = { ...echo, manifest: { ...echo.manifest, name: 'remote-echo', permissions: { workspaceRoots: ['/workspace/project'], networkHosts: ['api.example.com'] } } }
    const denied = new RuntimeToolRegistry({ workspaceRoots: ['/workspace'], allowNetwork: false })
    denied.register(remote)
    expect(denied.isAllowed('remote-echo')).toBe(false)
    expect(denied.permissionReasons('remote-echo')).toEqual(['NETWORK_DISABLED'])
    expect(denied.list()).toEqual([])
    expect(() => denied.admission('remote-echo', { value: 'x' })).toThrow('TOOL_NOT_ALLOWED')

    const allowed = new RuntimeToolRegistry({ workspaceRoots: ['/workspace'], networkHosts: ['api.example.com'] })
    allowed.register(remote)
    expect(allowed.isAllowed('remote-echo')).toBe(true)
    expect(allowed.compileToolSet('restricted').tools[0]).toMatchObject({ name: 'remote-echo', permissions: remote.manifest.permissions })
  })

  it('normalizes permission paths and host names before allowlist matching', () => {
    const traversal = { ...echo, manifest: { ...echo.manifest, name: 'traversal', permissions: { workspaceRoots: ['/workspace/../secret'], networkHosts: ['API.EXAMPLE.COM.'] } } }
    const runtimeRegistry = new RuntimeToolRegistry({ workspaceRoots: ['/workspace/'], networkHosts: ['api.example.com'] })
    runtimeRegistry.register(traversal)
    expect(runtimeRegistry.isAllowed('traversal')).toBe(false)
    expect(runtimeRegistry.permissionReasons('traversal')).toEqual(['WORKSPACE_ROOT_NOT_ALLOWED:/workspace/../secret'])

    const sdkRegistry = new ToolRegistry({ workspaceRoots: ['/workspace/'], networkHosts: ['api.example.com'] })
    sdkRegistry.register(traversal)
    expect(sdkRegistry.isAllowed('traversal')).toBe(false)
    expect(sdkRegistry.permissionReasons('traversal')).toEqual(['WORKSPACE_ROOT_NOT_ALLOWED:/workspace/../secret'])
  })

  it('can be consumed directly by the standard Tool Effect adapter', async () => {
    const registry = new RuntimeToolRegistry()
    registry.register(echo)
    const executor = createToolEffectExecutor(registry)
    const effect = { id: 'effect-tool-registry', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'echo', kind: 'tool', concurrencyClass: 'tool', input: { name: 'echo', arguments: { value: 'ok' } }, attemptId: 'attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
    await expect(executor(effect, new AbortController().signal)).resolves.toMatchObject({ value: { value: 'ok' }, executionState: 'succeeded' })
  })

  it('automatically prepares tool admission and dynamic tool sets before commit', () => {
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1 })
    runtime.tools.register(echo)
    const program = { id: 'runtime-tool-preparation', version: '1', step: () => ({ actions: [{ type: 'submit_effects' as const, effects: [{ key: 'echo', kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { name: 'echo', arguments: { value: 'ok' } } }, { key: 'discover', kind: 'llm' as const, concurrencyClass: 'llm' as const, input: { toolDiscovery: { text: 'echo' } } }] }], next: { programId: 'runtime-tool-preparation', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('prepare tools', program)
    runtime.tick()
    expect(runtime.state.effects.get('effect-1')).toMatchObject({ toolVersion: '1', attemptTimeoutMs: 30000, locks: [] })
    expect(runtime.state.effects.get('effect-2')?.input).toMatchObject({ toolSetId: expect.stringMatching(/^dynamic@/), tools: { tools: [{ name: 'echo' }] } })
    expect(runtime.state.agents.get(agentId)?.state).toBe('running')
  })
})
