import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
it('retrieves omitted delivery evidence through the real Host index without repeating file operations', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-delivery-host-'))
  const objective = 'Create 20 fixture text files, then summarize their original write receipts without rewriting them.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let writes = 0, readTurn = 0, calls = 0
  const indexes: any[] = [], mockErrors: string[] = []
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, args: unknown) => chat({ content: '', tool_calls: [{ id: `call-${calls}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    calls++
    try {
    const { messages } = JSON.parse(String(init?.body)), text = currentRequestText(messages), results = suppliedRequestResults(messages)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'files', kind: 'edit', goal: 'Create 20 fixture text files under fixtures/', check: '20 file write receipts', criterionIds: ids, dependsOn: [] },
      { id: 'summary', kind: 'analyze', goal: 'Summarize original fixture write receipts', check: 'Original receipts retrieved and summarized without rewriting files', criterionIds: ids, dependsOn: ['files'] },
    ] }))
    if (text.includes('Summarize completed evidence and constraints')) return chat('The files stage created fixtures/0.txt through fixtures/19.txt. Original evidence remains in the Host delivery index. Keep the user constraints and do not replay writes.')
    const refs = results.map(r => r.id)
    if (text.includes('Verify ONLY the active')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Current original receipts verified' }))
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Original receipts and actual files' })) }))
    if (text.includes('progress checkpoint')) return chat(JSON.stringify({ status: 'ready', evidenceRefs: refs, note: 'Original receipts retained' }))
    if (/"activeStage":\{"id":"files"/.test(text)) {
      if (writes >= 20) return chat('20 fixture files created')
      const tools = Array.from({ length: 4 }, () => { const i = writes++; return { id: `write-${i}`, function: { name: 'fs_write', arguments: JSON.stringify({ path: `fixtures/${i}.txt`, content: `fixture-${i}` }) } } })
      return chat({ content: '', tool_calls: tools })
    }
    if (readTurn++ === 0) {
      const delivery = messages.flatMap((m: any) => { try { return JSON.parse(m.content).deliveries ?? [] } catch { return [] } })[0]
      expect(delivery).toMatchObject({ version: 1, stageId: 'files', evidenceCount: 20, lookup: { tool: 'task.delivery', stageId: 'files' } })
      expect(delivery.omitted).toBeGreaterThan(0); expect(Buffer.byteLength(JSON.stringify(delivery))).toBeLessThanOrEqual(4096)
      return tool('task_delivery', { stageId: 'files', offset: 0 })
    }
    const index = results.map(r => r.value).filter(v => v?.stageId === 'files' && Array.isArray(v.evidenceRefs)).sort((a, b) => b.offset - a.offset)[0]
    if (index) indexes.push(index)
    if (readTurn === 2) { expect(index.nextOffset).toBe(16); return tool('task_delivery', { stageId: 'files', offset: index.nextOffset }) }
    if (readTurn === 3) { expect(index.nextOffset).toBeNull(); return tool('task_evidence', { ref: index.evidenceRefs.at(-1) }) }
    expect(results.some(r => typeof r.value?.content === 'string' && r.value.content.includes('fixtures/'))).toBe(true)
    return chat('All 20 original fixture receipts are preserved; summary complete.')
    } catch (e) { mockErrors.push(String(e)); throw e }
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 32 })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: objective })
    const outcome = await run.outcome(); expect(outcome, JSON.stringify({ outcome, calls, writes, readTurn, indexes, mockErrors })).toMatchObject({ status: 'succeeded' })
    expect((await run.taskOutcome())?.status).toBe('accepted')
    expect(await readdir(join(cwd, 'fixtures'))).toHaveLength(20)
    expect(writes).toBe(20)
    expect(new Set(indexes.flatMap(p => p.evidenceRefs)).size).toBe(20)
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', c.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    expect(state.tasks[0].ownerLaneId).toBe(state.tasks[1].ownerLaneId)
    expect((await run.usage()).modelCalls).toBe(calls)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 180_000 : 60_000)
