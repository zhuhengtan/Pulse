import { describe, expect, it } from 'vitest'
import { createToolEffectExecutor } from '@pulse/adapters'
import { defineTool, ToolRegistry } from '@pulse/tool-sdk'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'
import { z } from 'zod'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('Tool SDK to Runtime Effect host', () => {
  it('executes a registered typed tool and preserves tool correlation', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({ name: 'add', description: 'adds', input: z.object({ a: z.number(), b: z.number() }), output: z.object({ sum: z.number() }), execute: ({ a, b }) => ({ sum: a + b }) }))
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(registry) })
    const program: LaneProgram = { id: 'tool-host', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'add-call', toolCallId: 'pulse-tool-1', kind: 'tool', concurrencyClass: 'tool', input: { name: 'add', arguments: { a: 2, b: 3 } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('tool-host', 'finish') }
      : { actions: [{ type: 'complete', result: { result: resumeInput?.type === 'wait' ? resumeInput.resolution.dependencies['add-call'] : null } }], next: point('tool-host', 'finish') } }
    const { agentId } = runtime.createAgent('tool', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect([...runtime.state.results.values()].some((result) => JSON.stringify(result.value).includes('result'))).toBe(true)
    expect(runtime.state.effects.get('effect-1')?.toolCallId).toBe('pulse-tool-1')
  })

  it('rejects unknown tools through the normal dispatch failure path', async () => {
    const runtime = new PulseRuntime({ effectExecutor: createToolEffectExecutor(new ToolRegistry()) })
    const program: LaneProgram = { id: 'unknown-tool', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'missing', kind: 'tool', concurrencyClass: 'tool', input: { name: 'missing', arguments: {} } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('unknown-tool', 'done') }) }
    const { agentId } = runtime.createAgent('unknown', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'effect.dispatch_failed')).toBe(true)
  })
})
