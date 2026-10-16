import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { runShell } from '@hunterzhu/pulse-adapters'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { runPersistence } from '../packages/server/src/run-persistence.js'
import { PulseRuntime, withRuntimePersistenceIntegrity } from '@hunterzhu/pulse-runtime'

vi.mock('@hunterzhu/pulse-adapters', async original => ({ ...await original<typeof import('@hunterzhu/pulse-adapters')>(), runShell: vi.fn(async () => ({ code: 0, stdout: 'fixture check passed', stderr: '', truncated: false, timedOut: false, aborted: false })) }))
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(runShell).mockClear() })

it.each(['old-check', 'rerun', 'unrelated', 'weakened'])('Host binds successful checks to the current artifact: %s', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-host-contract-'))
  const objective = 'Verify feature.mjs with the original feature.test.mjs.'
  await writeFile(join(root, 'feature.mjs'), 'export const feature = 1\n')
  await writeFile(join(root, 'feature.test.mjs'), "import './feature.mjs'\n")
  const criteria = acceptanceCriteriaFromObjective(objective)
  let calls = 0, work = 0, verifications = 0, plans = 0
  const chat = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: typeof content === 'string' ? { content } : content, finish_reason: typeof content === 'string' ? 'stop' : 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, args: unknown) => chat({ content: '', tool_calls: [{ id: `tool-${work}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    calls++
    const request = JSON.parse(String(init.body)), blob = currentRequestText(request.messages)
    if (blob.includes('You are the Pulse safety reviewer')) return chat('APPROVE')
    const refs = request.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content)).map((r: any) => r.id)
    if (blob.includes('Create an executable plan')) { plans++; return chat(JSON.stringify({ tasks: [{ id: 'check', goal: 'Verify feature.mjs', check: 'The original test passes against current code', criterionIds: criteria.map(c => c.id), dependsOn: [] }] })) }
    if (blob.includes('Verify ONLY the active')) { verifications++; return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Checked' })) }
    if (blob.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: criteria.map(c => ({ criterionId: c.id, status: 'passed', evidenceRefs: refs, rationale: 'Current successful check' })) }))
    work++
    if (work === 1) return tool('shell_exec', { command: 'node', args: ['--test', 'feature.test.mjs'] })
    if (work === 2) {
      if (scenario === 'unrelated') return tool('fs_write', { path: 'unrelated.md', content: 'notes' })
      if (scenario === 'weakened') return tool('fs_apply_patch', { path: 'feature.test.mjs', find: "import './feature.mjs'", replace: 'process.exit(0)' })
      return tool('fs_apply_patch', { path: 'feature.mjs', find: 'feature = 1', replace: 'feature = 2' })
    }
    if (work === 3 && (scenario === 'rerun' || scenario === 'weakened')) return tool('shell_exec', { command: 'node', args: ['--test', 'feature.test.mjs'] })
    return chat('Check completed.')
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', jarvis: { enabled: false }, maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), JSON.stringify({ work, calls, feature: await readFile(join(root, 'feature.mjs'), 'utf8'), check: await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8') })).toMatchObject({ status: scenario === 'rerun' || scenario === 'unrelated' ? 'accepted' : 'incomplete' })
    expect(plans).toBe(1); expect(calls).toBeLessThanOrEqual(10)
    expect(verifications).toBe(scenario === 'old-check' || scenario === 'weakened' ? 0 : 1)
    expect(vi.mocked(runShell)).toHaveBeenCalledTimes(scenario === 'rerun' || scenario === 'weakened' ? 2 : 1)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['json', 'external-files', 'sqlite'] as const)('restores a native pending question without answering or replaying it (%s)', async persistenceBackend => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-backend-'))
  const options = { cwd: root, dataDir: join(root, 'data'), taskController: false, persistenceBackend, jarvis: { enabled: false }, mockToolCalls: [{ name: 'ask.choice', input: { prompt: '是否继续？', decisionId: 'continue', options: [{ label: '停止', value: 'hold' }, { label: '继续', value: 'continue' }] } }] }
  const first = createLocalHost(options)
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation(), run = await first.sendMessage(conversation.id, { text: 'Ask before continuing.' })
    for await (const event of run.events) if (event.type === 'waiting') break
    const pending = await run.pendingInteractions(), directory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
    const ledger = await readFile(join(directory, 'model-budget.json'), 'utf8')
    ;(first as any).active.get(run.id).runtime.cancelAgent = () => {}
    await first.close()
    if (persistenceBackend === 'json') {
      const backend = await runPersistence(directory, 'json'), snapshot = (await backend.load())!
      delete snapshot.compatibility!.fingerprints
      await backend.save(withRuntimePersistenceIntegrity(snapshot))
    }
    second = createLocalHost({ ...options, maxModelCalls: 256 })
    const resumed = await second.resumeRun(conversation.id)
    expect(resumed.id).toBe(run.id); expect(await resumed.pendingInteractions()).toEqual(pending)
    expect(await readFile(join(directory, 'model-budget.json'), 'utf8')).toBe(ledger)
    if (persistenceBackend === 'json') expect((await readdir(directory)).some(name => name.endsWith('.committed'))).toBe(true)
    await resumed.reply(pending[0]!.items[0]!.effectId, { value: 'hold' }); await resumed.outcome()
  } finally { await first.close(); await second?.close(); await rm(root, { recursive: true, force: true }) }
})

it('binds explicit requirements documents and follow-up updates to traceable criteria', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-requirements-'))
  await writeFile(join(root, 'requirements.md'), '禁止新增依赖。\n- 支持邮箱注册\n- 支持手机号注册')
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: false, mockResponse: '待验收', jarvis: { enabled: false } })
  try {
    const conversation = await host.createConversation(), first = await host.sendMessage(conversation.id, { text: '实现注册', requirementPaths: ['requirements.md'] })
    await first.outcome()
    const firstRecord = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', first.id, 'task-record.json'), 'utf8'))
    expect(firstRecord.acceptanceCriteria).toHaveLength(4)
    expect(firstRecord.acceptanceCriteria[1].source.document).toBe('requirements.md')
    const next = await host.sendMessage(conversation.id, { text: '必须支持邮箱验证码', continueTask: true, requirementUpdate: true })
    await next.outcome()
    const secondRecord = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', next.id, 'task-record.json'), 'utf8'))
    expect(secondRecord.acceptanceCriteria).toHaveLength(5)
    expect(secondRecord.acceptanceCriteria.at(-1).description).toBe('必须支持邮箱验证码')
    expect(secondRecord.acceptanceCriteria[1].source.hash).toBe(firstRecord.acceptanceCriteria[1].source.hash)
    await writeFile(join(root, 'requirements.md'), '禁止新增依赖。\n- 支持国际区号')
    const updated = await host.sendMessage(conversation.id, { text: '继续', continueTask: true, requirementPaths: ['requirements.md'] })
    await updated.outcome()
    const updatedRecord = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', updated.id, 'task-record.json'), 'utf8'))
    expect(new Set(updatedRecord.acceptanceCriteria.map((c: any) => c.id)).size).toBe(updatedRecord.acceptanceCriteria.length)
    expect(updatedRecord.acceptanceCriteria.filter((c: any) => c.source?.document === 'requirements.md')).toHaveLength(2)
    expect(updatedRecord.supersededCriteria).toHaveLength(3)
    expect(updatedRecord.supersededCriteria[0].source.hash).toBe(firstRecord.acceptanceCriteria[1].source.hash)

  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
