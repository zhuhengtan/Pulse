import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
afterEach(() => vi.unstubAllGlobals())
it('continues through an authorized alternative after a real Host approval denial without replaying the denied write', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-authorized-alternative-'))
  await writeFile(join(cwd, 'guarded.txt'), 'preserve me')
  let work = 0, denied = 0, approved = 0
  const chat = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    if (request.messages.some((m: any) => String(m.content).includes('You are the Pulse safety reviewer'))) {
      if (denied === 0) { denied++; return chat('DENY') }
      approved++; return chat('APPROVE')
    }
    if (text.includes("You write Pulse's final user-facing reply")) return chat('Saved output.txt; guarded.txt is unchanged.')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'deliver', kind: 'edit', goal: 'Create output.txt', check: 'Requested file saved, guarded.txt preserved', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    const refs = suppliedRequestResults(request.messages).filter(row => row.value?.path === 'output.txt').map(row => row.id)
    if (text.includes('Verify ONLY the active')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Actual output saved' }))
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Requested output saved' }] }))
    work++
    if (work <= 2) return chat({ content: '', tool_calls: [{ id: `write-${work}`, function: { name: work === 1 ? 'shell_exec' : 'fs_write', arguments: JSON.stringify(work === 1 ? { command: 'node', args: ['-e', 'require("fs").writeFileSync("guarded.txt","unauthorized")'] } : { path: 'output.txt', content: 'requested output' }) } }] })
    return chat('Saved output.txt.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, '.data'), taskController: true, jarvis: { enabled: false }, provider: { provider: 'openai', defaultModel: 'fixture' }, approvalMode: 'auto', approvalReview: { provider: 'ollama', model: 'fixture-reviewer', baseURL: 'http://127.0.0.1:11434', timeoutMs: 15000 }, maxModelCalls: 24 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Create output.txt containing requested output.' })
    const outcome = await run.outcome()
    expect(await readFile(join(cwd, 'guarded.txt'), 'utf8')).toBe('preserve me')
    expect(await readFile(join(cwd, 'output.txt'), 'utf8').catch(() => null), JSON.stringify({ outcome, work, denied, approved })).toBe('requested output')
    expect(denied).toBe(1); expect(approved).toBeLessThanOrEqual(1)
    expect(await run.taskOutcome()).toMatchObject({ status: 'accepted' })
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
