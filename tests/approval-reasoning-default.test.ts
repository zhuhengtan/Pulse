import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { approvalReviewProfile } from '../packages/server/src/approval-review-profile.js'
import { createLocalHost } from '../packages/server/src/index.js'

const roots: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function review(modelCode: string, reasoningEffort?: 'low' | 'none') {
  const requests: Array<Record<string, unknown>> = []
  const reviewer = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'APPROVE' }, finish_reason: 'stop' }] }))
  })
  servers.push(reviewer)
  await new Promise<void>(resolve => reviewer.listen(0, '127.0.0.1', resolve))
  const port = (reviewer.address() as { port: number }).port
  const root = await mkdtemp(join(tmpdir(), 'pulse-approval-effort-'))
  roots.push(root)
  const previousHome = process.env.PULSE_HOME
  process.env.PULSE_HOME = root
  const path = join(root, 'config.json')
  await writeFile(path, JSON.stringify({
    providers: {
      local: { provider: 'mock', models: { mock: { modelCode: 'mock' } } },
      review: { provider: 'openai', baseURL: `http://127.0.0.1:${port}/v1`, models: { reviewer: { modelCode, ...(reasoningEffort ? { reasoningEffort } : {}) } } },
    },
    activeModel: 'local/mock',
    approvalReview: { model: 'review/reviewer' },
  }))
  try {
    const options = await hostOptions(parse(['--config', path]))
    const profile = approvalReviewProfile(options.approvalReview)
    const host = createLocalHost({ ...options, cwd: root, dataDir: join(root, 'data'), allowNetwork: true, approvalMode: 'ask', jarvis: { enabled: false }, mockToolCalls: [{ name: 'fs.write', input: { path: 'notes.txt', content: 'hello' } }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Create notes.txt containing hello.' })
      let result: Awaited<ReturnType<typeof run.reviewApproval>> | undefined
      for await (const event of run.events) if (event.type === 'waiting') {
        result = await run.reviewApproval((event.data as { effectId: string }).effectId)
        await run.cancel('REVIEW_CHECK_COMPLETE')
      }
      await run.outcome()
      const log = await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'approval-reviews.jsonl'), 'utf8').catch(() => '')
      return { options, profile, result, requests, log }
    } finally { await host.close() }
  } finally {
    if (previousHome === undefined) delete process.env.PULSE_HOME
    else process.env.PULSE_HOME = previousHome
  }
}

it('does not invent reasoning effort none for a chat model with no reasoning support', async () => {
  const { options, profile, result, requests } = await review('gpt-4o')
  expect(options.approvalReview).not.toHaveProperty('reasoningEffort')
  expect(profile).not.toHaveProperty('reasoningEffort')
  expect(result).toEqual({ status: 'approved', reason: 'approved' })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.reasoning_effort).toBeUndefined()
})

it('does not invent reasoning effort none for a model whose levels exclude none', async () => {
  const { options, profile, result, requests } = await review('gpt-5')
  expect(options.approvalReview).not.toHaveProperty('reasoningEffort')
  expect(profile).not.toHaveProperty('reasoningEffort')
  expect(result).toEqual({ status: 'approved', reason: 'approved' })
  expect(requests[0]?.model).toBe('gpt-5')
  expect(requests[0]?.reasoning_effort).toBeUndefined()
})

it('sends an explicit supported reasoning effort', async () => {
  const { options, profile, result, requests } = await review('gpt-5', 'low')
  expect(options.approvalReview).toMatchObject({ reasoningEffort: 'low' })
  expect(profile.reasoningEffort).toBe('low')
  expect(result).toEqual({ status: 'approved', reason: 'approved' })
  expect(requests[0]?.reasoning_effort).toBe('low')
})

it('rejects an explicit unsupported reasoning effort before calling the model', async () => {
  const { options, profile, result, requests, log } = await review('gpt-5', 'none')
  expect(options.approvalReview).toMatchObject({ reasoningEffort: 'none' })
  expect(profile.reasoningEffort).toBe('none')
  expect(result).toEqual({ status: 'manual', reason: 'review_failed' })
  expect(requests).toHaveLength(0)
  expect(log).toContain('PROVIDER_REASONING_UNSUPPORTED')
})
