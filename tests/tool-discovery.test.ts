import { describe, expect, it } from 'vitest'
import { ToolRegistry, defineTool } from '@pulse/tool-sdk'
import { z } from 'zod'

describe('explicit dynamic tool discovery', () => {
  it('ranks deterministic catalog matches and preserves manifest tags', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'read_file', description: 'Read a file from the workspace', tags: ['filesystem', 'readonly'], input: z.object({ path: z.string() }), output: z.string(), sideEffectPolicy: 'read', execute: ({ path }) => path }))
    registry.register(defineTool({ name: 'search_web', description: 'Search remote web sources', tags: ['network', 'research'], input: z.object({ query: z.string() }), output: z.array(z.string()), sideEffectPolicy: 'none', execute: ({ query }) => [query] }))
    registry.register(defineTool({ name: 'write_file', description: 'Write a file in the workspace', tags: ['filesystem', 'mutation'], input: z.object({ path: z.string(), content: z.string() }), output: z.boolean(), sideEffectPolicy: 'write', execute: () => true }))

    expect(registry.discover({ text: 'read file', tags: ['readonly'] }).map((item) => item.manifest.name)).toEqual(['read_file'])
    expect(registry.discover({ tags: ['filesystem'], sideEffectPolicy: 'write' }).map((item) => item.manifest.name)).toEqual(['write_file'])
    expect(registry.discover({ text: 'file', limit: 2 }).map((item) => item.manifest.name)).toEqual(['read_file', 'write_file'])
    expect(registry.list().find((manifest) => manifest.name === 'read_file')?.tags).toEqual(['filesystem', 'readonly'])
  })

  it('rejects malformed discovery queries before catalog evaluation', () => {
    const registry = new ToolRegistry()
    expect(() => registry.discover({ text: 1 as never })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false }))
    expect(() => registry.discover({ tags: ['ok', 1 as never] })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false }))
    expect(() => registry.compileToolSet('invalid', { limit: -1 })).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false }))
  })
})
