import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'

afterEach(() => vi.unstubAllGlobals())
it.each(['unchanged', 'before-stage', 'during-stage', 'during-final'])('verifies current file evidence outside pure steps (%s)', async change => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-fresh-evidence-'))
  const objective = 'Write greeting.txt and confirm it contains ready.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0, plans = 0, stageReviews = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), blob = currentRequestText(request.messages)
    const results = request.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content))
    if (blob.includes('Create an executable plan')) { plans++; return chat(JSON.stringify({ tasks: [{ id: 's', goal: 'Write greeting.txt', check: 'The file contains ready', dependsOn: [], criterionIds: ids }] })) }
    if (blob.includes('Verify ONLY the active taskController stage')) {
      stageReviews++
      if (change === 'during-stage') await writeFile(join(cwd, 'greeting.txt'), 'external change during stage verifier')
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: results.map((r: any) => r.id), note: 'Saved ready' }))
    }
    if (blob.includes('Independently verify every ORIGINAL')) {
      if (change === 'during-final') await writeFile(join(cwd, 'greeting.txt'), 'external change during final verifier')
      return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: results.map((r: any) => r.id), rationale: 'File exists' })) }))
    }
    work++
    if (work === 1) return chat({ content: '', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'ready' }) } }] })
    if (change === 'before-stage') await writeFile(join(cwd, 'greeting.txt'), 'external change before stage verifier')
    return chat('Greeting saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), logDir: join(cwd, 'logs'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome()).toMatchObject({ status: change === 'unchanged' ? 'accepted' : 'incomplete' })
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    if (change !== 'unchanged') expect(state.tasks[0].note).toContain('EVIDENCE_CHANGED')
    expect(plans).toBe(1); expect(work).toBe(2)
    expect(stageReviews).toBe(change === 'before-stage' ? 0 : 1)
    expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe(change === 'unchanged' ? 'ready' : `external change ${change === 'before-stage' ? 'before stage' : change === 'during-stage' ? 'during stage' : 'during final'} verifier`)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
