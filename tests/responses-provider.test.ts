import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { LLMRequestProjection, ProviderHistoryMessage } from '@hunterzhu/pulse-runtime'
import { appendHistory, ContextBuilder, createAgent, createRuntimeState, type JsonValue } from '@hunterzhu/pulse-runtime'
import { ResponsesAdapter } from '../packages/adapters/src/providers/responses.js'
import { createModelEffectExecutor } from '@hunterzhu/pulse-adapters'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'

const request: LLMRequestProjection = {
  contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'responses-test', instruction: 'Use local tools', privacy: 'public', privacyRefs: [] },
  blocks: [{ kind: 'system', content: 'Local scripted fixture' }, { kind: 'tools', content: [{ name: 'fs.read', description: 'Read local file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }, { kind: 'instruction', content: 'Use local tools' }],
  prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: '1', privacy: 'public', privacyRefs: [],
}
const terminal = (output: unknown[], status = 'completed') => ({ id: 'resp_fixture', status, output, usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } })
const message = (value: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value }] })
const sse = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) }
async function fixture(reply: (sent: any, index: number) => { value?: unknown; stream?: string; status?: number; hang?: boolean }) {
  const requests: Array<{ path: string; json: any }> = []
  const server = createServer(async (req, res) => {
    const sent = await body(req); requests.push({ path: req.url!, json: sent })
    let answer: ReturnType<typeof reply>
    try { answer = reply(sent, requests.length) } catch (cause) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(cause) } })); return }
    res.writeHead(answer.status ?? 200, { 'content-type': answer.stream === undefined ? 'application/json' : 'text/event-stream' })
    if (answer.hang) { res.write(answer.stream ?? ''); return }
    res.end(answer.stream ?? JSON.stringify(answer.value))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  return { url, requests, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
const options = (url: string) => ({ provider: 'openai', apiMode: 'responses' as const, baseURL: url, defaultModel: 'fixture-model', continuationNamespace: 'test-profile', apiKey: 'fake-local-key' })

describe('explicit stateless Responses protocol', () => {
  it('uses real loopback HTTP, flat tools, strict text.format, call_id and measured usage', async () => {
    const local = await fixture(sent => ({ value: terminal([{ type: 'function_call', status: 'completed', call_id: 'stable-call', name: sent.tools[0].name, arguments: '{"path":"local.txt"}' }]) }))
    try {
      const result = await new ResponsesAdapter('test', options(local.url)).executeAttempt({ request, signal: new AbortController().signal, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, maxOutputTokens: 123 })
      expect(local.requests).toHaveLength(1)
      expect(local.requests[0]!.path).toBe('/v1/responses')
      expect(local.requests[0]!.json).toMatchObject({ model: 'fixture-model', store: false, max_output_tokens: 123, include: ['reasoning.encrypted_content'], text: { format: { type: 'json_schema', strict: true } }, tools: [{ type: 'function', name: expect.any(String), parameters: expect.any(Object) }] })
      expect(local.requests[0]!.json).not.toHaveProperty('messages')
      expect(result.toolCalls).toMatchObject([{ providerToolCallId: 'stable-call', name: 'fs.read', input: { path: 'local.txt' } }])
      expect(result.finishReason).toBe('tool_calls')
      expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 4, reasoningTokens: 3 })
    } finally { await local.close() }
  })

  it('streams typed deltas but takes final output once; replays only private scoped encrypted reasoning in order', async () => {
    const local = await fixture(sent => ({ stream: sse('response.reasoning_summary_text.delta', { delta: 'thinking' }) + sse('response.output_text.delta', { delta: 'answer' }) + sse('response.completed', { response: terminal([{ type: 'reasoning', status: 'completed', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-local-data', private_debug: 'never retain' }, message('answer'), { type: 'function_call', status: 'completed', call_id: 'call-1', name: sent.tools[0].name, arguments: '{"path":"a"}' }]) }) }))
    try {
      const adapter = new ResponsesAdapter('test', options(local.url)), deltas: string[] = [], reasoning: string[] = []
      const result = await adapter.executeAttempt({ request, signal: new AbortController().signal, onObservation: value => deltas.push(value), onReasoning: value => reasoning.push(value) })
      expect(result.text).toBe('answer'); expect(deltas).toEqual(['answer']); expect(reasoning).toEqual(['thinking'])
      expect(JSON.stringify(result.providerContinuation)).not.toContain('never retain')
      expect(JSON.stringify(result.providerContinuation)).not.toContain('fake-local-key')
      const history: ProviderHistoryMessage[] = [{ role: 'assistant', content: result.text!, continuationProvider: result.providerContinuation!.provider, providerMetadata: result.providerContinuation!.metadata, toolCalls: [{ id: 'call-1', name: result.toolCalls[0]!.providerToolName!, arguments: result.toolCalls[0]!.providerToolArguments! }] }, { role: 'tool', toolCallId: 'call-1', name: 'fs.read', content: 'local output', resultRef: 'result-1' }]
      const continued: LLMRequestProjection = { ...request, blocks: [...request.blocks, { kind: 'provider_history', content: history as unknown as import('@hunterzhu/pulse-runtime').JsonValue }], contextSpec: { ...request.contextSpec, providerHistory: history } }
      await adapter.executeAttempt({ request: continued, signal: new AbortController().signal })
      const input = local.requests[1]!.json.input as Array<any>
      const index = input.findIndex(item => item.type === 'reasoning')
      expect(index).toBeGreaterThanOrEqual(0)
      expect(input[index]).toMatchObject({ encrypted_content: 'opaque-local-data' })
      expect(input.findIndex(item => item.type === 'function_call')).toBeGreaterThan(index)
      expect(input.findIndex(item => item.type === 'function_call_output')).toBeGreaterThan(input.findIndex(item => item.type === 'function_call'))
      for (const change of [{ defaultModel: 'different-model' }, { apiKey: 'rotated-fake-local-key' }, { continuationNamespace: 'other-profile' }]) {
        await new ResponsesAdapter('test', { ...options(local.url), ...change }).executeAttempt({ request: continued, signal: new AbortController().signal })
        expect(local.requests.at(-1)!.json.input.some((item: any) => item.type === 'reasoning')).toBe(false)
      }
    } finally { await local.close() }
  })

  it('never executes partial function calls and rejects EOF/failure without changing protocol or retrying', async () => {
    const local = await fixture((_sent, index) => index === 1 ? { value: terminal([{ type: 'function_call', status: 'in_progress', call_id: 'partial', name: 'read', arguments: '{' }], 'incomplete') } : index === 2 ? { stream: sse('response.output_text.delta', { delta: 'partial' }) } : index === 3 ? { stream: sse('response.failed', { response: { status: 'failed', error: { message: 'fixture' } } }) } : { status: 500, value: { error: { message: 'fixture only' } } })
    try {
      const adapter = new ResponsesAdapter('test', options(local.url))
      expect(await adapter.executeAttempt({ request, signal: new AbortController().signal })).toMatchObject({ finishReason: 'length', toolCalls: [] })
      await expect(adapter.executeAttempt({ request, signal: new AbortController().signal, onObservation: () => {} })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' })
      await expect(adapter.executeAttempt({ request, signal: new AbortController().signal, onObservation: () => {} })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' })
      await expect(adapter.executeAttempt({ request, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PROVIDER_HTTP_500' })
      expect(local.requests.map(row => row.path)).toEqual(Array(4).fill('/v1/responses'))
    } finally { await local.close() }
  })

  it('supports refusal and cancels an open real SSE response without returning tools', async () => {
    const local = await fixture((_sent, index) => index === 1 ? { value: terminal([{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'fixture refusal' }] }]) } : { stream: sse('response.output_text.delta', { delta: 'before cancel' }), hang: true })
    try {
      const adapter = new ResponsesAdapter('test', options(local.url))
      expect(await adapter.executeAttempt({ request, signal: new AbortController().signal })).toMatchObject({ refusal: 'fixture refusal', finishReason: 'refusal', toolCalls: [] })
      const abort = new AbortController()
      await expect(adapter.executeAttempt({ request, signal: abort.signal, onObservation: () => abort.abort() })).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_CANCELLED', retryable: false })
      expect(local.requests).toHaveLength(2)
    } finally { await local.close() }
  })

  it('replays interleaved native items and phases once through real Runtime history, with private data excluded from visible blocks', async () => {
    const local = await fixture(sent => ({ value: terminal([
      { type: 'reasoning', id: 'rs-a', encrypted_content: 'cipher-a', summary: [] },
      { ...message('middle'), id: 'msg-a', phase: 'commentary' },
      { type: 'function_call', id: 'fc-a', call_id: 'call-a', name: sent.tools[0].name, arguments: '{"path":"a"}' },
      { type: 'reasoning', id: 'rs-b', encrypted_content: 'cipher-b', summary: [] },
      { ...message('final'), id: 'msg-b', phase: 'final_answer' },
      { type: 'function_call', id: 'fc-b', call_id: 'call-b', name: sent.tools[0].name, arguments: '{"path":"b"}' },
    ]) }))
    try {
      const adapter = new ResponsesAdapter('test', options(local.url))
      const result = await adapter.executeAttempt({ request, signal: new AbortController().signal })
      const state = createRuntimeState(), { agent, root } = createAgent(state, 'local', { programId: 'test', programVersion: '1', step: 'start', locals: {} })
      for (const [index] of result.toolCalls.entries()) {
        state.results.set(`result-${index}`, { id: `result-${index}`, value: { local: index }, privacy: 'public', derivedFrom: [], producer: { kind: 'effect', id: `effect-${index}` } })
        root.visibleResultRefs!.add(`result-${index}`)
        state.toolCallCorrelations.set(`runtime-${index}`, { toolCallId: `runtime-${index}`, llmEffectId: 'llm', toolEffectId: `effect-${index}`, resultRef: `result-${index}` })
      }
      const history = appendHistory(root, { instruction: 'read', resultRefs: ['result-0', 'result-1'], output: { ...result, toolCalls: result.toolCalls.map((call, index) => ({ ...call, toolCallId: `runtime-${index}` })) } as unknown as JsonValue, privacy: 'public' })
      const projected = new ContextBuilder(state).build({ agent, lane: history, resultRefs: ['result-0', 'result-1'], instruction: 'continue', toolSetId: 'tools' })
      projected.blocks = [...projected.blocks.filter(block => block.kind !== 'tools'), request.blocks.find(block => block.kind === 'tools')!]
      expect(JSON.stringify(projected.blocks.filter(block => block.kind !== 'provider_history'))).not.toContain('cipher-')
      await adapter.executeAttempt({ request: projected, signal: new AbortController().signal })
      const input = local.requests[1]!.json.input as any[]
      expect(input.filter(item => ['reasoning', 'message', 'function_call'].includes(item.type)).map(item => [item.type, item.phase ?? item.call_id ?? item.id])).toEqual([
        ['reasoning', 'rs-a'], ['message', 'commentary'], ['function_call', 'call-a'],
        ['reasoning', 'rs-b'], ['message', 'final_answer'], ['function_call', 'call-b'],
      ])
      expect(input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['call-a', 'call-b'])
      const damaged = structuredClone(projected)
      damaged.contextSpec.providerHistory!.find(item => item.role === 'assistant')!.content = 'changed visible output'
      await adapter.executeAttempt({ request: damaged, signal: new AbortController().signal })
      expect(JSON.stringify(local.requests.at(-1)!.json.input)).not.toContain('cipher-')
      for (const change of [{ maxOutputTokens: 321 }, { continuationConfigVersion: 'changed-config' }, { extraHeaders: { 'x-local': 'changed' } }]) {
        await new ResponsesAdapter('test', { ...options(local.url), ...change }).executeAttempt({ request: projected, signal: new AbortController().signal })
        expect(JSON.stringify(local.requests.at(-1)!.json.input)).not.toContain('cipher-')
      }
    } finally { await local.close() }
  })

  it('honors capability controls without protocol probing and rejects mixed refusals or oversized essential continuation', async () => {
    const local = await fixture((sent, index) => ({ value: terminal(index === 1 ? [message('{"ok":true}')] : index === 2 ? [
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] },
      { type: 'function_call', call_id: 'never-run', name: sent.tools[0].name, arguments: '{}' },
    ] : [{ type: 'reasoning', encrypted_content: 'x'.repeat(262145), summary: [] }, { type: 'function_call', call_id: 'never-run', name: sent.tools[0].name, arguments: '{}' }]) }))
    try {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
      const adapter = new ResponsesAdapter('test', { ...options(local.url), capabilityProfile: { structuredOutput: 'unsupported', reasoning: 'unsupported' }, reasoningEffort: 'high' })
      await adapter.executeAttempt({ request, outputSchema: schema, signal: new AbortController().signal })
      expect(local.requests[0]!.json).not.toHaveProperty('text')
      expect(local.requests[0]!.json).not.toHaveProperty('reasoning')
      expect(JSON.stringify(local.requests[0]!.json)).not.toContain('prompt_cache')
      await expect(adapter.executeAttempt({ request, signal: new AbortController().signal })).rejects.toThrow('REFUSAL_WITH_TOOLS')
      await expect(adapter.executeAttempt({ request, signal: new AbortController().signal })).rejects.toThrow('CONTINUATION_TOO_LARGE')
      expect(local.requests).toHaveLength(3)
    } finally { await local.close() }
  })

  it('keeps an explicitly configured model fallback separately budgeted and drops the first service continuation', async () => {
    const first = await fixture((_sent, index) => index === 1 ? { value: terminal([{ type: 'reasoning', encrypted_content: 'first-service-only', summary: [] }, message('prior')]) } : { status: 503, value: { error: { message: 'local fixture unavailable' } } })
    const second = await fixture(() => ({ value: terminal([message('fallback')]) }))
    try {
      const profileA = { ...options(first.url), defaultModel: 'model-a', continuationNamespace: 'a' }
      const profileB = { ...options(second.url), defaultModel: 'model-b', continuationNamespace: 'b' }
      const prior = await new ResponsesAdapter('openai', profileA).executeAttempt({ request, signal: new AbortController().signal })
      const history: ProviderHistoryMessage[] = [{ role: 'assistant', content: prior.text!, continuationProvider: prior.providerContinuation!.provider, providerMetadata: prior.providerContinuation!.metadata }]
      const continued: LLMRequestProjection = { ...request, blocks: [...request.blocks, { kind: 'provider_history', content: history as unknown as JsonValue }], contextSpec: { ...request.contextSpec, providerHistory: history } }
      const routing = createHostModelRouting({ activeModel: 'a/model', activeProviderCode: 'a', activeProvider: profileA, providerProfiles: { a: profileA, b: profileB }, providerModels: { 'a/model': { provider: 'a', model: 'model-a' }, 'b/model': { provider: 'b', model: 'model-b' } }, taskRouting: { reason: ['a/model', 'b/model'] } })
      let attempts = 0
      const executor = createModelEffectExecutor({ ...routing, beforeProviderAttempt: async () => { attempts++ } })
      const effect = { id: 'fallback-effect', agentId: 'agent', ownerLaneId: 'lane', kind: 'llm', input: { task: 'reason', request: continued }, attemptId: 'attempt', attemptNo: 1 } as unknown as import('@hunterzhu/pulse-runtime').EffectRecord
      const failed = await executor(effect, new AbortController().signal)
      expect(failed).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_HTTP_503', retryable: true } })
      expect(attempts).toBe(1)
      expect(second.requests).toHaveLength(0)
      // Re-enter on the next Runtime attempt; an adapter must never hide this request.
      const output = await executor({ ...effect, attemptId: 'attempt-2', attemptNo: 2 }, new AbortController().signal)
      expect(output.error).toBeUndefined()
      expect(output).toMatchObject({ value: { text: 'fallback' } })
      expect(attempts).toBe(2)
      expect(first.requests.map(row => row.path)).toEqual(['/v1/responses', '/v1/responses'])
      expect(second.requests.map(row => row.path)).toEqual(['/v1/responses'])
      expect(JSON.stringify(first.requests[1]!.json)).toContain('first-service-only')
      expect(JSON.stringify(second.requests[0]!.json)).not.toContain('first-service-only')
    } finally { await first.close(); await second.close() }
  })
})
