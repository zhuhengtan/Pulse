import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, H5Server } from '@hunterzhu/pulse-server'
import { acceptWorkRequests } from './helpers/work-intent.js'
import { startH5WorkWorker } from '../packages/server/src/h5/work-worker.js'

it('carries an explicit false through the real worker IPC and persists the selected task policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-quality-worker-')), configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ providers: { mock: { provider: 'mock' } }, models: { mock: { provider: 'mock', displayName: 'mock', modelCode: 'mock' } }, activeModel: 'mock' }))
  const host = createLocalHost({ cwd: root, dataDir: root, taskController: false, qualityReviewEnabled: true, mockResponse: 'Hello.', jarvis: { enabled: false } })
  let worker: Awaited<ReturnType<typeof startH5WorkWorker>> | undefined
  try {
    const conversation = await host.createConversation()
    worker = await startH5WorkWorker({ entry: fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)), configPath, dataDir: root, cwd: root, approvalMode: 'auto', runtimeOptions: host.getWorkWorkerOptions() }, { conversationId: conversation.id, text: 'Say hello.', qualityReviewEnabled: false })
    await worker.outcome()
    const input = JSON.parse(await readFile(join(root, 'conversations', conversation.id, 'runs', worker.id, 'input.json'), 'utf8'))
    expect(input.qualityReviewEnabled).toBe(false)
    expect(await worker.taskOutcome()).toMatchObject({ status: 'unverifiable', reviewStatus: 'skipped' })
    expect((await worker.usage()).modelCalls).toBe(1)
  } finally { await worker?.shutdown?.().catch(() => undefined); await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('validates and snapshots the HTTP override, and prevents reusing an idempotency key with another choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-quality-http-'))
  const host = createLocalHost({ cwd: root, dataDir: root, qualityReviewEnabled: true, taskController: false, jarvis: { enabled: false }, mockResponse: 'done' })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir: root, port: 0, host: '127.0.0.1' })
  const info = await server.start(), base = `http://127.0.0.1:${info.port}`
  try {
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const cookie = session.headers.get('set-cookie')!, conversation = await host.createConversation()
    const send = (body: object) => fetch(base + `/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await send({ text: 'Say hello', qualityReviewEnabled: 'false' })).status).toBe(400)
    const body = { text: 'Say hello', requestId: 'quality-test-override', qualityReviewEnabled: false }
    const response = await send(body)
    expect(response.status).toBe(200)
    const receipt = await response.json()
    const input = JSON.parse(await readFile(join(root, 'conversations', conversation.id, 'runs', receipt.runId, 'input.json'), 'utf8'))
    expect(input.qualityReviewEnabled).toBe(false)
    const repeated = await send(body)
    expect(repeated.status).toBe(200)
    expect((await repeated.json()).runId).toBe(receipt.runId)
    expect((await send({ ...body, qualityReviewEnabled: true })).status).toBe(409)
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps an active supplement idempotent without changing the frozen review policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-quality-supplement-'))
  const host = createLocalHost({ cwd: root, dataDir: root, qualityReviewEnabled: true, taskController: false, approvalMode: 'ask', jarvis: { enabled: false }, mockToolCalls: [{ name: 'fs.write', input: { path: 'notes.txt', content: 'hello' } }] })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir: root, port: 0, host: '127.0.0.1' })
  const info = await server.start(), base = `http://127.0.0.1:${info.port}`
  try {
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const cookie = session.headers.get('set-cookie')!, conversation = await host.createConversation()
    const send = (body: object) => fetch(base + `/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const started = await send({ text: 'Create notes.txt containing hello.', requestId: 'origin-review-true', qualityReviewEnabled: true })
    expect(started.status).toBe(200)
    const runId = (await started.json()).runId as string
    const inputPath = join(root, 'conversations', conversation.id, 'runs', runId, 'input.json')
    const frozen = async () => JSON.parse(await readFile(inputPath, 'utf8')).qualityReviewEnabled
    expect(await frozen()).toBe(true)
    const same = { text: 'Add another line.', requestId: 'supplement-review-true', qualityReviewEnabled: true }
    const first = await send(same)
    expect(first.status).toBe(200)
    expect((await first.json()).runId).toBe(runId)
    const repeated = await send(same)
    expect(repeated.status).toBe(200)
    expect((await repeated.json()).runId).toBe(runId)
    expect((await send({ ...same, qualityReviewEnabled: false })).status).toBe(409)
    expect((await send({ text: same.text, requestId: same.requestId })).status).toBe(409)
    const omitted = { text: 'Leave the policy alone.', requestId: 'supplement-review-omitted' }
    expect((await send(omitted)).status).toBe(200)
    expect((await send(omitted)).status).toBe(200)
    expect((await send({ ...omitted, qualityReviewEnabled: false })).status).toBe(409)
    const disabled = { text: 'Record an explicit false.', requestId: 'supplement-review-false', qualityReviewEnabled: false }
    expect((await send(disabled)).status).toBe(200)
    expect((await send(disabled)).status).toBe(200)
    expect((await send({ ...disabled, qualityReviewEnabled: true })).status).toBe(409)
    expect(await frozen()).toBe(true)
    const messages = await host.getConversationMessages(conversation.id)
    expect(messages.find(message => message.id === 'msg-supplement-review-true')?.qualityReviewEnabled).toBe(true)
    expect(messages.find(message => message.id === 'msg-supplement-review-omitted')?.qualityReviewEnabled).toBeUndefined()
    expect(messages.find(message => message.id === 'msg-supplement-review-false')?.qualityReviewEnabled).toBe(false)
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
