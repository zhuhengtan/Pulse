import { describe, expect, it } from 'vitest'
import { decodeLLMActions, OutputValidationError } from '@pulse/runtime'

describe('LLM action decoder', () => {
  it('converts allowed tool calls into one Runtime submit action', () => {
    const actions = decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'pulse-tool-1', name: 'read_file', input: { path: 'a.txt' } }] }, { allowedTools: new Set(['read_file']) })
    expect(actions).toEqual([{ type: 'submit_effects', effects: [{ key: 'tool:pulse-tool-1', toolCallId: 'pulse-tool-1', kind: 'tool', concurrencyClass: 'tool', input: { toolCallId: 'pulse-tool-1', name: 'read_file', arguments: { path: 'a.txt' } } }], wait: { onUnsatisfied: 'resume_with_error', reason: 'effect' } }])
  })

  it('rejects disallowed, malformed, and non-serializable actions', () => {
    expect(() => decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call-1', name: 'shell', input: {} }] }, { allowedTools: new Set(['read_file']) })).toThrow('ACTION_TOOL_NOT_ALLOWED')
    expect(() => decodeLLMActions({ text: '', finishReason: 'stop', toolCalls: [{ toolCallId: 'call-1', name: 'read_file', input: {} }] }, { allowedTools: new Set(['read_file']) })).toThrow(OutputValidationError)
    expect(() => decodeLLMActions({ text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call-1', name: 'read_file', input: { value: () => 1 } }] }, { allowedTools: new Set(['read_file']) })).toThrow('ACTION_INPUT_NOT_SERIALIZABLE')
  })
})
