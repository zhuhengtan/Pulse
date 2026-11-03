import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { ContextBuilder, appendHistory, createAgent, createRuntimeState } from '../../packages/runtime/dist/index.js'
import { createProviderAdapter } from '../../packages/adapters/dist/index.js'
import { lowerProjectionToCanonical } from '../../packages/adapters/dist/providers/canonical/lowering.js'
import { RequestDiagnostics } from '../../packages/adapters/dist/providers/request-diagnostics.js'

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, provider: { type: 'string', default: 'openai' },
  model: { type: 'string' }, 'base-url': { type: 'string' }, 'api-key-env': { type: 'string' },
  'api-mode': { type: 'string', default: 'chat-completions' }, 'max-calls': { type: 'string', default: '6' },
  output: { type: 'string' },
} })
const limit = Number(values['max-calls'])
if (!Number.isSafeInteger(limit) || limit < 4 || limit > 20) throw Error('max-calls must be an integer from 4 to 20')
if (values.live && (!values.model || !values['api-key-env'] || !process.env[values['api-key-env']])) throw Error('Live mode requires model and an API key environment variable name')
if (values.live && !['openai', 'deepseek', 'anthropic', 'openai-compatible'].includes(values.provider)) throw Error('Unsupported benchmark provider')
if (values.live && values.provider === 'deepseek' && !values['base-url']) throw Error('DeepSeek live mode requires its configured base-url')
const adapter = values.live ? createProviderAdapter({ provider: values.provider, defaultModel: values.model,
  ...(values['base-url'] ? { baseURL: values['base-url'] } : {}), apiMode: values['api-mode'], apiKey: process.env[values['api-key-env']], maxOutputTokens: 32,
}) : undefined
const report = { schemaVersion: 1, mode: values.live ? 'live' : 'offline', maxCalls: limit, actualCalls: 0,
  note: 'Local prefix bytes are diagnostic only. Provider cache counts remain unknown unless reported. This synthetic task does not measure coding success.', protocols: [],
}
try {
  for (const protocol of [1, 2]) {
    const state = createRuntimeState(), { agent, root } = createAgent(state, 'Return OK', { programId: 'cache-eval', programVersion: '1', step: 'work', locals: {} })
    let lane = root
    const diagnostics = new RequestDiagnostics(), rounds = Math.floor(limit / 2), requests = []
    for (let round = 0; round < rounds; round++) {
      const request = new ContextBuilder(state).build({ agent, lane, contextProtocolVersion: protocol, contextStream: 'work', explicitContext: true, includeLaneHistory: true, nativeToolHistory: true,
        system: 'You are a careful assistant. Follow the user requirements. Return OK only.', policy: {}, toolSetId: 'cache-eval', tools: { tools: [] }, instruction: 'Return OK only.',
        conversation: [{ role: 'user', content: 'Reference document: this is stable shared task material for the cache comparison. '.repeat(160) }, { role: 'user', content: JSON.stringify({ activeStage: 'read-only-evaluation', usedTurns: round }) }],
      })
      const canonical = lowerProjectionToCanonical({ request, model: values.model ?? 'offline' }).canonical
      const local = diagnostics.measure(`v${protocol}`, { model: canonical.model, messages: canonical.messages, tools: canonical.tools })
      let output = { text: 'OK', finishReason: 'stop', toolCalls: [] }, actual
      if (adapter) {
        if (report.actualCalls >= limit) throw Error('Benchmark call limit reached')
        report.actualCalls++
        const start = Date.now()
        const result = await adapter.executeAttempt({ request, connectionKey: `cache-eval:v${protocol}`, model: values.model, maxOutputTokens: 32, signal: AbortSignal.timeout(60000) })
        output = result
        actual = { inputTokens: result.usage?.inputTokens ?? null, cachedInputTokens: result.usage?.cachedInputTokens ?? null, uncachedInputTokens: result.usage?.uncachedInputTokens ?? null, cacheWriteInputTokens: result.usage?.cacheWriteInputTokens ?? null, latencyMs: Date.now() - start, validOutput: result.text.trim() === 'OK' && result.finishReason === 'stop' && !result.toolCalls.length }
      }
      requests.push({ round, ...local, ...(actual ? { actual } : {}) })
      const id = `effect-${round}`, ref = `result-${round}`
      state.effects.set(id, { id, kind: 'llm', input: { request } })
      state.results.set(ref, { id: ref, value: output, privacy: 'public', derivedFrom: [] })
      lane.visibleResultRefs.add(ref)
      lane = appendHistory(lane, { effectId: id, instruction: 'Return OK only.', resultRefs: [], output, privacy: 'public' })
      state.lanes.set(lane.id, lane)
    }
    report.protocols.push({ version: protocol, requests, estimatedTotalInputTokens: requests.reduce((n, r) => n + r.estimatedInputTokens, 0), reusablePrefixBytes: requests.reduce((n, r) => n + r.reusablePrefixBytes, 0) })
  }
} catch (error) {
  report.error = error?.code ?? error?.name ?? 'BENCHMARK_FAILED'
  process.exitCode = 1
} finally {
  adapter?.dispose?.()
  const output = JSON.stringify(report, null, 2) + '\n'
  if (values.output) await writeFile(values.output, output, { mode: 0o600 })
  process.stdout.write(output)
}
