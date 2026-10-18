import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it('corrects the saved implementation and reruns frozen acceptance using real Host tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-final-host-'))
  const original = 'export function validate(value) { return true }\n'
  let plans = 0, work = 0, checks = 0, approvals = 0
  const verdicts: boolean[] = []
  const response = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)), text = currentRequestText(messages)
    const refs = suppliedRequestResults(messages).filter(result => !result.value?.checks).map(result => result.id)
    if (text.includes('Create an executable plan')) {
      work = 0; plans++
      return response(JSON.stringify({ tasks: [{ id: `implement-${plans}`, kind: 'edit', goal: plans === 1 ? '创建 validation.mjs' : '修复 validation.mjs 的输入校验', check: '实现已保存', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    }
    if (text.includes('Verify ONLY the active')) return response(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: '阶段保存结果已核对' }))
    if (text.includes('Independently verify every ORIGINAL')) return response(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: '模型乐观判断；独立断言仍必须通过' }] }))
    if (work++ === 0) {
      const name = plans === 1 ? 'fs_write' : 'fs_apply_patch'
      const args = plans === 1 ? { path: 'validation.mjs', content: original } : { path: 'validation.mjs', find: 'return true', replace: 'return typeof value === "string"', expectedHash: createHash('sha256').update(original).digest('hex') }
      return response({ content: '', tool_calls: [{ id: `edit-${plans}`, function: { name, arguments: JSON.stringify(args) } }] })
    }
    return response('本阶段代码已保存')
  }))
  const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', baseURL: 'http://127.0.0.1:12345/v1' }, taskController: true, approvalMode: 'ask', maxModelCalls: 32,
    acceptanceChecks: [{ id: 'validation', description: '原始输入契约', criterionIds: ['criterion-1'], toolName: 'trusted-validation.check', input: {}, expectedChecks: ['reject-invalid'], covers: [] }],
    enabledCapabilityPacks: ['trusted-validation'], capabilityPacks: [{ manifest: { id: 'trusted-validation', version: '1', kind: 'integration', title: 'Validation', description: 'Caller-owned acceptance' }, activate: async () => ({ tools: [defineTool({ name: 'trusted-validation.check', description: 'Check actual saved module', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: async () => {
      const { validate } = await import(`${pathToFileURL(join(directory, 'validation.mjs')).href}?check=${checks++}`)
      const passed = validate('text') === true && validate(null) === false && validate(123) === false
      verdicts.push(passed)
      return { checks: [{ id: 'reject-invalid', passed, detail: 'Saved module input behavior' }] }
    } })] }) }],
  })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '实现 validation.mjs，使其拒绝非字符串输入' })
    for await (const event of run.events) if (event.type === 'waiting') {
      const pending = await run.pendingInteractions()
      expect(pending[0]?.kind).toBe('approval')
      approvals++; await run.reply(pending[0]!.items[0]!.effectId, { approved: true })
    }
    const outcome = await run.outcome(), task = await run.taskOutcome()
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'succeeded' })
    expect(task, JSON.stringify(task)).toMatchObject({ status: 'accepted', replanCount: 1 })
    expect(plans).toBe(2)
    expect(approvals).toBe(2)
    expect(verdicts).toEqual([false, true])
    expect(await readFile(join(directory, 'validation.mjs'), 'utf8')).toBe(original.replace('return true', 'return typeof value === "string"'))
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 20_000)
