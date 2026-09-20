import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, decodeLLMActions, OutputValidationError, validateStep } from '@pulse/runtime'

describe('LLM action decoder', () => {
  it('converts allowed tool calls into one Runtime submit action', () => {
    const actions = decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'pulse-tool-1', name: 'read_file', input: { path: 'a.txt' } }] }, { allowedTools: new Set(['read_file']) })
    expect(actions).toEqual([{ type: 'submit_effects', effects: [{ key: 'tool:pulse-tool-1', toolCallId: 'pulse-tool-1', kind: 'tool', concurrencyClass: 'tool', input: { toolCallId: 'pulse-tool-1', name: 'read_file', arguments: { path: 'a.txt' } } }], wait: { onUnsatisfied: 'resume_with_error', reason: 'effect' } }])
  })

  it('propagates tool-call privacy and provenance to the effect and input', () => {
    const actions = decodeLLMActions({ text: '', finishReason: 'tool_calls', privacy: 'local_only', derivedFrom: ['result:secret'], toolCalls: [{ toolCallId: 'pulse-tool-2', name: 'read_file', input: { path: 'secret.txt' } }] }, {
      allowedTools: new Set(['read_file']),
    })
    expect(actions[0]).toMatchObject({
      type: 'submit_effects',
      effects: [{
        privacy: 'local_only',
        derivedFrom: ['result:secret'],
        input: {
          privacy: 'local_only',
          derivedFrom: ['result:secret'],
        },
      }],
    })
  })

  it('rejects disallowed, malformed, and non-serializable actions', () => {
    expect(() => decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call-1', name: 'shell', input: {} }] }, { allowedTools: new Set(['read_file']) })).toThrow('ACTION_TOOL_NOT_ALLOWED')
    expect(() => decodeLLMActions({ text: '', finishReason: 'stop', toolCalls: [{ toolCallId: 'call-1', name: 'read_file', input: {} }] }, { allowedTools: new Set(['read_file']) })).toThrow(OutputValidationError)
    expect(() => decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call-1', name: 'read_file', input: { value: () => 1 } }] }, { allowedTools: new Set(['read_file']) })).toThrow('ACTION_INPUT_NOT_SERIALIZABLE')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call-1', name: 'read_file', input: cyclic }] }, { allowedTools: new Set(['read_file']) })).toThrow('ACTION_INPUT_NOT_SERIALIZABLE')
  })

  it('rejects reusing a toolCallId for a second logical ToolEffect', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'tool correlation', { programId: 'tool', programVersion: '1', step: 'start', locals: {} })
    const first = validateStep(state, root.id, { actions: [{ type: 'submit_effects', effects: [{ key: 'first', toolCallId: 'pulse-tool-1', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: { programId: 'tool', programVersion: '1', step: 'next', locals: {} } })
    expect('rejection' in first).toBe(false)
    if (!('rejection' in first)) apply(state, first.mutations)
    expect('rejection' in validateStep(state, root.id, { actions: [{ type: 'submit_effects', effects: [{ key: 'second', toolCallId: 'pulse-tool-1', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: { programId: 'tool', programVersion: '1', step: 'next', locals: {} } })).toBe(true)
  })
})
