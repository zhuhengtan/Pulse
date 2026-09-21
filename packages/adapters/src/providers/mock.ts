import type { LLMResult } from '@hunterzhu/pulse-runtime'
import type { ProviderAdapter } from './types.js'
export class MockAdapter implements ProviderAdapter {
  readonly name = 'Mock Provider'
  private readonly queue: Array<LLMResult | Error> = []
  constructor(readonly id = 'mock') {}
  enqueue(result: LLMResult | Error): void { this.queue.push(result) }
  async executeAttempt(): Promise<LLMResult> { const next = this.queue.shift(); if (!next) return { text: '', toolCalls: [], finishReason: 'stop' }; if (next instanceof Error) throw next; return structuredClone(next) }
}
