import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '@hunterzhu/pulse-server'
import type { CapabilityPack } from '../packages/server/src/capabilities.js'

async function startSummaryServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'kept the constraint' }, finish_reason: 'stop' }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP_TEST_SERVER_ADDRESS_MISSING')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function storedMessage(id: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({ id, role, text, createdAt: '2026-01-01T00:00:00.000Z' })}\n`
}

describe('local CLI application host', () => {
  it('waits for real tool completion instead of fast-forwarding its timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-clock-host-'))
    let completed = false
    const pack: CapabilityPack = {
      manifest: { id: 'delayed', version: '1', kind: 'integration', title: 'Delayed read', description: 'Test real clock' },
      activate: async () => ({ tools: [defineTool({ name: 'delayed.read', description: 'Read after a real asynchronous delay.', input: z.object({}), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'read', defaultTimeoutMs: 2000,
        execute: async (_input, context) => { await new Promise((resolve) => setTimeout(resolve, 80)); context.signal.throwIfAborted(); completed = true; return { ok: true } },
      })] }),
    }
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), capabilityPacks: [pack], enabledCapabilityPacks: ['delayed'], mockToolCalls: [{ name: 'delayed.read' }], mockAfterToolResponse: 'done', approvalMode: 'auto' })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Read the delayed source' })
      for await (const _event of run.events) { /* consume */ }
      expect((await run.outcome()).status).toBe('succeeded')
      expect(completed).toBe(true)
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('includes denied safety-review attempts in persisted run usage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-safety-usage-'))
    let mainCalls = 0
    let allCalls = 0
    let safetyPrompt = ''
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      allCalls++
      const body = JSON.parse(String(options.body))
      const safety = body.messages.some((message: { content: string }) => message.content.includes('You are the Pulse safety reviewer'))
      if (safety) safetyPrompt = JSON.stringify(body.messages)
      const callTool = !safety && ++mainCalls === 1
      return new Response(JSON.stringify({ choices: [{ message: callTool ? { content: '', tool_calls: [{ id: 'call', function: { name: 'shell_exec', arguments: '{"command":"node","args":["--version"]}' } }] } : { content: safety ? 'DENY' : 'blocked' }, finish_reason: callTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
    }))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', provider: { provider: 'openai', defaultModel: 'test' } })
    try {
      const conversation = await host.createConversation()
      await writeFile(join(directory, 'data', 'conversations', conversation.id, 'messages.jsonl'), JSON.stringify({ id: 'prior-plan', role: 'assistant', text: '1. Add lint. 2. Check Node and pnpm versions before validation.', createdAt: new Date().toISOString() }) + '\n')
      const run = await host.sendMessage(conversation.id, { text: '1、2你帮我加一下' })
      for await (const _event of run.events) { /* consume */ }
      const safetyMessages = JSON.parse(safetyPrompt) as Array<{ role: string; content: string }>
      const safetyUserContent = safetyMessages.find((message) => message.role === 'user')?.content ?? ''
      const requestStart = safetyUserContent.indexOf('): ') + 3
      const requestEnd = safetyUserContent.indexOf('\nTool:', requestStart)
      const safetyRequest = JSON.parse(safetyUserContent.slice(requestStart, requestEnd)) as { workspace: string }
      expect(safetyPrompt).toContain('Check Node and pnpm versions')
      expect(safetyPrompt).toContain('1、2你帮我加一下')
      expect(safetyRequest.workspace).toBe(directory)
      expect(safetyPrompt).toContain('Assistant proposals are context, not authorization')
      expect(allCalls).toBeGreaterThanOrEqual(3)
      expect(await run.usage()).toMatchObject({ inputTokens: allCalls * 10, outputTokens: allCalls * 2, completeness: 'complete' })
      const persisted = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'usage.json'), 'utf8'))
      expect(persisted.inputTokens).toBe(allCalls * 10)
    } finally { vi.unstubAllGlobals(); await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('runs a mock task, projects events, and stores the conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-host-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'local result' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'say hello' })
      const events = []
      for await (const event of run.events) events.push(event)
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'local result' })
      await expect(run.taskOutcome()).resolves.toMatchObject({ status: 'unverifiable', verifier: 'host' })
      expect(events.some((event) => event.type === 'complete')).toBe(true)
      await expect(run.usage()).resolves.toMatchObject({ schemaVersion: 1, inputTokens: null, outputTokens: null, completeness: 'unavailable' })
      const outcomeFile = join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'outcome.json')
      expect(JSON.parse(await readFile(outcomeFile, 'utf8')).usage).toMatchObject({ completeness: 'unavailable' })
      expect(JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'usage.json'), 'utf8'))).toMatchObject({ completeness: 'unavailable' })
      expect(JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'manifest.json'), 'utf8')).activeRunId).toBeUndefined()
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('runs at most three opt-in read-only child lanes, joins their evidence, then continues serially', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-parallel-read-host-'))
    try {
      const host = createLocalHost({
        cwd: directory,
        dataDir: join(directory, 'data'),
        executionMode: 'parallel-read',
        mockResponse: 'Merged result from the main lane.',
        mockParallelPlan: { tasks: [
          { key: 'task-1', goal: 'Read the project overview.', dependsOn: [] },
          { key: 'task-2', goal: 'Read package scripts after the overview.', dependsOn: [{ taskKey: 'task-1', required: false }] },
          { key: 'task-3', goal: 'Read the test layout.', dependsOn: [] },
        ] },
      })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Review the project structure.' })
      const events = []
      for await (const event of run.events) events.push(event)
      const snapshot = await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')
      expect(snapshot).toContain('pulse.read-only-worker')
      expect(snapshot).toContain('parallelRead')
      expect(snapshot).toContain('Read the project overview.')
      expect(snapshot).toContain('Read package scripts after the overview.')
      expect(snapshot).toContain('Read the test layout.')
      expect(events.filter((event) => event.type === 'fact').length).toBeGreaterThan(0)
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('applies one shared model-effect budget across parallel planning, workers, and the main lane', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-parallel-budget-'))
    try {
      const host = createLocalHost({
        cwd: directory,
        dataDir: join(directory, 'data'),
        executionMode: 'parallel-read',
        maxTurns: 1,
        mockParallelPlan: { tasks: [{ key: 'task-1', goal: 'Read the overview.', dependsOn: [] }] },
      })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Inspect the project.' })
      for await (const _event of run.events) { /* drain */ }
      const outcome = await run.outcome()
      expect(outcome.status).toBe('failed')
      expect(JSON.stringify(outcome)).toContain('PARALLEL_MODEL_EFFECT_BUDGET_EXHAUSTED')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('activates only enabled host capability packs and disposes them when a run ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-capability-lifecycle-'))
    try {
      let activations = 0
      let disposals = 0
      const pack: CapabilityPack = {
        manifest: { id: 'fixture', version: '1', kind: 'integration', title: 'Fixture', description: 'Test lifecycle' },
        async activate() { activations++; return { tools: [], instructions: ['Use fixture guidance.'], dispose() { disposals++ } } },
      }
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), capabilityPacks: [pack], enabledCapabilityPacks: ['fixture'], mockResponse: 'finished' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'say hello' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
      expect(activations).toBe(1)
      expect(disposals).toBe(1)
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('records a separately accepted TaskOutcome with versioned task state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-task-accepted-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'The requested result is ready.', mockTaskAssessments: [{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'The candidate directly satisfies the simple request.' }] }] })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Say hello.' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'The requested result is ready.' })
      const taskOutcome = await run.taskOutcome()
      expect(taskOutcome).toMatchObject({ status: 'accepted', verifier: 'llm', replanCount: 0, criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'] }] })
      const runId = run.id
      const runDir = join(directory, 'data', 'conversations', conversation.id, 'runs', runId)
      expect(JSON.parse(await readFile(join(runDir, 'task-outcome.json'), 'utf8'))).toMatchObject({ status: 'accepted' })
      const snapshot = await readFile(join(runDir, 'runtime.json'), 'utf8')
      expect(snapshot).toContain('taskRecord')
      expect(snapshot).toContain('accepted')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not accept a passed criterion when its cited result reference is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-task-unverifiable-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'A result.', mockTaskAssessments: [{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['missing-result-ref'], rationale: 'Looks complete.' }] }] })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Summarize the requested item.' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
      await expect(run.taskOutcome()).resolves.toMatchObject({ status: 'unverifiable', verifier: 'llm', criteria: [{ status: 'unverifiable', evidenceRefs: [] }] })
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps accumulated conversation context within the DSL instruction budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-context-budget-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'context handled' })
      const conversation = await host.createConversation()
      const messagesPath = join(directory, 'data', 'conversations', conversation.id, 'messages.jsonl')
      await writeFile(messagesPath, `${JSON.stringify({ id: 'msg-old', role: 'user', text: '历史内容 '.repeat(2_000), createdAt: new Date(0).toISOString() })}\n`)
      const run = await host.sendMessage(conversation.id, { text: '继续处理' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'context handled' })
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps a long user message in conversation context instead of the DSL instruction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-long-message-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'long message handled' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '用户上下文 '.repeat(1_500) })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'long message handled' })
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('accepts a human message while the main run is active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-human-input-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'main result' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'start the main task' })
      await run.submitHumanInput('please handle this urgently')
      const events = []
      for await (const event of run.events) events.push(event)
      expect(events.some((event) => event.type === 'fact' && event.data && typeof event.data === 'object' && (event.data as Record<string, unknown>).inputId !== undefined)).toBe(true)
      expect(events.some((event) => event.type === 'text' && event.data === 'main result')).toBe(true)
      const messages = await host.getConversationMessages(conversation.id)
      expect(messages.some((message) => message.role === 'assistant' && message.text === 'main result')).toBe(true)
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps read-only mode explicit in the diagnostic surface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-doctor-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'read-only' })
      const doctor = await host.doctor()
      expect(doctor.errors.filter(message => message.startsWith('SHELL_SANDBOX:'))).toEqual([])
      expect(doctor.tools).toContain('fs.read')
      expect(doctor.tools).toContain('shell.exec')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('only exposes web tools when network access is explicitly enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-network-'))
    try {
      const offline = createLocalHost({ cwd: directory, dataDir: join(directory, 'offline') })
      await expect(offline.doctor()).resolves.not.toMatchObject({ tools: expect.arrayContaining(['web.fetch', 'web.search']) })
      await offline.close()
      const online = createLocalHost({ cwd: directory, dataDir: join(directory, 'online'), allowNetwork: true })
      await expect(online.doctor()).resolves.toMatchObject({ tools: expect.arrayContaining(['web.fetch', 'web.search']) })
      await online.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('pauses for a durable tool approval and continues after reply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-approval-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'fs.write', input: { path: 'approved.txt', content: 'approved' } }], mockAfterToolResponse: 'write finished' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'write the file' })
      let replied = false
      for await (const event of run.events) {
        if (event.type !== 'waiting') continue
        const data = event.data as { effectId?: string }
        expect(data.effectId).toEqual(expect.any(String))
        await run.reply(data.effectId!, { approved: true })
        replied = true
      }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'write finished' })
      expect(replied).toBe(true)
      await expect(readFile(join(directory, 'approved.txt'), 'utf8')).resolves.toBe('approved')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('executes an approved write automatically in auto mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-auto-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'auto.txt', content: 'auto' } }], mockAfterToolResponse: 'auto finished' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'write automatically' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'auto finished' })
      await expect(readFile(join(directory, 'auto.txt'), 'utf8')).resolves.toBe('auto')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('pauses for ask.choice and resumes with the selected value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-ask-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'ask.choice', input: { prompt: 'Pick a mode', options: ['safe', 'fast'] } }], mockAfterToolResponse: 'choice received' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'ask me for a mode' })
      let waiting = false
      for await (const event of run.events) {
        if (event.type !== 'waiting') continue
        waiting = true
        const data = event.data as { effectId?: string; input?: { kind?: string; type?: string; options?: Array<{ value?: string }> } }
        expect(data.input).toMatchObject({ kind: 'ask', type: 'choice' })
        expect(data.input?.options).toEqual([{ label: 'safe', value: 'safe' }, { label: 'fast', value: 'fast' }])
        await expect(run.reply(data.effectId!, { value: '' })).rejects.toThrow('ASK_RESPONSE_INVALID:choice')
        await expect(run.reply(data.effectId!, { value: 'unsafe' })).rejects.toThrow('ASK_RESPONSE_INVALID:choice')
        await run.reply(data.effectId!, { value: 'safe' })
      }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'choice received' })
      expect(waiting).toBe(true)
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects an ask prompt that exceeds the tool schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-ask-large-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'ask.choice', input: { prompt: 'x'.repeat(2_001), options: ['safe'] } }], mockAfterToolResponse: 'should not continue' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'ask with a huge prompt' })
      const events = []
      for await (const event of run.events) events.push(event)
      await expect(run.outcome()).resolves.toMatchObject({ status: 'failed' })
      expect(JSON.stringify(events)).toContain('ASK_PROMPT_TOO_LARGE')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('supports exact patching and records an artifact in the conversation index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-patch-'))
    try {
      await writeFile(join(directory, 'note.txt'), 'before\n')
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.apply_patch', input: { path: 'note.txt', find: 'before', replace: 'after' } }], mockAfterToolResponse: 'patched' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'patch the note' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'patched' })
      await expect(readFile(join(directory, 'note.txt'), 'utf8')).resolves.toBe('after\n')
      const content = await readFile(join(directory, 'note.txt'))
      const expectedHash = createHash('sha256').update(content).digest('hex')
      const artifactHost = createLocalHost({ cwd: directory, dataDir: join(directory, 'artifact-data'), approvalMode: 'auto', mockToolCalls: [{ name: 'artifact.record', input: { path: 'note.txt', mediaType: 'text/plain', label: 'note' } }], mockAfterToolResponse: 'recorded' })
      const artifactConversation = await artifactHost.createConversation()
      const artifactRun = await artifactHost.sendMessage(artifactConversation.id, { text: 'record the note' })
      for await (const _event of artifactRun.events) { /* drain */ }
      await expect(artifactRun.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'recorded' })
      await expect(artifactHost.listArtifacts(artifactConversation.id)).resolves.toEqual([expect.objectContaining({ path: 'note.txt', hash: expectedHash, label: 'note', mediaType: 'text/plain' })])
      await host.close(); await artifactHost.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('turns a denied approval into a failed run without applying the write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-deny-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'fs.write', input: { path: 'denied.txt', content: 'nope' } }], mockAfterToolResponse: 'should not run' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'do not write' })
      const events = []
      for await (const event of run.events) {
        events.push(event)
        if (event.type === 'waiting') {
          const data = event.data as { effectId?: string }
          await run.reply(data.effectId!, { approved: false, reason: 'user denied' })
        }
      }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'failed' })
      expect(events.find((event) => event.type === 'complete')?.data).toMatchObject({ status: 'failed', error: { code: expect.any(String), message: expect.any(String) } })
      await expect(readFile(join(directory, 'denied.txt'), 'utf8')).rejects.toThrow()
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('restores an interrupted approval Run from the persisted runtime snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-resume-'))
    try {
      const options = { cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'fs.write', input: { path: 'resumed.txt', content: 'resumed' } }], mockAfterToolResponse: 'resumed finished' }
      const first = createLocalHost(options)
      const conversation = await first.createConversation()
      const interrupted = await first.sendMessage(conversation.id, { text: 'write and pause' })
      for await (const event of interrupted.events) {
        if (event.type === 'waiting') break
      }
      const firstRunId = (await first.getConversation(conversation.id)).summary.activeRunId
      const firstRuntime = (first as unknown as { active: Map<string, { runtime: { flushPersistence: () => Promise<void>; cancelAgent: () => void } }> }).active.get(firstRunId!)?.runtime
      if (!firstRuntime) throw new Error('FIRST_RUNTIME_NOT_FOUND')
      firstRuntime.cancelAgent = () => {}
      await first.close()
      const second = createLocalHost(options)
      const resumed = await second.resumeRun(conversation.id)
      for await (const event of resumed.events) {
        if (event.type !== 'waiting') continue
        const data = event.data as { effectId?: string }
        await resumed.reply(data.effectId!, { approved: true })
      }
      await expect(resumed.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'resumed finished' })
      await expect(readFile(join(directory, 'resumed.txt'), 'utf8')).resolves.toBe('resumed')
      await second.close()
      await first.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a second host while a conversation is owned by another process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-lock-'))
    try {
      const dataDir = join(directory, 'data')
      const first = createLocalHost({ cwd: directory, dataDir, mockResponse: 'first' })
      const second = createLocalHost({ cwd: directory, dataDir, mockResponse: 'second' })
      const conversation = await first.createConversation()
      const firstRun = await first.sendMessage(conversation.id, { text: 'hold the conversation' })
      await expect(second.sendMessage(conversation.id, { text: 'race the conversation' })).rejects.toThrow('CONVERSATION_BUSY')
      await firstRun.cancel('test cleanup')
      for await (const _event of firstRun.events) { /* drain */ }
      await first.close(); await second.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not delete or compact a conversation while another run owns its lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-mutating-lock-'))
    try {
      const dataDir = join(directory, 'data')
      const options = {
        cwd: directory,
        dataDir,
        mockToolCalls: [{ name: 'fs.write', input: { path: 'held.txt', content: 'held' } }],
      }
      const first = createLocalHost(options)
      const second = createLocalHost({ ...options, mockResponse: 'summary' })
      const conversation = await first.createConversation()
      const run = await first.sendMessage(conversation.id, { text: 'hold the conversation' })
      for await (const event of run.events) {
        if (event.type === 'waiting') break
      }

      await expect(second.deleteConversation(conversation.id)).rejects.toThrow('CONVERSATION_BUSY')
      await expect(second.compactConversation(conversation.id)).rejects.toThrow('CONVERSATION_BUSY')

      await run.cancel('test cleanup')
      for await (const _event of run.events) { /* drain */ }
      await run.outcome().catch(() => undefined)
      await first.close()
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses to compact with the mock provider and keeps the transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-compact-'))
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({ cwd: directory, dataDir, mockResponse: 'should not replace history' })
      const conversation = await host.createConversation()
      const messagesPath = join(dataDir, 'conversations', conversation.id, 'messages.jsonl')
      const original = [
        { id: 'msg-1', role: 'user', text: 'first constraint', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'msg-2', role: 'assistant', text: 'middle decision', createdAt: '2026-01-01T00:00:01.000Z' },
        { id: 'msg-3', role: 'user', text: 'latest request', createdAt: '2026-01-01T00:00:02.000Z' },
      ].map((message) => `${JSON.stringify(message)}\n`).join('')
      await writeFile(messagesPath, original)

      await expect(host.compactConversation(conversation.id)).rejects.toThrow('COMPACT_REQUIRES_PROVIDER')
      await expect(readFile(messagesPath, 'utf8')).resolves.toBe(original)
      await host.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('skips corrupt transcript lines and projects settled tool status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-transcript-'))
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({
        cwd: directory,
        dataDir,
        mockToolCalls: [{ name: 'fs.write', input: { path: 'noted.txt', content: 'noted' } }],
        mockAfterToolResponse: 'done',
      })
      const conversation = await host.createConversation()
      const messagesPath = join(dataDir, 'conversations', conversation.id, 'messages.jsonl')
      await writeFile(messagesPath, '{"id":"msg-1","role":"user","text":"keep","createdAt":"2026-01-01T00:00:00.000Z"}\n{not-json}\n{"id":"msg-2","role":"assistant","text":"also","createdAt":"2026-01-01T00:00:01.000Z"}\n')
      await expect(host.getConversationMessages(conversation.id)).resolves.toMatchObject([
        { text: 'keep' },
        { text: 'also' },
      ])

      const run = await host.sendMessage(conversation.id, { text: 'write the note' })
      const observations: Array<Record<string, unknown>> = []
      for await (const event of run.events) {
        if (event.type === 'waiting') {
          const data = event.data as { effectId?: string }
          await run.reply(data.effectId ?? '', { approved: true })
        }
        if (event.type === 'observation' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
          observations.push(event.data as Record<string, unknown>)
        }
      }
      expect(observations.some((observation) => observation.tool === 'fs.write' && observation.status === 'succeeded')).toBe(true)
      await expect(readFile(join(directory, 'noted.txt'), 'utf8')).resolves.toBe('noted')
      await host.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves history intact when the mock provider is over the auto-compact threshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-compact-mock-'))
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({
        cwd: directory,
        dataDir,
        mockResponse: 'still here',
        autoCompactPercent: 1,
        provider: { provider: 'mock', maxContextTokens: 100 },
      })
      const conversation = await host.createConversation()
      const messagesPath = join(dataDir, 'conversations', conversation.id, 'messages.jsonl')
      const original = [
        storedMessage('msg-1', 'user', 'x'.repeat(400)),
        storedMessage('msg-2', 'assistant', 'y'.repeat(400)),
        storedMessage('msg-3', 'user', 'keep'),
      ].join('')
      await writeFile(messagesPath, original)

      const run = await host.sendMessage(conversation.id, { text: 'continue' })
      const notices = []
      for await (const event of run.events) {
        if (event.type === 'notice') notices.push(event)
      }
      const stored = await readFile(messagesPath, 'utf8')
      expect(notices).toEqual([])
      expect(stored).toContain('x'.repeat(400))
      expect(stored).toContain('continue')
      await host.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('auto-compacts at the clamped percent and records the summary in the session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-compact-auto-'))
    const server = await startSummaryServer()
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({
        cwd: directory,
        dataDir,
        autoCompactPercent: 95,
        provider: {
          provider: 'openai-compatible',
          defaultModel: 'loopback-model',
          baseURL: server.url,
          apiKey: 'test-key',
          maxContextTokens: 32_000,
        },
      })
      const conversation = await host.createConversation()
      const messagesPath = join(dataDir, 'conversations', conversation.id, 'messages.jsonl')
      const dropped = `old-${'x'.repeat(58_996)}`
      const kept = `new-${'y'.repeat(58_996)}`
      const measured = Buffer.byteLength([`user: ${dropped}`, `assistant: ${kept}`, 'user: tail'].join('\n\n'))
      expect(measured).toBeGreaterThan(32_000 * 4 * 0.9)
      expect(measured).toBeLessThan(32_000 * 4 * 0.95)
      const original = [
        storedMessage('msg-1', 'user', dropped),
        storedMessage('msg-2', 'assistant', kept),
        storedMessage('msg-3', 'user', 'tail'),
      ].join('')
      await writeFile(messagesPath, original)

      const run = await host.sendMessage(conversation.id, { text: 'continue' })
      const events = []
      for await (const event of run.events) events.push(event)

      expect(events[0]).toMatchObject({
        type: 'notice',
        data: { kind: 'context_compacted', text: expect.stringContaining('已达到 90%') },
      })
      const stored = await host.getConversationMessages(conversation.id)
      expect(stored[0]).toMatchObject({ role: 'system' })
      expect(stored[0]?.text).toContain('已自动压缩')
      expect(stored[0]?.text).toContain('kept the constraint')
      expect(stored.some((message) => message.text === dropped)).toBe(false)
      expect(stored.some((message) => message.text === kept)).toBe(true)
      expect(stored.some((message) => message.text === 'tail')).toBe(true)
      await expect(readFile(`${messagesPath}.bak`, 'utf8')).resolves.toBe(original)
      await host.close()
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('does not compact again when the older transcript is already a summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-compact-once-'))
    let summaryCalls = 0
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        if (Buffer.concat(chunks).toString('utf8').includes('结构化摘要')) summaryCalls += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP_TEST_SERVER_ADDRESS_MISSING')
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({
        cwd: directory,
        dataDir,
        autoCompactPercent: 90,
        provider: { provider: 'openai-compatible', defaultModel: 'loopback-model', baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', maxContextTokens: 8_000 },
      })
      const conversation = await host.createConversation()
      const huge = 'z'.repeat(20_000)
      await writeFile(join(dataDir, 'conversations', conversation.id, 'messages.jsonl'), [
        `${JSON.stringify({ id: 'msg-summary', role: 'system', text: '[历史上下文摘要]\n已自动压缩\nolder facts', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
        storedMessage('msg-kept', 'assistant', huge),
        storedMessage('msg-tail', 'user', huge),
      ].join(''))
      const run = await host.sendMessage(conversation.id, { text: 'continue' })
      const events = []
      for await (const event of run.events) events.push(event)
      expect(events.some((event) => event.type === 'notice')).toBe(false)
      expect(summaryCalls).toBe(0)
      const stored = await host.getConversationMessages(conversation.id)
      expect(stored[0]?.text).toContain('older facts')
      await host.close()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('does not auto-compact below the configured percent and still accepts /compact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-compact-manual-'))
    const server = await startSummaryServer()
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({
        cwd: directory,
        dataDir,
        autoCompactPercent: 90,
        provider: {
          provider: 'openai-compatible',
          defaultModel: 'loopback-model',
          baseURL: server.url,
          apiKey: 'test-key',
          maxContextTokens: 100_000,
        },
      })
      const conversation = await host.createConversation()
      const messagesPath = join(dataDir, 'conversations', conversation.id, 'messages.jsonl')
      const original = [
        storedMessage('msg-1', 'user', 'first constraint'),
        storedMessage('msg-2', 'assistant', 'middle decision'),
        storedMessage('msg-3', 'user', 'latest request'),
      ].join('')
      await writeFile(messagesPath, original)

      const run = await host.sendMessage(conversation.id, { text: 'continue' })
      const notices = []
      for await (const event of run.events) {
        if (event.type === 'notice') notices.push(event)
      }
      expect(notices).toEqual([])
      expect(await readFile(messagesPath, 'utf8')).toContain('first constraint')

      const compacted = await host.compactConversation(conversation.id)
      expect(compacted.text).toBe('kept the constraint')
      const stored = await host.getConversationMessages(conversation.id)
      expect(stored[0]?.text).toContain('手动压缩')
      expect(stored[0]?.text).toContain('kept the constraint')
      await host.close()
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('sizes lane history limits from the model window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-history-budget-'))
    try {
      const dataDir = join(directory, 'data')
      const host = createLocalHost({
        cwd: directory,
        dataDir,
        mockResponse: 'window sized',
        provider: { provider: 'mock', defaultModel: 'mock', maxContextTokens: 256_000, maxOutputTokens: 16_384 },
      })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'hello' })
      for await (const event of run.events) void event
      await run.outcome()
      const snapshot = JSON.parse(await readFile(join(dataDir, 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
      expect(snapshot.state.state.historySoftTokens).toBe(59_904)
      expect(snapshot.state.state.historyHardTokens).toBe(119_808)
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
