import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { startH5WorkWorker } from '../packages/server/src/h5/work-worker.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('H5 work worker IPC', () => {
  it('adapts versioned process events and interaction RPCs into a RunHandle', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pulse-worker-'))
    temporaryDirectories.push(dataDir)
    const conversationId = 'conv-12345678-1234-1234-1234-123456789abc'
    const handle = await startH5WorkWorker({
      entry: fileURLToPath(new URL('./fixtures/h5-work-worker.mjs', import.meta.url)),
      dataDir,
      approvalMode: 'ask',
      startupTimeoutMs: 2_000,
    }, { conversationId, text: 'run isolated' })

    expect(handle.id).toBe('run-worker-fixture')
    await expect(handle.pendingInteractions()).resolves.toEqual([])
    const events = []
    for await (const event of handle.events) events.push(event)
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', conversationId, runId: handle.id, data: 'from worker' })]))
    await expect(handle.outcome()).resolves.toEqual({ status: 'succeeded' })
    expect(await readFile(join(dataDir, 'worker-cleanup-complete.txt'), 'utf8')).toBe('closed')
    await expect(handle.usage()).resolves.toMatchObject({ modelCalls: 1, outputTokens: 2 })
  })

  it('forwards fixed input IDs, attachments and references through the worker RPC', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pulse-worker-input-'))
    temporaryDirectories.push(dataDir)
    const handle = await startH5WorkWorker({ entry: fileURLToPath(new URL('./fixtures/h5-work-worker.mjs', import.meta.url)), dataDir, approvalMode: 'ask' }, { conversationId: 'conv-input-fixture', text: 'work' })
    const options = { requestId: 'fixed-followup-id', attachments: [{ id: 'note', name: 'note.txt', type: 'file' as const, size: 4, mediaType: 'text/plain', data: 'data:text/plain;base64,dGVzdA==' }], skills: ['example'], mentionedFiles: ['src/example.ts'] }
    await handle.submitHumanInput('latest user input', undefined, options)
    expect(JSON.parse(await readFile(join(dataDir, 'worker-human-input.json'), 'utf8'))).toEqual(['latest user input', null, options])
    await handle.outcome()
  })

  it('rejects delivery when a worker reports success but exits with a cleanup failure', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pulse-worker-cleanup-'))
    temporaryDirectories.push(dataDir)
    const handle = await startH5WorkWorker({
      entry: fileURLToPath(new URL('./fixtures/h5-work-worker.mjs', import.meta.url)),
      dataDir,
      approvalMode: 'ask',
    }, { conversationId: 'conv-cleanup-failure', text: 'fail during cleanup' })
    await expect(handle.outcome()).rejects.toThrow('WORKER_EXITED:1')
  })

  it('runs an actual Pulse CLI work session in a separate process using the shared config and data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-worker-cli-'))
    temporaryDirectories.push(dir)
    const configPath = join(dir, 'config.json')
    const entry = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url))
    await access(entry)
    await writeFile(configPath, JSON.stringify({
      providers: { mock: { provider: 'mock', name: 'Mock' } },
      models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } },
      activeModel: 'mock',
      approvalMode: 'ask',
    }))
    const host = createLocalHost({ cwd: dir, dataDir: dir, taskController: false })
    await host.init()
    const conversation = await host.createConversation({ title: 'worker integration', cwd: dir, projectId: 'project-test' })
    try {
      const handle = await startH5WorkWorker({
        entry,
        dataDir: dir,
        configPath,
        approvalMode: 'ask',
        cwd: dir,
        runtimeOptions: host.getWorkWorkerOptions(),
        env: { PULSE_MOCK_RESPONSE: 'worker says hi' },
      }, { conversationId: conversation.id, text: 'Please reply with the configured test response.' })
      const events = []
      for await (const event of handle.events) events.push(event)
      await expect(handle.outcome()).resolves.toMatchObject({ status: 'succeeded' })
      expect(events.some(event => event.type === 'text' && event.data === 'worker says hi')).toBe(true)
      expect((await host.getConversationMessages(conversation.id)).some(message => message.role === 'assistant' && message.text === 'worker says hi')).toBe(true)
    } finally {
      await host.close()
    }
  }, 60_000)

  it('routes a manually created H5 work conversation through the isolated worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-h5-worker-route-'))
    temporaryDirectories.push(dir)
    const entry = fileURLToPath(new URL('./fixtures/h5-work-worker.mjs', import.meta.url))
    const host = createLocalHost({ cwd: dir, dataDir: dir })
    const server = new H5Server(host, {
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      workWorker: { entry, dataDir: dir, approvalMode: 'ask', cwd: dir, startupTimeoutMs: 2_000 },
    })
    await host.init()
    const info = await server.start()
    const base = `http://127.0.0.1:${info.port}`
    try {
      const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
      const cookie = session.headers.get('set-cookie') ?? ''
      const conversation = await host.createConversation({ title: 'manual work', cwd: dir })
      const sent = await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Please complete this small work task.' }),
      })
      expect(sent.status).toBe(200)
      const { runId } = await sent.json() as { runId: string }
      const stream = await fetch(`${base}/api/runs/${runId}/events`, { headers: { Cookie: cookie } }).then(response => response.text())
      const events = stream.split('\n\n').flatMap(block => {
        const line = block.split('\n').find(value => value.startsWith('data: '))
        return line ? [JSON.parse(line.slice(6)) as { type?: string; data?: unknown }] : []
      })
      expect(events.some(event => event.type === 'text' && event.data === 'from worker')).toBe(true)
      expect(events.some(event => event.type === 'complete')).toBe(true)
    } finally {
      await server.stop()
      await host.close()
    }
  })
})

it('preserves attachment, skill, file and request fields through real worker IPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-worker-fields-')); temporaryDirectories.push(dir)
  const entry = join(dir, 'worker.mjs')
  const fixture = await readFile(fileURLToPath(new URL('./fixtures/h5-work-worker.mjs', import.meta.url)), 'utf8')
  await writeFile(entry, fixture.replace("  process.send({ schemaVersion: 1, type: 'started'", "  writeFileSync(join(process.argv[process.argv.indexOf('--data-dir') + 1], 'received.json'), JSON.stringify(message));\n  process.send({ schemaVersion: 1, type: 'started'"))
  const input = { conversationId: 'conv-12345678-1234-1234-1234-123456789abc', text: '', requestId: 'request-worker-fields', attachments: [{ id: 'upload-a', name: 'a.txt', mediaType: 'text/plain', size: 3, type: 'file' as const, url: '/api/example' }], skills: ['grill-and-plan'], mentionedFiles: ['中文/a.ts'] }
  const run = await startH5WorkWorker({ entry, dataDir: dir, approvalMode: 'ask' }, input)
  await run.outcome()
  expect(JSON.parse(await readFile(join(dir, 'received.json'), 'utf8'))).toMatchObject({ ...input, requestId: expect.any(String), messageRequestId: input.requestId })
})
