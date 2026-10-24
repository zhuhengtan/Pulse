import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('validates interrupted artifacts against the execution workspace after host restart (external change=%s)', async changed => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-resume-execution-'))
  const cwd = join(root, 'project'), execution = join(root, 'execution'), dataDir = join(root, 'data')
  await mkdir(cwd); await mkdir(execution)
  execFileSync('git', ['init', '-q', cwd]); execFileSync('git', ['init', '-q', execution])
  const objective = 'Create generated.txt containing retained output, verify its content, and preserve caller inputs.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let resumed = false, work = 0, writes = 0, resumedPlan = ''
  const reply = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, args: object) => reply({ content: '', tool_calls: [{ id: `work-${resumed}-${work}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (text.includes('Create an executable plan')) {
      if (resumed) resumedPlan = text
      return reply(JSON.stringify({ tasks: [{ id: 'deliver', kind: resumed ? 'verify' : 'edit', goal: resumed ? 'Read and verify existing generated.txt without writes' : 'Create generated.txt', check: 'Read actual artifact content', criterionIds: ids, dependsOn: [] }] }))
    }
    if (text.includes('Verify ONLY the active taskController stage')) return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Actual filesystem receipt.' }))
    if (text.includes('Independently verify every ORIGINAL')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Actual filesystem content was checked.' })) }))
    work++
    if (resumed) return work === 1 ? tool('fs_read', { path: 'generated.txt' }) : reply('Read existing artifact; no mutation replayed.')
    if (work === 1) { writes++; return tool('fs_write', { path: 'generated.txt', content: 'retained output' }) }
    return tool('ask_input', { prompt: 'Pause for caller confirmation.' })
  }))
  const options = { cwd, dataDir, provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto' as const, taskController: true, jarvis: { enabled: false }, maxModelCalls: 24 }
  let host = createLocalHost(options)
  try {
    const c = await host.createConversation()
    await host.setConversationExecutionWorkspace(c.id, execution, cwd)
    const first = await host.sendMessage(c.id, { text: objective })
    for await (const event of first.events) if (event.type === 'waiting') { await first.cancel('TEST_INTERRUPTED_AFTER_WRITE'); break }
    await first.outcome()
    const runDir = (id: string) => join(dataDir, 'conversations', c.id, 'runs', id)
    const checkpoint = JSON.parse(await readFile(join(runDir(first.id), 'checkpoint.json'), 'utf8'))
    expect(checkpoint.facts).toEqual(expect.arrayContaining([expect.objectContaining({ result: expect.objectContaining({ path: 'generated.txt', content: 'retained output' }) })]))
    expect(await readFile(join(cwd, 'generated.txt'), 'utf8').catch(() => null)).toBeNull()
    if (changed) await writeFile(join(execution, 'generated.txt'), 'caller changed output')
    await host.close(); host = createLocalHost(options); resumed = true; work = 0
    const next = await host.sendMessage(c.id, { text: '刚才任务中断了。检查已有产物，继续剩余工作；不要重新写入或运行生成器。' })
    const nextOutcome = await next.outcome()
    const reuse = await readFile(join(runDir(next.id), 'reuse-checkpoint.json'), 'utf8').then(JSON.parse).catch(() => null)
    const operations = JSON.parse(await readFile(join(runDir(next.id), 'operations.json'), 'utf8')).operations
    if (changed) {
      expect(reuse).toBeNull()
      expect(resumedPlan).not.toContain('"content":"retained output"')
    } else {
      expect(reuse.reusableIds).toEqual([])
      expect(reuse.facts[0].result.content).toBe('retained output')
      expect(operations[0].tool).toBe('task.recall')
      expect(resumedPlan, JSON.stringify({ nextOutcome, operations, controller: await readFile(join(runDir(next.id), 'task-controller.json'), 'utf8') })).toContain('do not recreate or rerun their generators')
      expect(resumedPlan).toContain('retained output')
    }
    expect(operations.filter((o: any) => o.tool === 'fs.write')).toHaveLength(0)
    expect(writes).toBe(1)
    expect(await readFile(join(execution, 'generated.txt'), 'utf8')).toBe(changed ? 'caller changed output' : 'retained output')
    const budget = JSON.parse(await readFile(join(runDir(next.id), 'model-budget.json'), 'utf8'))
    expect(budget.inheritedFrom).toContain(first.id)
    expect(budget.limit).toBe(24 - (await first.usage()).modelCalls)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
