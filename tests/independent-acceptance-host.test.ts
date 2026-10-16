import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { argumentCheckKinds } from '../packages/server/src/task-controller/acceptance.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('persists frozen Host checks despite an optimistic model (cold restore=%s)', async cold => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-independent-host-')), cwd = join(dir, 'workspace')
  await mkdir(cwd); await writeFile(join(cwd, 'candidate-tests.log'), '10/10 candidate self-tests passed')
  const objective = '检查 CLI --calls 参数。非法预算参数必须报错。'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0, checks = 0, calls = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    calls++
    const { messages } = JSON.parse(String(init?.body)), text = currentRequestText(messages), refs = suppliedRequestResults(messages).filter(r => !r.value?.checks).map(r => r.id)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'check', kind: 'verify', goal: '检查现有测试日志', check: '日志存在并读回', criterionIds: ids, dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Self-tests are green' }))
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Model incorrectly accepts self-tests' })) }))
    if (++work === 1) return chat({ content: '', tool_calls: [{ id: 'read-log', function: { name: 'fs_read', arguments: JSON.stringify({ path: 'candidate-tests.log' }) } }] })
    if (cold && work === 2) return chat({ content: '', tool_calls: [{ id: 'pause', function: { name: 'ask_input', arguments: JSON.stringify({ prompt: 'Resume local verification?', defaultValue: 'stop' }) } }] })
    return chat('All checks passed')
  }))
  const definition = { id: 'entry', description: 'Frozen positive and negative argument contract', toolName: 'trusted-acceptance.entry', input: {}, criterionIds: [ids.at(-1)!], expectedChecks: [...argumentCheckKinds], covers: [...argumentCheckKinds] }
  const options = { cwd, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, jarvis: { enabled: false }, maxModelCalls: 16, acceptanceChecks: [definition], capabilityPacks: [{ manifest: { id: 'trusted-acceptance', version: '1', kind: 'integration', title: 'Trusted', description: 'Independent local fixture' }, activate: async () => ({ tools: [defineTool({ name: 'trusted-acceptance.entry', description: 'Actual independent fixture', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { checks++; return { checks: argumentCheckKinds.map(id => ({ id, passed: ['valid-entry', 'invalid-value'].includes(id), detail: 'actual entry invocation observed' })) } } })] }) }], enabledCapabilityPacks: ['trusted-acceptance'] } as const
  let host = createLocalHost(options as any)
  try {
    const c = await host.createConversation(); let run = await host.sendMessage(c.id, { text: objective })
    if (cold) {
      for await (const event of run.events) if (event.type === 'waiting') break
      const originalId = run.id, previousCalls = calls
      const rt = (host as any).active.get(run.id).runtime; rt.cancelAgent = () => {}
      await host.close()
      host = createLocalHost({ ...options, acceptanceChecks: [] } as any)
      run = await host.resumeRun(c.id)
      expect(run.id).toBe(originalId); expect(calls).toBe(previousCalls); expect(checks).toBe(0)
      const pending = await run.pendingInteractions(); expect(pending[0]!.items[0]!.input).toMatchObject({ defaultValue: 'stop' })
      await run.reply(pending[0]!.items[0]!.effectId, { text: 'continue' })
    }
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    const task = await run.taskOutcome()
    expect(task).toMatchObject({ status: 'incomplete', criteria: expect.arrayContaining([expect.objectContaining({ criterionId: ids.at(-1), status: 'not_met', rationale: expect.stringContaining('conflicting-options') })]) })
    const base = join(dir, 'data/conversations', c.id, 'runs', run.id)
    const saved = JSON.parse(await readFile(join(base, 'task-record.json'), 'utf8'))
    expect(saved.acceptanceChecks).toEqual([definition])
    expect(JSON.parse(await readFile(join(base, 'input.json'), 'utf8')).controllerVersion).toBe('18')
    const state = JSON.parse(await readFile(join(base, 'task-controller.json'), 'utf8'))
    expect(state.acceptanceResults).toMatchObject([{ id: 'entry', status: 'failed', ref: expect.any(String) }])
    expect(checks).toBe(1); expect(work).toBe(cold ? 3 : 2); expect((await run.usage()).modelCalls).toBe(calls)
    expect(await readFile(join(cwd, 'candidate-tests.log'), 'utf8')).toBe('10/10 candidate self-tests passed')
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, 20_000)
