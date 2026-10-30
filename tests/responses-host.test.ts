import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createProviderAdapter } from '@hunterzhu/pulse-adapters'
import { ContextBuilder, type JsonValue, type LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { ResponsesAdapter } from '../packages/adapters/src/providers/responses.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { normalizeModelConfig } from '../packages/server/src/model-config.js'
import { captureProviderApiModes, restoreProviderApiModes } from '../packages/server/src/run-provider-modes.js'

async function fixture() {
  const requests: Array<{ path: string; body: any }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()), path = req.url!
    requests.push({ path, body })
    const assessment = body.text?.format?.schema?.properties?.status || body.response_format?.json_schema?.schema?.properties?.status
    const reply = assessment ? JSON.stringify({status:'unverifiable',criteria:[{criterionId:'criterion-1',status:'unverifiable',rationale:'Protocol fixture has no independent business acceptance.',evidenceRefs:[]}],note:'Local protocol fixture only.'}) : 'Local fixture finished.'
    const output = requests.length === 1 ? [
      { type: 'reasoning', id: 'rs-local', encrypted_content: 'local-private-replay', summary: [] },
      { type: 'function_call', id: 'fc-local', call_id: 'native-call', name: body.tools?.find((tool: any) => tool.name === 'fs_write')?.name ?? 'fs_write', arguments: '{"path":"local.txt","content":"fixture"}' },
    ] : requests.length === 2 ? [{ type: 'function_call', id: 'fc-history', call_id: 'history-call', name: 'task_history', arguments: '{}' }] : [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: reply }] }]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(path.endsWith('/responses') ? { status: 'completed', output, usage: { input_tokens: 11, output_tokens: 5 } } : { choices: [{ message: requests.length === 2 ? { content: '', tool_calls: [{id:'history-call',type:'function',function:{name:'task_history',arguments:'{}'}}] } : { content: reply }, finish_reason: requests.length === 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { requests, baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}

it.each(['same', 'changed-config', 'legacy-input'] as const)('keeps the actual CLI→Host→disk→resume protocol and private continuation boundary (%s)', async variant => {
  const local = await fixture(), root = await mkdtemp(join(tmpdir(), 'pulse-responses-host-'))
  const configPath = join(root, 'fixture.json'), dataDir = join(root, 'data')
  const config = { cwd: root, dataDir, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', capabilities: { enabled: [] }, activeModel: 'fixture/model', providers: { fixture: { provider: 'openai-compatible', apiMode: 'responses', baseURL: local.baseURL, maxContextTokens: 65536, models: { model: { modelCode: 'local-model' } } } } }
  let first: ReturnType<typeof createLocalHost> | undefined, second: ReturnType<typeof createLocalHost> | undefined
  try {
    await writeFile(configPath, JSON.stringify(config))
    const options = await hostOptions(parse(['--config', configPath, '--no-task-controller']))
    expect(options.provider).toMatchObject({ apiMode: 'responses', continuationNamespace: 'fixture' })
    expect(options.providerProfiles?.fixture).toMatchObject({ apiMode: 'responses', continuationNamespace: 'fixture' })
    first = createLocalHost(options)
    const conversation = await first.createConversation()
    const run = await first.sendMessage(conversation.id, { text: 'Create local.txt with fixture, only a local scripted task.' })
    const events: unknown[] = []
    for await (const event of run.events) { events.push(event); if (event.type === 'waiting') break }
    expect(local.requests).toHaveLength(1)
    expect(local.requests[0]!.path).toBe('/v1/responses')
    const runId = (await first.getConversation(conversation.id)).summary.activeRunId!
    const inputPath = join(options.dataDir!, 'conversations', conversation.id, 'runs', runId, 'input.json')
    const saved = JSON.parse(await readFile(inputPath, 'utf8'))
    expect(saved.providerApiModes).toEqual({ schemaVersion: 1, modes: { fixture: 'responses' } })
    expect(JSON.stringify(saved)).not.toContain('local-private-replay')
    const runtime = (first as any).active.get(runId).runtime
    runtime.cancelAgent = () => {} // Simulate the existing interrupted-snapshot fixture without settling its pending approval.
    await first.close()
    if (variant === 'changed-config') {
      config.providers.fixture.apiMode = 'chat-completions'
      await writeFile(configPath, JSON.stringify(config))
    }
    if (variant === 'legacy-input') { delete saved.providerApiModes; await writeFile(inputPath, JSON.stringify(saved)) }
    second = createLocalHost(await hostOptions(parse(['--config', configPath, '--no-task-controller'])))
    const resumed = await second.resumeRun(conversation.id)
    for await (const event of resumed.events) {
      events.push(event)
      if (event.type === 'waiting') await resumed.reply((event.data as { effectId: string }).effectId, { approved: true })
    }
    expect((await resumed.outcome()).status).toBe('succeeded')
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('fixture')
    // Three work turns (including real task.history) plus one final-assessment request, all on the
    // persisted protocol. The assessment is not an adapter retry/fallback.
    expect(local.requests).toHaveLength(4)
    expect(local.requests[0]!.body.tools.length).toBeGreaterThan(0)
    expect(local.requests[1]!.body.tools.length).toBeGreaterThan(0)
    expect(local.requests[2]!.body.tools.length).toBeGreaterThan(0)
    expect(local.requests[3]!.body.tools).toBeUndefined()
    expect(local.requests.slice(1).map(row => row.path)).toEqual(Array(3).fill(variant === 'legacy-input' ? '/v1/chat/completions' : '/v1/responses'))
    expect(JSON.stringify(events)).not.toContain('local-private-replay')
    expect(JSON.stringify(await second.getConversation(conversation.id))).not.toContain('local-private-replay')
    const recalled = local.requests[2]!.body.input?.find((item: any) => item.type === 'function_call_output' && item.call_id === 'history-call')?.output ?? local.requests[2]!.body.messages?.find((item: any) => item.role === 'tool' && item.tool_call_id === 'history-call')?.content
    expect(recalled).toBeDefined()
    expect(recalled).not.toContain('local-private-replay')
    expect(recalled).not.toContain('providerContinuation')
    const ledger = JSON.parse(await readFile(join(options.dataDir!, 'conversations', conversation.id, 'runs', runId, 'model-budget.json'), 'utf8'))
    expect(ledger.used).toBe(4)
    expect(JSON.stringify(local.requests[1]!.body).includes('local-private-replay')).toBe(variant === 'same')
  } finally { await second?.close(); await first?.close(); await local.close(); await rm(root, { recursive: true, force: true }) }
})

it('projects LLM private continuation out of ordinary evidence while keeping tool bodies and same-profile replay', async () => {
  const requests: Array<{ path: string; body: any }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url!, body })
    const assessment = body.text?.format?.schema?.properties?.status || body.response_format?.json_schema?.schema?.properties?.status
    const echo = (body.tools ?? []).find((tool: { name?: string }) => tool.name === 'local-evidence_echo' || tool.name === 'local-evidence.echo')?.name
    const output = assessment
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ status: 'unverifiable', criteria: [], note: 'Local evidence fixture only.' }) }] }]
      : requests.length === 1
        ? [{ type: 'reasoning', id: 'rs-local', encrypted_content: 'LOCAL_PRIVATE_CIPHER', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible plan' }] }, { type: 'function_call', id: 'fc-local', call_id: 'echo-call', name: echo ?? 'missing-fixture-tool', arguments: '{}' }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer' }] }]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 11, output_tokens: 5 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const profile = { provider: 'openai-compatible' as const, apiMode: 'responses' as const, baseURL, defaultModel: 'local-model', continuationNamespace: 'fixture', maxContextTokens: 65536 }
  const root = await mkdtemp(join(tmpdir(), 'pulse-responses-evidence-'))
  const execute = ResponsesAdapter.prototype.executeAttempt
  let hostConfig: Record<string, unknown> | undefined
  vi.spyOn(ResponsesAdapter.prototype, 'executeAttempt').mockImplementation(function (this: ResponsesAdapter, ...args) {
    hostConfig ??= structuredClone((this as unknown as { config: Record<string, unknown> }).config)
    return execute.apply(this, args)
  })
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: profile, jarvis: { enabled: false }, taskController: false, approvalMode: 'auto', enabledCapabilityPacks: ['local-evidence'], capabilityPacks: [{ manifest: { id: 'local-evidence', version: '1', kind: 'integration', title: 'Local evidence', description: 'Returns ordinary tool data' }, activate: async () => ({ tools: [defineTool({ name: 'local-evidence.echo', description: 'Return ordinary local tool data', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => ({ providerContinuation: 'KEEP_TOOL_KEY', visible: 'VISIBLE_TOOL', raw: 'TOOL_RAW_MARKER' }) })] }) }] })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: 'Call the local evidence fixture.' })
    let runtime: any, registry: any
    for await (const event of run.events) {
      const current = (host as any).active.get(run.id)
      if (current) { runtime = current.runtime; registry = current.registry }
      if (event.type === 'waiting') await run.reply((event.data as { effectId: string }).effectId, { approved: true })
    }
    expect((await run.outcome()).status).toBe('succeeded')
    expect(runtime).toBeDefined()
    expect(requests[0]!.path).toBe('/v1/responses')
    expect(JSON.stringify(requests[0]!.body)).not.toContain('LOCAL_PRIVATE_CIPHER')
    expect(requests.slice(1).some(row => JSON.stringify(row.body).includes('LOCAL_PRIVATE_CIPHER'))).toBe(true)
    const llmResult = [...runtime.state.results.values()].find((result: any) => JSON.stringify(result.value).includes('LOCAL_PRIVATE_CIPHER'))
    const toolResult = [...runtime.state.results.values()].find((result: any) => JSON.stringify(result.value).includes('KEEP_TOOL_KEY'))
    const answer = [...runtime.state.results.values()].find((result: any) => JSON.stringify(result.value).includes('Visible answer'))
    expect(llmResult).toBeDefined()
    expect(toolResult).toBeDefined()
    expect(answer).toBeDefined()
    const evidence = async (result: any) => {
      const effect = runtime.state.effects.get(result.effectId)
      const context = { agentId: effect.agentId, laneId: effect.ownerLaneId, effectId: 'evidence-probe', toolCallId: 'evidence-probe', attemptId: 'evidence-probe', signal: new AbortController().signal, emit() {} }
      let offset = 0, content = ''
      for (let page = 0; page < 8; page++) {
        const window = await registry.get('task.evidence').execute({ ref: result.id, offset }, context)
        content += window.content
        if (window.nextOffset == null) return content
        expect(window.nextOffset).toBeGreaterThan(offset)
        offset = window.nextOffset
      }
      throw new Error('EVIDENCE_PAGE_LIMIT')
    }
    const llmEvidence = await evidence(llmResult)
    const toolEvidence = await evidence(toolResult)
    const answerEvidence = await evidence(answer)
    expect(llmEvidence).toContain('Visible plan')
    expect(llmEvidence).not.toContain('LOCAL_PRIVATE_CIPHER')
    expect(answerEvidence).toContain('Visible answer')
    expect(answerEvidence).not.toContain('LOCAL_PRIVATE_CIPHER')
    expect(toolEvidence).toContain('KEEP_TOOL_KEY')
    expect(toolEvidence).toContain('VISIBLE_TOOL')
    expect(toolEvidence).toContain('TOOL_RAW_MARKER')
    await expect(registry.get('task.evidence').execute({ ref: 'missing-result', offset: 0 }, { agentId: runtime.state.effects.get(llmResult.effectId).agentId, laneId: runtime.state.effects.get(llmResult.effectId).ownerLaneId, effectId: 'evidence-probe', toolCallId: 'evidence-probe', attemptId: 'evidence-probe', signal: new AbortController().signal, emit() {} })).rejects.toThrow('RESULT_NOT_VISIBLE')
    const effect = runtime.state.effects.get(llmResult.effectId)
    const lane = runtime.state.lanes.get(effect.ownerLaneId)
    const agent = runtime.state.agents.get(effect.agentId)
    const ordinary = new ContextBuilder(runtime.state).build({ agent, lane, explicitContext: true, includeLaneHistory: true, resultRefs: [llmResult.id, toolResult.id, answer.id], instruction: 'inspect', toolSetId: 'evidence' })
    const ordinaryText = JSON.stringify(ordinary.blocks)
    expect(ordinaryText).not.toContain('LOCAL_PRIVATE_CIPHER')
    expect(ordinaryText).toContain('Visible plan')
    expect(ordinaryText).toContain('Visible answer')
    expect(ordinaryText).toContain('KEEP_TOOL_KEY')
    expect(ordinaryText).toContain('TOOL_RAW_MARKER')
    const trusted = new ContextBuilder(runtime.state).build({ agent, lane, resultRefs: [llmResult.id], instruction: 'inspect', toolSetId: 'evidence' })
    expect(JSON.stringify(trusted.blocks.filter(block => block.kind !== 'provider_history'))).not.toContain('LOCAL_PRIVATE_CIPHER')
    expect(JSON.stringify(llmResult.value.providerContinuation)).toContain('LOCAL_PRIVATE_CIPHER')
    const providerBlock = trusted.blocks.find(block => block.kind === 'provider_history')
    if (providerBlock) expect(JSON.stringify(providerBlock)).toContain('LOCAL_PRIVATE_CIPHER')
    const call = llmResult.value.toolCalls[0]
    const history = [
      { role: 'assistant' as const, content: llmResult.value.text ?? '', continuationProvider: llmResult.value.providerContinuation.provider, providerMetadata: llmResult.value.providerContinuation.metadata, toolCalls: [{ id: call.providerToolCallId, name: call.providerToolName, arguments: call.providerToolArguments }] },
      { role: 'tool' as const, toolCallId: call.providerToolCallId, name: call.providerToolName, content: JSON.stringify(toolResult.value), resultRef: toolResult.id },
    ]
    const projected = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [toolResult.id], eventIds: [], toolSetId: 'evidence', instruction: 'inspect', privacy: 'public' as const, privacyRefs: [], providerHistory: history }, blocks: [{ kind: 'system' as const, content: 'Local scripted fixture' }, { kind: 'provider_history' as const, content: history as unknown as JsonValue }, { kind: 'instruction' as const, content: 'inspect' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: '1', privacy: 'public' as const, privacyRefs: [] } satisfies LLMRequestProjection
    const before = requests.length
    const hostModel = requests.find(row => JSON.stringify(row.body).includes('LOCAL_PRIVATE_CIPHER'))!.body.model as string
    expect(hostConfig).toBeDefined()
    await new ResponsesAdapter(String(hostConfig!.provider), { ...hostConfig!, continuationNamespace: 'other-profile' } as ConstructorParameters<typeof ResponsesAdapter>[1]).executeAttempt({ request: projected, model: hostModel, signal: new AbortController().signal })
    const other = JSON.stringify(requests[before]!.body)
    expect(other).not.toContain('LOCAL_PRIVATE_CIPHER')
    expect(other).toContain('KEEP_TOOL_KEY')
    expect(other).toContain('VISIBLE_TOOL')
    expect(other).toContain('TOOL_RAW_MARKER')
    expect(other).toContain('Visible plan')
    await new ResponsesAdapter(String(hostConfig!.provider), hostConfig! as ConstructorParameters<typeof ResponsesAdapter>[1]).executeAttempt({ request: projected, model: hostModel, signal: new AbortController().signal })
    const same = JSON.stringify(requests[before + 1]!.body)
    expect(same).toContain('LOCAL_PRIVATE_CIPHER')
    expect(same).toContain('KEEP_TOOL_KEY')
    expect(same).toContain('Visible plan')
  } finally {
    vi.restoreAllMocks()
    await host.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('validates explicit protocol selection and never upgrades legacy options from current config', () => {
  expect(createProviderAdapter({ provider: 'openai' }).name).toBe('OpenAI Compatible')
  expect(createProviderAdapter({ provider: 'openai', apiMode: 'responses' }).name).toBe('OpenAI Responses')
  expect(() => createProviderAdapter({ provider: 'anthropic', apiMode: 'responses' })).toThrow('PROVIDER_RESPONSES_UNSUPPORTED')
  expect(() => normalizeModelConfig({ providers: { bad: { provider: 'openai', apiMode: 'automatic' } } })).toThrow('PROVIDER_API_MODE_INVALID')
  const options = { activeProviderCode: 'a', provider: { provider: 'openai', apiMode: 'responses' as const }, providerProfiles: { a: { provider: 'openai', apiMode: 'responses' as const } } }
  expect(restoreProviderApiModes(options, undefined).provider.apiMode).toBe('chat-completions')
  expect(restoreProviderApiModes(options, captureProviderApiModes(options)).provider.apiMode).toBe('responses')
  expect(() => restoreProviderApiModes(options, { schemaVersion: 1, modes: { a: 'auto' } })).toThrow('PROVIDER_API_MODE_SNAPSHOT_INVALID')
})
