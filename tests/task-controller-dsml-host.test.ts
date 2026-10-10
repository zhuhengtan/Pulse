import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHost, type RunHandle } from '@hunterzhu/pulse-server'
import type { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'

const mark = '\uFF5C\uFF5CDSML\uFF5C\uFF5C'

function dsml(name: string, parameters: Record<string, string>): string {
  const body = Object.entries(parameters).map(([key, value]) => `<${mark} parameter name="${key}" string="true">${value}</${mark} parameter>`).join('\n')
  return [`<${mark} calls>`, `<${mark} invoke name="${name}">`, body, `</${mark} invoke>`, `</${mark} calls>`].join('\n')
}

function chat(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }), { headers: { 'content-type': 'application/json' } })
}

type Message = { role?: string; name?: string; content?: unknown }
function suppliedResults(messages: Message[]): Array<{ id: string; value: any }> {
  return messages.filter((message) => message.name === 'results').flatMap((message) => JSON.parse(String(message.content)))
}

describe('task controller with DeepSeek DSML tool calls', () => {
  it('plans dependent stages, executes DSML tool calls, and accepts both stages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-dsml-flow-'))
    const objective = '先列出工作区文件，再把结果写到 note.txt。'
    const criterionIds = acceptanceCriteriaFromObjective(objective).map((criterion) => criterion.id)
    const trace: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Message[] }
      const blob = body.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n')
      const active = blob.match(/"activeStage":\{"id":"(stage-[^"]+)"/)?.[1]
      const sawList = blob.includes('"entries"')
      const sawWrite = blob.includes('"bytes"')
      const kind = blob.includes('You are the Pulse safety reviewer') ? 'safety'
        : blob.includes('Create an executable plan') ? 'plan'
        : blob.includes('Verify ONLY the active taskController stage') ? 'verify-stage'
        : blob.includes('Independently verify every ORIGINAL') ? 'verify-task'
        : blob.includes('progress checkpoint') ? 'progress'
        : blob.includes('Execute only this independent taskController stage') ? `work:${active ?? 'unknown'}:${sawList ? 'listed' : 'fresh'}:${sawWrite ? 'written' : 'unwritten'}`
        : 'other'
      trace.push(kind)
      if (kind === 'safety') return chat('APPROVE')
      if (kind === 'plan') return chat(JSON.stringify({ tasks: [
        { id: 'stage-1', goal: '列出工作区文件', criterionIds, dependsOn: [], check: 'fs.list 返回工作区条目' },
        { id: 'stage-2', goal: '把结果写入 note.txt', criterionIds, dependsOn: ['stage-1'], check: 'note.txt 内容为 ready' },
      ] }))
      if (kind === 'verify-stage' || kind === 'verify-task') {
        // The results block is the supplied evidence catalog. Context snippets
        // need not duplicate the controller's internal evidenceRefs fields.
        const refs = suppliedResults(body.messages).map((result) => result.id)
        if (kind === 'verify-task') return chat(JSON.stringify({ criteria: criterionIds.map((criterionId) => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: '两个阶段都有工具证据。' })) }))
        return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: '阶段检查已由工具结果证明。' }))
      }
      if (kind === 'progress') return chat(JSON.stringify({ status: 'ready', evidenceRefs: suppliedResults(body.messages).map((result) => result.id), note: '证据已经足够。' }))
      if (kind.startsWith('work:stage-1') && !sawList) return chat(`先列出工作区。\n\n${dsml('fs.list', { path: '.' })}`)
      if (kind.startsWith('work:stage-1')) return chat('工作区文件已经列出。')
      if (kind.startsWith('work:stage-2') && !sawWrite) return chat(`写入结果文件。\n\n${dsml('fs_write', { path: 'note.txt', content: 'ready' })}`)
      if (kind.startsWith('work:stage-2')) return chat('note.txt 已写入 ready。')
      return chat('未识别的模型请求。')
    }))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', provider: { provider: 'deepseek', defaultModel: 'deepseek-flash' } })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })
      const texts: string[] = []
      for await (const event of run.events) if (event.type === 'text') texts.push(String(event.data))
      const controller = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8')) as { tasks: Array<{ id: string; status: string; note?: string; attempts: number }> }
      const note = await readFile(join(directory, 'note.txt'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code ?? 'missing')
      expect({ trace, texts, tasks: controller.tasks.map((task) => ({ id: task.id, status: task.status, attempts: task.attempts, note: task.note })), note, outcome: await run.taskOutcome() }).toMatchObject({
        tasks: [
          { id: 'stage-1', status: 'passed' },
          { id: 'stage-2', status: 'passed' },
        ],
        note: 'ready',
        outcome: { status: 'accepted' },
      })
      expect(texts.join('\n')).not.toContain('Required dependency is blocked')
      expect(trace).toContain('work:stage-1:fresh:unwritten')
      expect(trace).toContain('work:stage-2:listed:unwritten')
    } finally { vi.unstubAllGlobals(); await host.close(); await rm(directory, { recursive: true, force: true }) }
  }, 20_000)

  it.each([false, true])('continues context expansion using settled lane receipts (restore=%s)', async (restore) => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-surface-flow-'))
    const objective = Array.from({ length: 8 }, (_, i) => `- Explain section ${i + 1}`).join('\n')
    const criterionIds = acceptanceCriteriaFromObjective(objective).map((criterion) => criterion.id)
    const observations: Array<{ tool?: string; toolCallId?: string; status?: string; result?: unknown }> = []
    let firstStageTurns = 0
    let sawNewPoint = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Message[] }
      const blob = messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n')
      const results = suppliedResults(messages)
      if (blob.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: criterionIds.map((criterionId, i) => ({ id: `stage-${i + 1}`, goal: `Explain section ${i + 1}`, check: 'Response delivered', criterionIds: [criterionId], dependsOn: i ? [`stage-${i}`] : [] })) }))
      if (blob.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: results.map((result) => result.id), note: 'Response verified' }))
      if (blob.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: criterionIds.map((criterionId) => ({ criterionId, status: 'passed', evidenceRefs: results.map((result) => result.id), rationale: 'Response exists' })) }))
      const active = blob.match(/"activeStage":\{"id":"(stage-[^"]+)"/)?.[1]
      if (active === 'stage-1') {
        firstStageTurns++
        if (firstStageTurns === 1) return chat(dsml('task.surface', { point: 'stage-3' }))
        if (firstStageTurns === 2) {
          sawNewPoint = results.some((result) => result.value?.contextSurface?.hits.some((hit: { id: string }) => hit.id === 'stage-5'))
          return chat(dsml('ask.input', { prompt: 'Continue the explanation?' }))
        }
        if (firstStageTurns === 3) return chat(dsml('task.surface', { point: 'stage-5' }))
      }
      return chat('Section explained.')
    }))
    const options = { cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto' as const, provider: { provider: 'deepseek' as const, defaultModel: 'deepseek-flash' } }
    const first = createLocalHost(options)
    let second: ReturnType<typeof createLocalHost> | undefined
    try {
      const conversation = await first.createConversation()
      let run = await first.sendMessage(conversation.id, { text: objective })
      const consume = async (handle: RunHandle, stopAtQuestion: boolean) => {
        for await (const event of handle.events) {
          if (event.type === 'observation') observations.push(event.data as typeof observations[number])
          if (event.type !== 'waiting') continue
          if (stopAtQuestion) return true
          await handle.reply((event.data as { effectId: string }).effectId, { text: 'Continue' })
        }
        return false
      }
      if (restore) {
        expect(await consume(run, true)).toBe(true)
        const runtime = (first as unknown as { active: Map<string, { runtime: PulseRuntime }> }).active.get(run.id)!.runtime
        // Model an interrupted process without turning its durable wait into cancellation.
        runtime.cancelAgent = () => {}
        await first.close()
        second = createLocalHost(options)
        run = await second.resumeRun(conversation.id)
      }
      await consume(run, false)
      expect(sawNewPoint).toBe(true)
      const surfaces = observations.filter((observation) => observation.tool === 'task.surface')
      expect(surfaces.every((observation) => observation.status === 'succeeded')).toBe(true)
      // Restored streams replay durable events; tools themselves must not rerun.
      expect(new Set(surfaces.map((observation) => observation.toolCallId)).size).toBe(2)
      expect(await run.taskOutcome()).toMatchObject({ status: 'accepted' })
      const audit = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'operations.json'), 'utf8')) as { operations: Array<{ tool: string }> }
      expect(audit.operations.filter((operation) => operation.tool === 'task.surface')).toHaveLength(2)
    } finally { vi.unstubAllGlobals(); await second?.close(); await first.close(); await rm(directory, { recursive: true, force: true }) }
  }, 20_000)
})
