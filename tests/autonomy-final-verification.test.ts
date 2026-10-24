import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('bounds provider-rejected final JSON correction without accepting invalid output: repeated=%s', async repeated => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-final-shape-'))
  let work = 0, finals = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)), text = currentRequestText(messages)
    const refs = suppliedRequestResults(messages).map(r => r.id)
    let message: any
    if (text.includes('Create an executable plan')) message = { tasks: [{ id: 'save', kind: 'edit', goal: 'Create note.txt', check: 'Saved ready', criterionIds: ['criterion-1'], dependsOn: [] }] }
    else if (text.includes('Verify ONLY the active')) message = { status: 'passed', evidenceRefs: refs, note: 'Saved file' }
    else if (text.includes('Independently verify every ORIGINAL') || text.includes('Correct the listed field errors')) {
      finals++
      const criteria = [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs.filter(r => r === 'result-3'), rationale: 'Saved artifact tool evidence' }]
      message = finals === 1 || repeated ? criteria : { criteria }
    } else if (work++ === 0) return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'save-file', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'note.txt', content: 'ready' }) } }] }, finish_reason: 'tool_calls' }] })
    else message = 'Saved ready.'
    return Response.json({ choices: [{ message: { content: typeof message === 'string' ? message : JSON.stringify(message) }, finish_reason: 'stop' }] })
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }, taskController: true, maxModelCalls: 12, approvalMode: 'auto', jarvis: { enabled: false } })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Create note.txt containing ready.' })
    await run.outcome()
    expect(finals).toBe(2)
    expect((await run.taskOutcome())?.status).toBe(repeated ? 'incomplete' : 'accepted')
    expect((await run.usage()).modelCalls).toBeLessThanOrEqual(7)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
