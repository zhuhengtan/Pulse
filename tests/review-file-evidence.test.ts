import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import type { ResultMeta } from '@hunterzhu/pulse-runtime'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { durableFileWrite } from '../packages/server/src/review-verdict.js'
import { acceptWorkRequests } from './helpers/work-intent.js'

const hash = 'a'.repeat(64)
const before = 'b'.repeat(64)
const meta = (toolName: string, outcomeStatus: ResultMeta['outcomeStatus'] = 'succeeded'): ResultMeta => ({ effectKind: 'tool', toolName, outcomeStatus }) as ResultMeta

it('accepts a successful new or replacement file receipt and rejects everything else', () => {
  expect(durableFileWrite(meta('fs.write'), { path: 'notes.txt', bytes: 5, hash })).toBe(true)
  expect(durableFileWrite(meta('plan.write'), { path: 'docs/plans/feature.md', bytes: 0, hash })).toBe(true)
  expect(durableFileWrite(meta('fs.overwrite'), { path: 'notes.txt', bytes: 5, hash, beforeHash: before })).toBe(true)
  expect(durableFileWrite(meta('fs.overwrite'), { path: 'notes.txt', bytes: 5, hash, beforeHash: hash })).toBe(false)
  expect(durableFileWrite(meta('fs.apply_patch'), { changed: true })).toBe(true)
  expect(durableFileWrite(meta('fs.stage'), { committed: true, target: 'notes.txt' })).toBe(true)
  expect(durableFileWrite(meta('fs.write', 'failed'), { path: 'notes.txt', bytes: 5, hash })).toBe(false)
  expect(durableFileWrite(meta('fs.write'), { path: 'notes.txt', bytes: 5, hash, changed: false })).toBe(false)
  expect(durableFileWrite(meta('fs.overwrite'), { path: 'notes.txt', bytes: 5, hash })).toBe(false)
  expect(durableFileWrite(meta('fs.stage'), { committed: false, target: 'notes.txt', bytes: 5 })).toBe(false)
  expect(durableFileWrite(meta('fs.apply_patch'), { changed: false })).toBe(false)
  expect(durableFileWrite({ effectKind: 'llm', outcomeStatus: 'succeeded' } as ResultMeta, { text: 'wrote notes.txt' })).toBe(false)
  expect(durableFileWrite(meta('fs.read'), { path: 'notes.txt', bytes: 5, hash })).toBe(false)
})

const exec = promisify(execFile)

async function taskOutcome(dataDir: string): Promise<{ status?: string }> {
  const conversations = await readdir(join(dataDir, 'conversations')).catch(() => [] as string[])
  for (const conversation of conversations) {
    const runs = await readdir(join(dataDir, 'conversations', conversation, 'runs')).catch(() => [] as string[])
    for (const run of runs) {
      const text = await readFile(join(dataDir, 'conversations', conversation, 'runs', run, 'task-outcome.json'), 'utf8').catch(() => '')
      if (text) return JSON.parse(text) as { status?: string }
    }
  }
  return {}
}

async function collectText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const parts: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) parts.push(await collectText(path))
    else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) parts.push(await readFile(path, 'utf8').catch(() => ''))
  }
  return parts.join('\n')
}

it.each([false, true])('non-controller acceptance ignores an unchanged overwrite and keeps a real change (changed: %s)', async changed => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-overwrite-evidence-'))
  const projectRoot = join(root, 'project'), dataDir = join(root, 'data')
  await mkdir(projectRoot)
  const git = (...args: string[]) => exec('git', args, { cwd: projectRoot })
  await git('init', '--quiet'); await git('config', 'user.name', 'Pulse Test'); await git('config', 'user.email', 'pulse-test@localhost')
  const original = 'hello'
  await writeFile(join(projectRoot, 'notes.txt'), original)
  await git('add', '.'); await git('commit', '--quiet', '-m', 'baseline')
  const next = changed ? 'hello!' : original
  const expectedHash = createHash('sha256').update(original).digest('hex')
  const profile = { provider: 'mock' as const, defaultModel: 'mock' }
  const options = {
    cwd: projectRoot, dataDir, approvalMode: 'auto' as const, taskController: false as const, provider: profile,
    providerProfiles: { mock: profile }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock',
    jarvis: { enabled: false },
    mockToolCalls: [{ name: 'fs.read', input: { path: 'notes.txt' } }, { name: 'fs.overwrite', input: { path: 'notes.txt', content: next, expectedHash } }],
    mockAfterToolResponse: changed ? 'Updated notes.txt.' : 'notes.txt already contained hello.',
    mockTaskAssessments: [{ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'Checked the file receipt.' }] }],
  }
  const host = createLocalHost(options)
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ cwd: projectRoot, name: 'Fixture project' }) }).then(response => response.json()) as { id: string }
    const conversation = await host.createConversation({ title: 'Update notes', cwd: projectRoot, projectId: project.id })
    await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: `Update notes.txt so it contains the exact content ${next}.` }) })
    await vi.waitFor(async () => {
      const dumped = await collectText(join(dataDir, 'conversations'))
      expect(dumped).toContain('"beforeHash"')
      expect((await taskOutcome(dataDir)).status).toBe(changed ? 'accepted' : 'unverifiable')
    }, { timeout: 20_000, interval: 40 })
    expect(await readFile(join(projectRoot, 'notes.txt'), 'utf8')).toBe(next)
    await vi.waitFor(async () => {
      const record = JSON.parse(await readFile(join(dataDir, 'workspaces', 'records', `${conversation.id}.json`), 'utf8'))
      expect(record.status).toBe(changed ? 'merged' : 'pending')
    }, { timeout: 15_000, interval: 40 })
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 30_000)
