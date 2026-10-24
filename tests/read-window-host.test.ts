import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

it('routes oversized-read preflight back to the model before dispatch or cache reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-read-window-host-')), objective = 'Read report.md completely and report its ending.'
  await writeFile(join(root, 'report.md'), 'a'.repeat(3000) + 'UNREAD TAIL\n')
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let turns = 0, sawCorrection = false, correctionText = ''
  const reply = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (args: object) => reply({ content: '', tool_calls: [{ id: `read-${turns}`, function: { name: 'fs_read', arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body)), text = currentRequestText(body.messages), refs = suppliedRequestResults(body.messages).map(r => r.id)
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [{ id: 'inspect', kind: 'verify', goal: 'Inspect report.md completely', check: 'Read both windows and report the ending', criterionIds: ids, dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active taskController stage')) return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Both current file windows read.' }))
    if (text.includes('Independently verify every ORIGINAL')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Complete current file read.' })) }))
    turns++
    if (turns === 1) return tool({ path: 'report.md' })
    if (turns === 2) return tool({ path: 'report.md', maxBytes: 6000 })
    if (turns === 3) { correctionText = JSON.stringify(body.messages); sawCorrection = /maxBytes must be <= 3000/.test(correctionText) && /nextOffset/.test(correctionText); return tool({ path: 'report.md', offset: 3000, maxBytes: 3000 }) }
    return reply('Complete file ending: UNREAD TAIL.')
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, jarvis: { enabled: false }, maxModelCalls: 24 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    await run.outcome()
    const runRoot = join(root, 'data/conversations', conversation.id, 'runs', run.id)
    const state = JSON.parse(await readFile(join(runRoot, 'runtime.json'), 'utf8')).state.state
    const reads = state.effects.map(([, effect]: any) => effect).filter((effect: any) => effect.kind === 'tool' && effect.input.name === 'fs.read')
    expect(sawCorrection, JSON.stringify({ turns, correctionText, reads: reads.map((e: any) => e.input), input: JSON.parse(await readFile(join(runRoot, 'input.json'), 'utf8')) })).toBe(true)
    expect(reads.map((effect: any) => effect.input.arguments.offset ?? 0)).toEqual([0, 3000])
    expect(reads.some((effect: any) => effect.input.arguments.maxBytes > 3000)).toBe(false)
    expect(JSON.parse(await readFile(join(runRoot, 'task-outcome.json'), 'utf8')).status).toBe('accepted')
  } finally { await host.close(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) }
})
