import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'

it.each([
  { name: 'fs.write', input: { path: 'new/deep/security.ts', content: 'export const token = "example"; // password validation' } },
  { name: 'fs.stage', input: { path: 'new/deep/token-utils.ts', content: 'export const token = "example";' } },
  { name: 'plan.write', input: { path: 'docs/plans/ask.md', content: '# Ask\nUse a textarea.' } },
])('reviews an authorized $name without rejecting code words or missing parent directories', async call => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-delegated-'))
  let requests = 0
  const reviewer = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'APPROVE' }, finish_reason: 'stop' }] })) })
  await new Promise<void>(resolve => reviewer.listen(0, '127.0.0.1', resolve))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'ask', mockToolCalls: [call], approvalReview: { provider: 'ollama', model: 'test', baseURL: `http://127.0.0.1:${(reviewer.address() as any).port}`, timeoutMs: 2000 } })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: 'Implement the Ask textarea and create the requested plan and source files.' })
    let reviewed = false
    for await (const event of run.events) if (event.type === 'waiting') {
      const result = await run.reviewApproval((event.data as any).effectId)
      expect(result).toMatchObject({ status: 'approved' })
      reviewed = true
      await run.cancel('REVIEW_TEST_FINISHED')
    }
    expect(reviewed).toBe(true)
    expect(requests).toBe(1)
    await run.outcome()
  } finally { await host.close(); await new Promise<void>(resolve => reviewer.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

it.each(['.env', 'outside/missing/result.txt', 'dangling/new/result.txt'])('keeps a sensitive or escaped target %s for manual review', async path => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-delegated-boundary-')), workspace = join(root, 'work'), outside = join(root, 'outside')
  await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, 'seed.txt'), 'seed')
  await symlink(outside, join(workspace, 'outside')); await symlink(join(root, 'absent'), join(workspace, 'dangling'))
  const host = createLocalHost({ cwd: workspace, dataDir: join(root, 'data'), approvalMode: 'ask', mockToolCalls: [{ name: 'fs.write', input: { path, content: 'test' } }] })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Implement the Ask textarea.' })
    let checked = false
    for await (const event of run.events) if (event.type === 'waiting') {
      expect(await run.reviewApproval((event.data as any).effectId)).toMatchObject({ status: 'manual', reason: path === '.env' ? 'risk_requires_user' : 'path_outside_workspace' })
      checked = true; await run.cancel('BOUNDARY_TEST_FINISHED')
    }
    expect(checked).toBe(true); await run.outcome()
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
