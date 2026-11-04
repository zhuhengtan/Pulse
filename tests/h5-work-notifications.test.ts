import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'

const exec = promisify(execFile)
it.each([false, true])('finishes project work independently of chat notifications (chat start: %s)', async chatStart => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-work-notification-'))
  const projectRoot = join(root, 'project'), dataDir = join(root, 'data')
  await mkdir(projectRoot)
  const git = (...args: string[]) => exec('git', args, { cwd: projectRoot })
  await git('init', '--quiet'); await git('config', 'user.name', 'Pulse Test'); await git('config', 'user.email', 'pulse-test@localhost')
  await writeFile(join(projectRoot, 'base.txt'), 'base\n'); await git('add', '.'); await git('commit', '--quiet', '-m', 'baseline')
  const profile = { provider: 'mock' as const, defaultModel: 'mock' }
  const options = { cwd: projectRoot, dataDir, approvalMode: 'auto' as const, provider: profile, providerProfiles: { mock: profile }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', jarvis: { enabled: false }, mockResponse: '工作已完成并合入。', mockToolCalls: [{ name: 'fs.write', input: { path: 'notes.txt', content: 'hello' } }], mockAfterToolResponse: 'Created notes.txt with hello.', mockTaskAssessments: [{ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'File write completed.' }] }] }
  let host = createLocalHost(options), server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
  try {
    let base = `http://127.0.0.1:${(await server.start()).port}`
    const authorize = async () => {
      const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
      return { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    }
    let headers = await authorize()
    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ cwd: projectRoot, name: 'Fixture project' }) }).then(response => response.json()) as { id: string }
    const task = 'Create notes.txt with the exact content hello.'
    const workId = chatStart
      ? (await (server as unknown as { startWorkFromAssistant(projectId: string, task: string): Promise<{ conversationId: string }> }).startWorkFromAssistant(project.id, task)).conversationId
      : (await host.createConversation({ title: 'Create notes', cwd: projectRoot, projectId: project.id })).id
    if (!chatStart) await fetch(`${base}/api/conversations/${workId}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: task }) })
    if (chatStart) {
      expect((await host.getConversation(workId)).summary.control).toMatchObject({ owner: 'assistant' })
      expect((server as unknown as { assistantInbox: AssistantConversationStore }).assistantInbox.workLink(workId)).toMatchObject({ projectId: project.id })
    }
    await vi.waitFor(async () => {
      const record = JSON.parse(await readFile(join(dataDir, 'workspaces', 'records', `${workId}.json`), 'utf8'))
      expect(record.status).toBe('merged')
    }, { timeout: 15_000, interval: 40 })
    expect(await readFile(join(projectRoot, 'notes.txt'), 'utf8')).toBe('hello')
    type AssistantMessage = { id: string; messageKind?: string; work?: { conversationId: string; state?: string } }
    const view = async () => await fetch(`${base}/api/assistant`, { headers }).then(response => response.json()) as { messages: AssistantMessage[] }
    const noticesFor = (messages: AssistantMessage[]) => messages.filter(message => message.messageKind === 'work_notice' && message.work?.conversationId === workId)
    let noticeId: string | undefined
    await vi.waitFor(async () => {
      const notices = noticesFor((await view()).messages)
      expect(notices).toHaveLength(chatStart ? 1 : 0)
      if (chatStart) {
        expect(notices[0]).toMatchObject({ work: { conversationId: workId, state: 'succeeded' } })
        expect(notices[0]?.id.startsWith('chat-')).toBe(true)
        noticeId = notices[0]?.id
      }
    }, { timeout: 15_000, interval: 40 })
    await server.stop(); await host.close()
    // A stored link or an old manual notice does not authorize a chat work card.
    if (!chatStart) {
      const store = new AssistantConversationStore(dataDir)
      try {
        await store.init(async () => { throw new Error('Expected existing assistant') })
        await store.linkWork(workId, project.id, 'Old manual task')
        await store.addWorkNotice({ id: 'legacy-manual-notice', role: 'assistant', text: 'Old manual result', createdAt: new Date().toISOString(), messageKind: 'work_notice', work: { conversationId: workId, projectId: project.id, title: 'Old manual task', state: 'succeeded' } })
      } finally { await store.close() }
    }
    host = createLocalHost(options); server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${(await server.start()).port}`; headers = await authorize()
    expect((await host.getConversation(workId)).summary.origin).toBe(chatStart ? 'assistant' : undefined)
    const restored = noticesFor((await view()).messages)
    expect(restored.map(message => message.id)).toEqual(chatStart ? [noticeId] : [])
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 30_000)
