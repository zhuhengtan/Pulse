import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
it.each([true, false])('allows one citation-only correction and rejects repeated invented evidence (repair=%s)', async repair => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-citation-repair-'))
  const objective = 'Create greeting.txt containing hello.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0, reviews = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).map((r: any) => r.id)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'create', kind: 'edit', goal: objective, check: 'File saved', dependsOn: [], criterionIds: ids }] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      reviews++
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: reviews === 1 || !repair ? ['result-999999'] : refs, note: 'Saved file' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Actual saved file' })) }))
    if (++work === 1) return chat({ content: '', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello' }) } }] })
    return chat('Saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: repair ? 'accepted' : 'incomplete' })
    expect(reviews).toBe(2)
    expect(work).toBe(2)
    expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe('hello')
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
