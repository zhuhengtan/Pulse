import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'

const exec = promisify(execFile)
it.each([false, true])('finishes project work independently of chat notifications (assistant origin: %s)', async assistantOrigin => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-work-notification-'))
  const projectRoot = join(root, 'project'), dataDir = join(root, 'data')
  await mkdir(projectRoot)
  const git = (...args: string[]) => exec('git', args, { cwd: projectRoot })
  await git('init', '--quiet'); await git('config', 'user.name', 'Pulse Test'); await git('config', 'user.email', 'pulse-test@localhost')
  await writeFile(join(projectRoot, 'base.txt'), 'base\n'); await git('add', '.'); await git('commit', '--quiet', '-m', 'baseline')
  const options = { cwd: projectRoot, dataDir, approvalMode: 'auto' as const, mockToolCalls: [{ name: 'fs.write', input: { path: 'notes.txt', content: 'hello' } }], mockAfterToolResponse: 'Created notes.txt with hello.', mockTaskAssessments: [{ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'File write completed.' }] }] }
  let host = createLocalHost(options), server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
  try {
    let base = `http://127.0.0.1:${(await server.start()).port}`
    const authorize = async () => {
      const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
      return { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    }
    let headers = await authorize()
    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ cwd: projectRoot, name: 'Fixture project' }) }).then(response => response.json()) as { id: string }
    const work = await host.createConversation({ title: 'Create notes', cwd: projectRoot, projectId: project.id, ...(assistantOrigin ? { origin: 'assistant' as const } : {}) })
    const sent = await fetch(`${base}/api/conversations/${work.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Create notes.txt with the exact content hello.' }) }).then(response => response.json()) as { runId: string }
    await vi.waitFor(async () => {
      const record = JSON.parse(await readFile(join(dataDir, 'workspaces', 'records', `${work.id}.json`), 'utf8'))
      expect(record.status).toBe('merged')
    }, { timeout: 10_000, interval: 40 })
    expect(await readFile(join(projectRoot, 'notes.txt'), 'utf8')).toBe('hello')
    const view = async () => await fetch(`${base}/api/assistant`, { headers }).then(response => response.json()) as { messages: Array<{ id: string; work?: { conversationId: string } }> }
    await vi.waitFor(async () => expect((await view()).messages.some(message => message.id === `work-${sent.runId}`)).toBe(assistantOrigin))
    await server.stop(); await host.close()
    // Legacy links/notices alone do not establish that a task originated in chat.
    if (!assistantOrigin) {
      const store = new AssistantConversationStore(dataDir)
      try {
        await store.init(async () => { throw new Error('Expected existing assistant') })
        await store.linkWork(work.id, project.id, 'Old manual task')
        await store.addWorkNotice({ id: 'legacy-manual-notice', role: 'assistant', text: 'Old manual result', createdAt: new Date().toISOString(), work: { conversationId: work.id, projectId: project.id, title: 'Old manual task', state: 'succeeded' } })
      } finally { await store.close() }
    }
    host = createLocalHost(options); server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${(await server.start()).port}`; headers = await authorize()
    expect((await host.getConversation(work.id)).summary.origin).toBe(assistantOrigin ? 'assistant' : undefined)
    const restored = (await view()).messages.filter(message => message.work?.conversationId === work.id)
    expect(restored.length).toBe(assistantOrigin ? 1 : 0)
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 20_000)
