import { describe, expect, it, vi } from 'vitest'
import { CapabilityPackRegistry, referenceCapabilityPackCatalog, type CapabilityPack } from '../packages/server/src/capabilities.js'
import type { ToolDefinition } from '@hunterzhu/pulse-tool-sdk'

function mockTool(name: string): ToolDefinition {
  return { manifest: { name } } as ToolDefinition
}

function pack(id: string, activate: CapabilityPack['activate']): CapabilityPack {
  return { manifest: { id, version: '1', kind: 'integration', title: id, description: `${id} reference pack` }, activate }
}

describe('CapabilityPackRegistry', () => {
  it('requires explicit registration and explicit activation', async () => {
    const registry = new CapabilityPackRegistry()
    registry.register(pack('browser', async () => ({ tools: [mockTool('browser.open')] })))

    expect(registry.list().map((manifest) => manifest.id)).toEqual(['browser'])
    expect((await registry.activate([], { workspaceRoot: '/workspace', config: {}, signal: new AbortController().signal })).tools).toEqual([])
    await expect(registry.activate(['skills'], { workspaceRoot: '/workspace', config: {}, signal: new AbortController().signal })).rejects.toThrow('UNKNOWN_CAPABILITY_PACK:skills')
  })

  it('activates namespaced tools, returns instructions and disposes once', async () => {
    const registry = new CapabilityPackRegistry()
    const dispose = vi.fn()
    registry.register(pack('pdf', async () => ({ tools: [mockTool('pdf.extract')], instructions: ['Cite page numbers.'], dispose })))

    const active = await registry.activate(['pdf'], { workspaceRoot: '/workspace', config: {}, signal: new AbortController().signal })
    expect(active.tools.map((tool) => tool.manifest.name)).toEqual(['pdf.extract'])
    expect(active.instructions).toEqual(['Cite page numbers.'])
    await active.dispose()
    await active.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('rolls back earlier adapters when later activation fails', async () => {
    const registry = new CapabilityPackRegistry()
    const dispose = vi.fn()
    registry.register(pack('browser', async () => ({ tools: [mockTool('browser.open')], dispose })))
    registry.register(pack('pdf', async () => { throw new Error('ADAPTER_START_FAILED') }))

    await expect(registry.activate(['browser', 'pdf'], { workspaceRoot: '/workspace', config: {}, signal: new AbortController().signal })).rejects.toThrow('ADAPTER_START_FAILED')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects tools outside the pack namespace and reports optional references honestly', async () => {
    const registry = new CapabilityPackRegistry()
    registry.register(pack('spreadsheet', async () => ({ tools: [mockTool('shell.exec')] })))

    await expect(registry.activate(['spreadsheet'], { workspaceRoot: '/workspace', config: {}, signal: new AbortController().signal })).rejects.toThrow('CAPABILITY_TOOL_NAMESPACE_REQUIRED:spreadsheet')
    expect(referenceCapabilityPackCatalog.map((item) => item.id)).toEqual(['mcp', 'skills', 'jarvis', 'browser', 'pdf', 'spreadsheet'])
  })
})
