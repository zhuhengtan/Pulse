import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, writeGlobalPrompt } from '../packages/server/src/index.js'

const previousHome = process.env.PULSE_HOME
const isolatedHome = mkdtempSync(join(tmpdir(), 'pulse-chat-global-prompt-home-'))
process.env.PULSE_HOME = isolatedHome
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
afterAll(() => { if (previousHome === undefined) delete process.env.PULSE_HOME; else process.env.PULSE_HOME = previousHome; rmSync(isolatedHome, { recursive: true, force: true }) })

const profile = { provider: 'openai-compatible' as const, defaultModel: 'fixture', baseURL: 'http://127.0.0.1:12345/v1' }
const workTools = () => ({ start: vi.fn(async () => ({ conversationId: 'work-1', projectId: 'p', title: 'Inspect' })), list: async () => [], status: async () => ({}), send: async () => {}, stop: async () => {}, resume: async () => {} })
const systemOf = (body: { messages: Array<{ role: string; content: unknown }> }) => String(body.messages.find(message => message.role === 'system')?.content ?? '')

function stubProvider(systems: string[]) {
  let modelCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const body = JSON.parse(String(options.body))
    systems.push(systemOf(body))
    const tool = modelCalls++ === 0
    const message = tool ? { content: '', tool_calls: [{ id: 'start', function: { name: 'work_start', arguments: JSON.stringify({ projectId: 'p', task: 'Inspect' }) } }] } : { content: 'Started' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  }))
}

async function hostOptions() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-chat-global-prompt-')); roots.push(root)
  return { cwd: root, dataDir: join(root, 'data'), provider: profile, providerProfiles: { fixture: profile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', approvalMode: 'ask' as const, systemPrompt: 'CUSTOM_ASSISTANT_SYSTEM' }
}

it('adds the global prompt to a new assistant chat without replacing the custom prompt or chat boundaries', async () => {
  await writeGlobalPrompt('GLOBAL_CHAT_PROMPT: always answer briefly.')
  const systems: string[] = [], options = await hostOptions(); stubProvider(systems)
  const host = createLocalHost(options); host.setAssistantWorkTools(workTools())
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '请调用 work.start 查看项目', assistantChat: true })
    for await (const event of run.events) if (event.type === 'waiting') { const pending = await run.pendingInteractions(); await run.reply(pending[0]!.items[0]!.effectId, { approved: true }) }
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
  } finally { await host.close() }
  expect(systems.length).toBeGreaterThan(0)
  for (const system of systems) {
    expect(system.startsWith('CUSTOM_ASSISTANT_SYSTEM')).toBe(true)
    expect(system).toContain('GLOBAL_CHAT_PROMPT: always answer briefly.')
    expect(system).toContain('不得在助理聊天中直接修改文件或运行命令')
    expect(system.indexOf('Pulse 聊天模式')).toBeLessThan(system.indexOf('## Global Instructions'))
  }
})

it('adds the current global prompt after a cold restore of an assistant chat', async () => {
  await writeGlobalPrompt('GLOBAL_CHAT_PROMPT_V1')
  const systems: string[] = [], options = await hostOptions(); stubProvider(systems)
  let host = createLocalHost(options); host.setAssistantWorkTools(workTools())
  try {
    const conversation = await host.createConversation(); let run = await host.sendMessage(conversation.id, { text: '请调用 work.start 查看项目', assistantChat: true })
    for await (const event of run.events) if (event.type === 'waiting') break
    const pending = await run.pendingInteractions(), runId = run.id
    await host.close({ preserveRuns: true })
    await writeGlobalPrompt('GLOBAL_CHAT_PROMPT_V2')
    const before = systems.length
    host = createLocalHost(options); host.setAssistantWorkTools(workTools()); run = await host.resumeRun(conversation.id)
    expect(run.id).toBe(runId)
    await run.reply(pending[0]!.items[0]!.effectId, { approved: true })
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    const resumed = systems.slice(before)
    expect(resumed.length).toBeGreaterThan(0)
    for (const system of resumed) {
      expect(system.startsWith('CUSTOM_ASSISTANT_SYSTEM')).toBe(true)
      expect(system).toContain('GLOBAL_CHAT_PROMPT_V2')
      expect(system).not.toContain('GLOBAL_CHAT_PROMPT_V1')
    }
  } finally { await host.close() }
})
