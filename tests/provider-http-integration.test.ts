import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { OpenAICompatibleAdapter } from '@pulse/adapters'
import type { LLMRequestProjection } from '@pulse/runtime'

const request: LLMRequestProjection = {
  contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'http@1', instruction: 'Reply with OK.', privacy: 'public', privacyRefs: [] },
  blocks: [{ kind: 'system', content: 'You are a test provider.' }, { kind: 'instruction', content: 'Reply with OK.' }],
  prefixHash: 'prefix',
  projectionHash: 'projection',
  builderVersion: '1',
  policyVersion: '1',
  toolSetVersion: 'http@1',
  privacy: 'public',
  privacyRefs: [],
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP_TEST_SERVER_ADDRESS_MISSING')
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) } }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

describe('Provider HTTP integration', () => {
  it('sends an OpenAI-compatible JSON request through the real loopback HTTP stack', async () => {
    let authorization: string | undefined
    let body: Record<string, unknown> | undefined
    const server = await startServer(async (req, res) => {
      authorization = req.headers.authorization
      body = await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }))
    })
    try {
      const result = await new OpenAICompatibleAdapter('loopback', { provider: 'openai', apiKey: 'loopback-secret', baseURL: server.url, defaultModel: 'loopback-model' }).executeAttempt({ request, signal: new AbortController().signal })
      expect(result.text).toBe('OK')
      expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 1 })
      expect(authorization).toBe('Bearer loopback-secret')
      expect(body).toMatchObject({ model: 'loopback-model', messages: expect.any(Array) })
    } finally { await server.close() }
  })

  it('reads real loopback SSE chunks and does not execute partial tool arguments', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'O' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'provider-call', function: { name: 'read', arguments: '{"path":"a' } }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'K' }, finish_reason: 'tool_calls' },], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    try {
      const chunks: string[] = []
      const result = await new OpenAICompatibleAdapter('loopback-stream', { provider: 'openai', baseURL: server.url }).executeAttempt({ request, signal: new AbortController().signal, onObservation: (chunk) => chunks.push(chunk) })
      expect(chunks).toEqual(['O', 'K'])
      expect(result.text).toBe('OK')
      expect(result.toolCalls[0]).toMatchObject({ name: 'read', input: { path: 'a' } })
    } finally { await server.close() }
  })
})
