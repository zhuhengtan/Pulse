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
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), provider: { provider: 'openai', defaultModel: 'test' } })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Give one concise answer.' })
      const texts: string[] = []
      for await (const event of run.events) if (event.type === 'text') texts.push(String(event.data))
      expect(calls).toBe(4)
      expect(texts).toEqual(['FINAL_ONLY'])
      expect(await run.taskOutcome()).toMatchObject({ status: 'accepted', replanCount: 1 })
      const messages = await host.getConversationMessages(conversation.id)
      expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['FINAL_ONLY'])
    } finally { vi.unstubAllGlobals(); await host.close(); await rm(directory, { recursive: true, force: true }) }
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
