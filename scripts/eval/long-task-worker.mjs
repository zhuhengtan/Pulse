import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createLocalHost } from '../../packages/server/dist/index.js'
import { createBuiltinSkillCapabilityPack } from '../../packages/server/dist/builtin-skills.js'
import { evaluationSupportManifest } from './long-task-support.mjs'
import { evaluationRunnerAcceptance, evaluationResumeAcceptance } from './long-task-acceptance.mjs'
import { append, load, save, hash, manifest, changes, interviewAnswer, reserveAttempt, transportErrorCode, remainingEvaluationMs, evaluationSystemPrompt } from './long-task-lib.mjs'

const output = resolve(process.argv[2]), taskId = process.argv[3], restoring = process.argv.includes('--restore')
const frozen = load(join(output, 'frozen.json')), task = frozen.dataset.tasks.find(item => item.id === taskId)
if (frozen.acceptanceHash && hash(await readFile(new URL('./long-task-acceptance.mjs', import.meta.url))) !== frozen.acceptanceHash) throw new Error('EVAL_ACCEPTANCE_NOT_FROZEN')
if (frozen.resumeProbeHash && hash(await readFile(new URL('./long-task-resume-probe.mjs', import.meta.url))) !== frozen.resumeProbeHash) throw new Error('EVAL_RESUME_PROBE_NOT_FROZEN')
if (!task || hash(await readFile(new URL('./long-task-worker.mjs', import.meta.url))) !== frozen.workerHash) throw new Error('EVAL_WORKER_NOT_FROZEN')
const evaluatorCalls = frozen.dataset.limits.perSampleCalls === undefined ? load(join(output, 'budget.json')).sampleLimit : frozen.dataset.limits.perSampleCalls
const sampleLimit = evaluatorCalls ?? 256 // Existing product ceiling, not an evaluator budget.
const caseDir = join(output, taskId), workspace = join(caseDir, 'workspace')
if (frozen.supportHash && hash(await readFile(new URL('./long-task-support.mjs', import.meta.url))) !== frozen.supportHash) throw new Error('EVAL_SUPPORT_NOT_FROZEN')
if (frozen.support?.[taskId]) {
  if (JSON.stringify(await evaluationSupportManifest(workspace)) !== JSON.stringify(frozen.support[taskId])) throw new Error('EVAL_SUPPORT_DRIFT')
  const receipt = load(join(caseDir, 'environment-check/result.json'))
  if (receipt.passed !== true || receipt.runnerHash !== hash(await readFile(join(workspace, 'scripts/eval/run.mjs')))) throw new Error('EVAL_ENVIRONMENT_PRECHECK_STALE')
}
const remainingMs = () => remainingEvaluationMs(load(join(caseDir, 'started.json')).at, frozen.dataset.limits.perSampleMs)
const assertBeforeDeadline = () => { if (remainingMs() === 0) throw Object.assign(new Error('Original evaluation deadline expired; no new request or reply allowed.'), { code: 'EVALUATION_DEADLINE' }) }
const config = load(process.env.PULSE_CONFIG ?? '/Users/zhuhengtan/.pulse/config.json')
const [providerCode, modelId] = (config.activeModel ?? '').split('/')
const profile = config.providers?.[providerCode], row = profile?.models?.[modelId]
if (providerCode !== 'deepseek' || profile?.provider !== 'deepseek' || !row?.modelCode || !process.env[profile.apiKeyEnv ?? 'DEEPSEEK_API_KEY']) throw new Error('EVAL_CONFIG_OR_CREDENTIAL_MISSING')
const model = row.modelCode, baseURL = profile.baseURL ?? 'https://api.deepseek.com'
const nativeFetch = globalThis.fetch, pendingCaptures = new Set()
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.origin !== new URL(baseURL).origin || !target.pathname.endsWith('/chat/completions')) throw new Error('EVAL_UNEXPECTED_TRANSPORT')
  const body = JSON.parse(String(init.body))
  if (body.model !== model || body.reasoning_effort !== task.effort) throw new Error('EVAL_MODEL_OR_EFFORT_DRIFT')
  assertBeforeDeadline()
  const count = reserveAttempt(join(output, 'budget.json'), taskId), started = Date.now()
  append(join(caseDir, 'attempts.jsonl'), { type: 'attempt', at: new Date().toISOString(), ...count, model, effort: body.reasoning_effort, stream: !!body.stream, messageChars: JSON.stringify(body.messages).length, tools: body.tools?.length ?? 0, role: JSON.stringify(body.messages).includes('Pulse safety reviewer') ? 'approval' : JSON.stringify(body.messages).includes('Summarize the older conversation') ? 'compaction' : 'primary-or-controller' })
  try {
    const response = await nativeFetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(180000)]) })
    append(join(caseDir, 'attempts.jsonl'), { type: 'headers', sample: count.sample, status: response.status, at: new Date().toISOString(), durationMs: Date.now() - started })
    const capture = response.clone().text().then(text => {
      let usage = null, finish = null, toolCalls = [], content = ''
      const chunks = body.stream ? text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).flatMap(line => { try { return [JSON.parse(line.slice(6))] } catch { return [] } }) : (() => { try { return [JSON.parse(text)] } catch { return [] } })()
      for (const chunk of chunks) {
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices?.[0]; if (choice?.finish_reason) finish = choice.finish_reason
        const message = choice?.message ?? choice?.delta
        if (message?.content) content += message.content
        if (message?.tool_calls) toolCalls.push(...message.tool_calls)
      }
      // Keep tool names/arguments and visible output, never credentials or reasoning text.
      append(join(caseDir, 'attempts.jsonl'), { type: 'response', sample: count.sample, status: response.status, durationMs: Date.now() - started, usage, finish, toolCalls, content })
    }).catch(error => append(join(caseDir, 'attempts.jsonl'), { type: 'capture-error', sample: count.sample, code: transportErrorCode(error) }))
    pendingCaptures.add(capture); capture.finally(() => pendingCaptures.delete(capture))
    return response
  } catch (error) {
    append(join(caseDir, 'attempts.jsonl'), { type: 'transport-error', sample: count.sample, code: transportErrorCode(error) })
    throw error
  }
}
const provider = { provider: 'deepseek', defaultModel: model, apiKey: process.env[profile.apiKeyEnv ?? 'DEEPSEEK_API_KEY'], baseURL, maxContextTokens: row.maxContextTokens ?? 256000, maxOutputTokens: Math.min(row.maxOutputTokens ?? 16384, 16384), reasoningEffort: task.effort }
const reference = `${providerCode}/${modelId}`
const acceptance = taskId === 'LT01' ? evaluationRunnerAcceptance(workspace, caseDir, task.prompt) : taskId === 'LT02' ? evaluationResumeAcceptance(workspace, caseDir, task.prompt) : undefined
const host = createLocalHost({ cwd: workspace, dataDir: join(caseDir, 'data'), logDir: join(caseDir, 'logs'), provider, providerProfiles: { [providerCode]: provider }, providerModels: { [reference]: { provider: providerCode, model, maxContextTokens: provider.maxContextTokens, maxOutputTokens: provider.maxOutputTokens, reasoningEffort: task.effort } }, activeProviderCode: providerCode, activeModel: reference, taskController: true, approvalMode: 'auto', allowNetwork: false, maxModelCalls: sampleLimit, maxTurns: Math.max(32, sampleLimit), ...(frozen.dataset.limits.perSampleMs === null ? {} : { maxRuntimeMs: frozen.dataset.limits.perSampleMs }), jarvis: { enabled: false }, acceptanceChecks: acceptance?.checks, capabilityPacks: [createBuiltinSkillCapabilityPack(), ...(acceptance ? [acceptance.pack] : [])], enabledCapabilityPacks: ['builtin-skills', ...(acceptance ? ['evaluation-acceptance'] : [])], systemPrompt: evaluationSystemPrompt({ productCalls: sampleLimit, evaluatorCalls }) })
let run, timer
try {
  assertBeforeDeadline()
  if (restoring) {
    const saved = load(join(caseDir, 'session.json'))
    run = await host.resumeRun(saved.conversationId)
    const pending = await run.pendingInteractions(), same = run.id === saved.runId && JSON.stringify(pending) === JSON.stringify(saved.pending)
    save(join(caseDir, 'restore.json'), { sameRun: run.id === saved.runId, samePending: same, callsBefore: saved.calls, callsAfterRestore: load(join(output, 'budget.json')).samples[taskId] })
    if (!same) throw new Error('EVAL_PENDING_RESTORE_CHANGED')
    const item = pending[0].items[0]
    const answer = interviewAnswer(item.input)
    if (!answer.final) throw new Error('EVAL_RESTORED_FINAL_CHOICE_INVALID')
    assertBeforeDeadline()
    append(join(caseDir, 'interactions.jsonl'), { kind: 'final-answer-after-cold-restore', input: item.input, answer: '暂不执行', nativeValue: answer.value })
    await run.reply(item.effectId, answer.value)
  } else {
    const conversation = await host.createConversation()
    run = await host.sendMessage(conversation.id, { text: task.prompt })
    save(join(caseDir, 'session.json'), { conversationId: conversation.id, runId: run.id })
  }
  if (Number.isFinite(remainingMs())) timer = setTimeout(() => run.cancel('EVALUATION_DEADLINE'), remainingMs())
  for await (const event of run.events) {
    append(join(caseDir, 'events.jsonl'), event)
    if (event.type === 'tool' || event.type === 'waiting' || event.type === 'error' || event.type === 'complete') console.log(JSON.stringify({ taskId, type: event.type, seq: event.seq, data: event.type === 'tool' ? event.data : undefined }))
    if (event.type !== 'waiting') continue
    const groups = await run.pendingInteractions()
    for (const group of groups) for (const item of group.items) {
      if (group.kind === 'approval') {
        append(join(caseDir, 'interactions.jsonl'), { kind: 'approval-refused-by-evaluation-policy', input: item.input })
        await run.reply(item.effectId, { approved: false, reason: 'Evaluation has no blanket human approval; automatic policy could not authorize operation.' })
      } else if (taskId === 'LT06') {
        const answer = interviewAnswer(item.input, (await readFile(join(workspace, 'fixtures/evaluation-request.md'), 'utf8')))
        append(join(caseDir, 'interactions.jsonl'), { kind: 'interview', input: item.input, answer })
        if (answer.final && !restoring) {
          await Promise.allSettled([...pendingCaptures])
          save(join(caseDir, 'session.json'), { conversationId: run.conversationId, runId: run.id, pending: groups, calls: load(join(output, 'budget.json')).samples[taskId] })
          // Deliberately terminate this disposable worker without graceful cancellation.
          process.exit(75)
        }
        if (answer.unanswered) {
          save(join(caseDir, 'pending-question.json'), { effectId: item.effectId, input: item.input, remainingMs: remainingMs(), reason: 'Awaiting owner; no answer selected and original deadline remains in force.' })
          console.log(JSON.stringify({ taskId, waitingForOwner: true, path: join(caseDir, 'pending-question.json') }))
          let reply
          while (!reply) {
            if (remainingMs() === 0) { await run.cancel('EVALUATION_DEADLINE'); break }
            try { reply = load(join(caseDir, 'owner-answer.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
            if (reply && reply.effectId !== item.effectId) reply = undefined
            if (!reply) await new Promise(resolve => setTimeout(resolve, 1000))
          }
          if (!reply) continue
          assertBeforeDeadline()
          append(join(caseDir, 'interactions.jsonl'), { kind: 'owner-answer', effectId: item.effectId, value: reply.value, source: reply.source ?? 'owner_answer_file' })
          await run.reply(item.effectId, reply.value)
          continue
        }
        await run.reply(item.effectId, answer.value)
      } else {
        append(join(caseDir, 'interactions.jsonl'), { kind: 'unplanned-question', input: item.input })
        await run.cancel('EVALUATION_UNPLANNED_QUESTION')
      }
    }
  }
  const outcome = await run.outcome(), usage = await run.usage(), taskOutcome = await run.taskOutcome()
  await Promise.allSettled([...pendingCaptures])
  save(join(caseDir, 'result.json'), { taskId, effort: task.effort, completedAt: new Date().toISOString(), outcome, usage, taskOutcome: taskOutcome ?? null, outerAttempts: load(join(output, 'budget.json')).samples[taskId], changed: changes(load(join(caseDir, 'before.json')), await manifest(workspace)) })
} catch (error) {
  save(join(caseDir, 'result.json'), { taskId, effort: task.effort, error: { code: error.code ?? error.name, message: String(error.message).replaceAll(provider.apiKey, '[redacted]').slice(0, 400) }, outerAttempts: load(join(output, 'budget.json')).samples[taskId], changed: changes(load(join(caseDir, 'before.json')), await manifest(workspace)) })
  process.exitCode = 1
} finally { clearTimeout(timer); await host.close() }
