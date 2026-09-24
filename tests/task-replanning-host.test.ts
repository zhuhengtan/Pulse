import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'

describe('task-level bounded replanning in LocalHost', () => {
  it('publishes only the final answer, never streamed candidates or verifier JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-stream-separation-'))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      const index = calls++
      const outputs = ['REJECTED_CANDIDATE', JSON.stringify({ status: 'replan', criteria: [{ criterionId: 'criterion-1', status: 'not_met', evidenceRefs: ['result-1'], rationale: 'INTERNAL_REVIEW' }] }), 'FINAL_ONLY', JSON.stringify({ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-3'], rationale: 'INTERNAL_REVIEW' }] })]
      const stream = `data: ${JSON.stringify({ choices: [{ delta: { content: outputs[index] }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), provider: { provider: 'openai', defaultModel: 'test' }, taskController: false })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Give one concise answer.' })
      const texts: string[] = []
      const deltas: string[] = []
      for await (const event of run.events) {
        if (event.type === 'text') texts.push(String(event.data))
        if (event.type === 'delta' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
          const delta = event.data as Record<string, unknown>
          if (typeof delta.text === 'string') deltas.push(delta.text)
        }
      }
      expect(calls).toBe(4)
      expect(texts).toEqual(['FINAL_ONLY'])
      expect(deltas.join('')).toBe('REJECTED_CANDIDATEFINAL_ONLY')
      expect(deltas.join('')).not.toContain('INTERNAL_REVIEW')
      expect(await run.taskOutcome()).toMatchObject({ status: 'accepted', replanCount: 1 })
      const messages = await host.getConversationMessages(conversation.id)
      expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['FINAL_ONLY'])
    } finally { vi.unstubAllGlobals(); await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('persists and emits an assistant reply when execution fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-failure-reply-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), maxTurns: 1, mockToolCalls: [{ name: 'fs.list', input: {} }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '帮我检查项目' })
      const texts: string[] = []
      for await (const event of run.events) if (event.type === 'text') texts.push(String(event.data))
      expect(await run.outcome()).toMatchObject({ status: 'failed' })
      expect(texts).toHaveLength(1)
      expect(texts[0]).toContain('本次任务未完成')
      expect((await host.getConversationMessages(conversation.id)).at(-1)?.text).toBe(texts[0])
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('does not execute tools for an explicit status question', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-status-turn-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'must-not-exist.txt', content: 'unexpected' } }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '你把所有报错输出给我我看看怎么回事' })
      await run.outcome()
      await expect(readFile(join(directory, 'must-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      const snapshot = await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')
      const effects = JSON.parse(snapshot).state.state.effects.map((entry: [string, { kind: string }]) => entry[1])
      expect(effects.some((effect: { kind: string }) => effect.kind === 'tool')).toBe(false)
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('accepts the passed alias only with valid evidence for every criterion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-passed-alias-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: '你好', mockTaskAssessments: [{ status: 'passed', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'Response present.' }] }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '说话' })
      await run.outcome()
      expect(await run.taskOutcome()).toMatchObject({ status: 'accepted' })
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('replans a criterion failure once, then records separate accepted completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-task-replan-'))
    const host = createLocalHost({
      cwd: directory,
      dataDir: join(directory, 'data'),
      mockResponse: 'First candidate is incomplete.',
      mockReplanResponses: ['Corrected candidate satisfies the requested result.'],
      mockTaskAssessments: [
        { status: 'replan', criteria: [{ criterionId: 'criterion-1', status: 'not_met', evidenceRefs: ['result-1'], rationale: 'The first candidate needs the missing requirement.' }] },
        { status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-3'], rationale: 'The corrected candidate contains the requirement.' }] },
      ],
    })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Provide the requested result.' })
      const events = []
      for await (const event of run.events) events.push(event)
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
      const taskOutcome = await run.taskOutcome()
      if (taskOutcome?.status !== 'accepted') throw new Error(JSON.stringify(taskOutcome))
      expect(taskOutcome).toMatchObject({ status: 'accepted', verifier: 'llm', replanCount: 1 })
      expect(events.some((event) => event.type === 'complete' && (event.data as Record<string, unknown>).taskOutcome !== undefined)).toBe(true)
      const final = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'task-outcome.json'), 'utf8'))
      expect(final).toMatchObject({ status: 'accepted', replanCount: 1, candidateResultRef: 'result-3' })
    } finally {
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds large verifier feedback and replans when the verifier cites an unknown ResultRef', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-task-replan-bounds-'))
    const host = createLocalHost({
      cwd: directory,
      dataDir: join(directory, 'data'),
      mockResponse: 'First candidate is incomplete.',
      mockReplanResponses: ['Corrected candidate satisfies the requested result.'],
      mockTaskAssessments: [
        { status: 'replan', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['missing-ref'], rationale: '修'.repeat(1_800) }] },
        { status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-3'], rationale: 'Corrected.' }] },
      ],
    })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Provide the requested result.' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
      await expect(run.taskOutcome()).resolves.toMatchObject({ status: 'accepted', verifier: 'llm', replanCount: 1 })
    } finally {
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

})
