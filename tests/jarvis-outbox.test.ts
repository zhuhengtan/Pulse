import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { createLocalHost, JarvisClient } from '../packages/server/src/index.js'
import { JarvisRun } from '../packages/server/src/jarvis/run.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-outbox-')); roots.push(root)
  let failingPath = ''
  const calls: Array<{ path: string; key: string | undefined; body: any }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    calls.push({ path, key: (init.headers as Record<string, string>)['idempotency-key'], body: JSON.parse(String(init.body)) })
    if (path === failingPath) return new Response('{}', { status: 503 })
    if (path === '/v1/sessions') return new Response(JSON.stringify({ session: { id: 'session-outbox', projectId: 'project', workspace: root } }))
    if (path === '/v1/context/build') return new Response(JSON.stringify({ text: 'Reference' }))
    return new Response('{}')
  }))
  const client = new JarvisClient({ token: 'SYNTHETIC_CONFIGURED_CREDENTIAL' })
  const path = join(root, 'jarvis.json')
  const run = (await JarvisRun.open(client, path, root, 'Task', 4000))!
  const runtime = { state: { effects: new Map([['effect-1', { id: 'effect-1', kind: 'tool', input: { name: 'fs.read', arguments: { secret: 'PRIVATE_ARGUMENT' } }, outcome: { status: 'succeeded' } }]]), results: new Map() } } as unknown as PulseRuntime
  const binding = async () => JSON.parse(await readFile(path, 'utf8'))
  return { root, path, client, run, runtime, calls, binding, fail: (path: string) => { failingPath = path } }
}

it('retains failed events and completion across restore, and advances only acknowledged cursors', async () => {
  const f = await fixture(); f.fail('/v1/events')
  await expect(f.run.close(f.runtime, { result: 'partial', summary: 'SYNTHETIC_CONFIGURED_CREDENTIAL', details: 'Evidence SYNTHETIC_CONFIGURED_CREDENTIAL', extractMemory: false })).rejects.toThrow('503')
  const failed = await f.binding()
  expect(failed).toMatchObject({ closed: false, recordedEffectIds: [], pendingEvents: [{ effectId: 'effect-1' }] })
  expect(JSON.stringify(failed)).not.toContain('SYNTHETIC_CONFIGURED_CREDENTIAL')
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_ARGUMENT')
  expect(f.calls.some((call) => call.path.endsWith('/close'))).toBe(false)
  f.fail('')
  const restored = (await JarvisRun.open(f.client, f.path, f.root, 'Task', 4000, true))!
  await restored.close(f.runtime, { result: 'partial', summary: 'ignored on retry' })
  expect(await f.binding()).toMatchObject({ closed: true, recordedEffectIds: ['effect-1'], pendingEvents: [] })
  expect(f.calls.find(call => call.path.endsWith('/close'))?.body).toMatchObject({ extractMemory: false, details: expect.stringContaining('Evidence') })
  expect(JSON.stringify(f.calls)).not.toContain('SYNTHETIC_CONFIGURED_CREDENTIAL')
  expect(f.calls.filter((call) => call.path === '/v1/sessions')).toHaveLength(1)
  const keys = f.calls.filter((call) => call.path === '/v1/events').map((call) => call.key)
  expect(new Set(keys).size).toBe(1)
})

it('retries candidate delivery before close and does not resend an acknowledged candidate', async () => {
  const f = await fixture(); f.fail('/v1/memory/candidates')
  await expect(f.run.close(undefined, { result: 'success', summary: 'Done' }, { title: 'Workflow', content: 'Verified', sourceRefs: [f.run.sessionId] })).rejects.toThrow()
  expect(await f.binding()).toMatchObject({ closed: false, completion: { candidateRecorded: false } })
  f.fail('/v1/sessions/session-outbox/close')
  await expect(JarvisRun.retryCompletion(f.client, f.path)).rejects.toThrow()
  expect(await f.binding()).toMatchObject({ closed: false, completion: { candidateRecorded: true } })
  const count = f.calls.filter((call) => call.path === '/v1/memory/candidates').length
  f.fail(''); await JarvisRun.retryCompletion(f.client, f.path)
  expect((await f.binding()).closed).toBe(true)
  expect(f.calls.filter((call) => call.path === '/v1/memory/candidates')).toHaveLength(count)
})

it('retries completed offline runs on host initialization without restarting their tasks', async () => {
  const f = await fixture(); f.fail('/v1/sessions/session-outbox/close')
  const options = { cwd: f.root, dataDir: join(f.root, 'pulse'), jarvisClient: f.client, mockResponse: 'Done' }
  const first = createLocalHost(options)
  const conversation = await first.createConversation()
  const run = await first.sendMessage(conversation.id, { text: 'Say hello' })
  for await (const _event of run.events) {}
  await run.outcome(); await first.close()
  const path = join(options.dataDir, 'conversations', conversation.id, 'runs', run.id, 'jarvis.json')
  expect(JSON.parse(await readFile(path, 'utf8')).closed).toBe(false)
  const opens = f.calls.filter((call) => call.path === '/v1/sessions').length
  f.fail('')
  const second = createLocalHost(options)
  try {
    await second.init()
    expect(JSON.parse(await readFile(path, 'utf8')).closed).toBe(true)
    expect(f.calls.filter((call) => call.path === '/v1/sessions')).toHaveLength(opens)
    expect((await second.getConversation(conversation.id)).summary.runs).toEqual([run.id])
  } finally { await second.close() }
})

it.each(['submitHumanInput', 'reply'] as const)('records user corrections sent through %s before closing', async (method) => {
  const f = await fixture()
  const host = createLocalHost({ cwd: f.root, dataDir: join(f.root, 'pulse'), jarvisClient: f.client, provider: { provider: 'mock' }, approvalMode: 'auto', mockToolCalls: [{ name: 'ask.input', input: { prompt: 'Continue?' } }], mockAfterToolResponse: 'Done' })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: 'Ask before continuing' })
    for await (const event of run.events) if (event.type === 'waiting') {
      const id = (event.data as { effectId: string }).effectId
      if (method === 'reply') await run.reply(id, { text: '以后请用中文回答；token=SYNTHETIC_USER_CREDENTIAL' })
      else await run.submitHumanInput('以后请用中文回答；token=SYNTHETIC_USER_CREDENTIAL', id)
    }
    await run.outcome()
    const observation = f.calls.findIndex((call) => call.path === '/v1/events' && call.body.type === 'observation')
    const close = f.calls.findIndex((call) => call.path.endsWith('/close'))
    expect(observation).toBeGreaterThan(-1); expect(close).toBeGreaterThan(observation)
    expect(f.calls[observation]!.body.content).toContain('以后请用中文回答')
    expect(JSON.stringify(f.calls)).not.toContain('SYNTHETIC_USER_CREDENTIAL')
  } finally { await host.close() }
})
