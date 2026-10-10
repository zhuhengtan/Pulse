import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalHost, JarvisClient, assertJarvisApiUrl, jarvisResultForRun } from '../packages/server/src/index.js'
import { defaultPulseConfig } from '../packages/cli/src/config.js'
import { parse, hostOptions } from '../packages/cli/src/bin.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'

describe('Jarvis 3-tier memory integration', () => {
  describe('JarvisClient unit & resilience tests', () => {
    it('returns undefined and gracefully logs without throwing when Jarvis server is unreachable', async () => {
      const client = new JarvisClient({ apiUrl: 'http://127.0.0.1:59999' }, 200, 200)

      const healthy = await client.isHealthy()
      expect(healthy).toBe(false)

      const session = await client.openSession('/tmp/workspace', 'test task')
      expect(session).toBeUndefined()

      const context = await client.buildContext('sess-1', 'test task')
      expect(context).toBeUndefined()

      await expect(client.recordEvent('sess-1', 'action', 'tool execution')).resolves.toBeUndefined()
      await expect(client.recordCandidate('sess-1', { title: 'Fact', content: 'Details' })).resolves.toBeUndefined()
      await expect(client.closeSession('sess-1', { result: 'success', summary: 'Done' })).resolves.toBeUndefined()
    })

    it('accepts loopback Jarvis URLs and rejects remote endpoints unless explicitly allowed', () => {
      expect(assertJarvisApiUrl('http://127.0.0.1:7330/')).toBe('http://127.0.0.1:7330')
      expect(assertJarvisApiUrl('http://localhost:7330')).toBe('http://localhost:7330')
      expect(assertJarvisApiUrl('http://[::1]:7330')).toBe('http://[::1]:7330')
      expect(() => assertJarvisApiUrl('http://169.254.169.254/latest')).toThrow('JARVIS_REMOTE_URL_DISABLED')
      expect(() => assertJarvisApiUrl('file:///tmp/jarvis')).toThrow('JARVIS_URL_SCHEME_NOT_ALLOWED')
      expect(() => assertJarvisApiUrl('http://user:secret@127.0.0.1:7330')).toThrow('JARVIS_URL_CREDENTIALS_NOT_ALLOWED')
      expect(assertJarvisApiUrl('https://jarvis.example', true)).toBe('https://jarvis.example')
      expect(() => new JarvisClient({ apiUrl: 'http://10.0.0.8:7330' })).toThrow('JARVIS_REMOTE_URL_DISABLED')
      expect(() => new JarvisClient({ apiUrl: 'https://jarvis.example', allowRemote: true })).not.toThrow()
    })

    it('does not record unverified or failed runs as Jarvis success', () => {
      expect(jarvisResultForRun('succeeded', 'accepted')).toBe('success')
      expect(jarvisResultForRun('succeeded', 'incomplete')).toBe('partial')
      expect(jarvisResultForRun('succeeded', 'unverifiable')).toBe('partial')
      expect(jarvisResultForRun('succeeded', 'failed')).toBe('failure')
      expect(jarvisResultForRun('cancelled', 'cancelled')).toBe('failure')
      expect(jarvisResultForRun('failed', undefined)).toBe('failure')
    })

    it('redacts credentials in outbound text and normalizes candidate titles', async () => {
      const bodies: unknown[] = []
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ session: { id: 'safe-session', projectId: 'safe-project', workspace: '/test' }, text: '' }))
      })
      vi.stubGlobal('fetch', fetchMock)
      const text = '{"password":"SYNTHETIC_JSON_CREDENTIAL"}\nAPI_KEY=SYNTHETIC_ENV_CREDENTIAL\nBearer SYNTHETIC_BEARER_CREDENTIAL\nhttps://user:SYNTHETIC_URL_PASSWORD@example.test/?access_token=SYNTHETIC_URL_TOKEN\nSYNTHETIC_CONFIGURED_TOKEN'
      try {
        const client = new JarvisClient({ token: 'SYNTHETIC_CONFIGURED_TOKEN' })
        await client.openSession('/test', text)
        await client.buildContext('safe-session', text)
        await client.recordEvent('safe-session', 'action', text)
        await client.recordCandidate('safe-session', { title: 'Task:\n  First item\r\nSecond item', content: text })
        await client.closeSession('safe-session', { result: 'success', summary: text, decisions: [text], failures: [text], nextSteps: [text] })
        const serialized = JSON.stringify(bodies)
        for (const secret of ['SYNTHETIC_JSON_CREDENTIAL', 'SYNTHETIC_ENV_CREDENTIAL', 'SYNTHETIC_BEARER_CREDENTIAL', 'SYNTHETIC_URL_PASSWORD', 'SYNTHETIC_URL_TOKEN', 'SYNTHETIC_CONFIGURED_TOKEN']) expect(serialized).not.toContain(secret)
        expect(bodies[3]).toMatchObject({ title: 'Task: First item Second item' })
        expect(serialized).toContain('REDACTED')
      } finally { vi.unstubAllGlobals() }
    })

    it('successfully calls Jarvis endpoints when server responds', async () => {
      const calls: Array<{ path: string; body: unknown }> = []
      const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace('http://127.0.0.1:7330', '')
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, body })

        if (path === '/health') {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
        }
        if (path === '/v1/sessions') {
          return new Response(JSON.stringify({ session: { id: 'sess-123', projectId: 'proj-1', workspace: '/test' } }), { status: 200 })
        }
        if (path === '/v1/context/build') {
          return new Response(JSON.stringify({
            text: '# Jarvis Cognitive Context\nActive Goal: Build feature\nRelevant Memory: Project uses TypeScript',
            activeGoal: { id: 'g-1', title: 'Build feature', status: 'active' },
          }), { status: 200 })
        }
        if (path === '/v1/events' || path === '/v1/memory/candidates' || path.startsWith('/v1/sessions/')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = fakeFetch as unknown as typeof fetch
      try {
        const client = new JarvisClient({ apiUrl: 'http://127.0.0.1:7330', token: 'secret-token' })
        expect(await client.isHealthy()).toBe(true)

        const session = await client.openSession('/test', 'build feature')
        expect(session).toEqual({ id: 'sess-123', projectId: 'proj-1', workspace: '/test' })

        const ctx = await client.buildContext('sess-123', 'build feature', 2000)
        expect(ctx?.text).toContain('Active Goal: Build feature')

        await client.recordEvent('sess-123', 'observation', 'output observed')
        await client.recordCandidate('sess-123', { title: 'Rule', content: 'Always verify' })
        await client.closeSession('sess-123', { result: 'success', summary: 'All passed', decisions: ['Use TS'] })

        expect(calls).toHaveLength(6)
        expect(calls[0]!.path).toBe('/health')
        expect(calls[1]!.path).toBe('/v1/sessions')
        expect(calls[2]!.path).toBe('/v1/context/build')
        expect(calls[3]!.path).toBe('/v1/events')
        expect(calls[4]!.path).toBe('/v1/memory/candidates')
        expect(calls[5]!.path).toBe('/v1/sessions/sess-123/close')
        const inits = fakeFetch.mock.calls.map((call) => call[1] as RequestInit | undefined)
        expect(inits.filter((init) => init?.method === 'POST').every((init) => init?.redirect === 'error')).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('Configuration & CLI toggle tests', () => {
    it('defaults jarvis to enabled: false in defaultPulseConfig', () => {
      expect(defaultPulseConfig.jarvis).toEqual({
        enabled: false,
        apiUrl: 'http://127.0.0.1:7330',
        contextTokenBudget: 4000,
        autoCandidate: true,
        allowRemote: false,
      })
    })

    it('parses --jarvis and --no-jarvis CLI flags', () => {
      const parsedWithJarvis = parse(['--jarvis', 'run', 'test task'])
      expect(parsedWithJarvis.options.jarvis).toBe(true)
      expect(parsedWithJarvis.command).toBe('run')
      expect(parsedWithJarvis.positionals).toContain('test task')

      const parsedNoJarvis = parse(['--no-jarvis', 'run', 'test task'])
      expect(parsedNoJarvis.options['no-jarvis']).toBe(true)
      expect(parsedNoJarvis.command).toBe('run')
    })

    it('resolves hostOptions with CLI and env overrides without reading the real home config', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pulse-jarvis-config-'))
      const previous = {
        home: process.env.PULSE_HOME,
        enabled: process.env.PULSE_JARVIS_ENABLED,
        url: process.env.PULSE_JARVIS_API_URL,
        remote: process.env.PULSE_JARVIS_ALLOW_REMOTE,
      }
      process.env.PULSE_HOME = directory
      delete process.env.PULSE_JARVIS_API_URL
      delete process.env.PULSE_JARVIS_ALLOW_REMOTE
      try {
        process.env.PULSE_JARVIS_ENABLED = '1'
        const options = await hostOptions(parse(['--cwd', directory, '--jarvis-budget', '6000']))
        expect(options.jarvis?.enabled).toBe(true)
        expect(options.jarvis?.contextTokenBudget).toBe(6000)
        expect(options.jarvis?.apiUrl).toBe('http://127.0.0.1:7330')
        expect(options.jarvis?.allowRemote).toBe(false)

        const disabledOptions = await hostOptions(parse(['--cwd', directory, '--no-jarvis']))
        expect(disabledOptions.jarvis?.enabled).toBe(false)

        const configPath = join(directory, 'remote.json')
        await writeFile(configPath, `${JSON.stringify({
          providers: { mock: { provider: 'mock' } },
          models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } },
          activeModel: 'mock',
          jarvis: { enabled: true, apiUrl: 'http://169.254.169.254/' },
        })}\n`)
        await expect(hostOptions(parse(['--cwd', directory, '--config', configPath, '--jarvis']))).rejects.toThrow('JARVIS_REMOTE_URL_DISABLED')
        const remote = await hostOptions(parse(['--cwd', directory, '--config', configPath, '--jarvis', '--jarvis-allow-remote']))
        expect(remote.jarvis?.allowRemote).toBe(true)
        expect(remote.jarvis?.apiUrl).toBe('http://169.254.169.254/')
      } finally {
        if (previous.home === undefined) delete process.env.PULSE_HOME
        else process.env.PULSE_HOME = previous.home
        if (previous.enabled === undefined) delete process.env.PULSE_JARVIS_ENABLED
        else process.env.PULSE_JARVIS_ENABLED = previous.enabled
        if (previous.url === undefined) delete process.env.PULSE_JARVIS_API_URL
        else process.env.PULSE_JARVIS_API_URL = previous.url
        if (previous.remote === undefined) delete process.env.PULSE_JARVIS_ALLOW_REMOTE
        else process.env.PULSE_JARVIS_ALLOW_REMOTE = previous.remote
        await rm(directory, { recursive: true, force: true })
      }
    })
  })

  describe('LocalHost 3-tier memory lifecycle', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'pulse-jarvis-test-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('injects Jarvis context into the prompt and closes an unverified run as partial', async () => {
      const recordedEvents: string[] = []
      let openedSession: { workspace: string; task: string } | undefined
      let builtContextFor: string | undefined
      let closedSession: { id: string; result: string; summary: string } | undefined
      let recordedCandidate: { title: string; content: string } | undefined

      const mockClient = {
        async openSession(workspace: string, task: string) {
          openedSession = { workspace, task }
          return { id: 'mock-session-42', projectId: 'proj-42', workspace }
        },
        async buildContext(sessionId: string, task: string) {
          builtContextFor = sessionId
          return {
            text: 'Project: Pulse Architecture\nConstraint: Deterministic scheduler',
          }
        },
        async recordEvent(sessionId: string, type: string, content: string) {
          recordedEvents.push(`${sessionId}:${type}:${content}`)
        },
        async recordCandidate(sessionId: string, candidate: { title: string; content: string }) {
          recordedCandidate = candidate
        },
        async closeSession(sessionId: string, input: { result: string; summary: string }) {
          closedSession = { id: sessionId, result: input.result, summary: input.summary }
        },
      } as unknown as JarvisClient

      const host = createLocalHost({
        cwd: tempDir,
        dataDir: join(tempDir, 'data'),
        jarvis: { enabled: true },
        jarvisClient: mockClient,
        provider: { provider: 'mock' },
        mockResponse: 'Task completed successfully',
      })

      await host.init()

      const conv = await host.createConversation({ cwd: tempDir, title: 'Jarvis Test' })
      const run = await host.sendMessage(conv.id, { text: 'Implement memory bridge' })

      const events: unknown[] = []
      for await (const event of run.events) {
        events.push(event)
      }

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')

      // 1. Tier 1: session was opened and the context entered the system prompt
      expect(openedSession).toBeDefined()
      expect(openedSession?.task).toBe('Implement memory bridge')
      expect(builtContextFor).toBe('mock-session-42')
      const snapshot = await readFile(join(tempDir, 'data', 'conversations', conv.id, 'runs', run.id, 'runtime.json'), 'utf8')
      expect(snapshot).toContain('<jarvis_context>')
      expect(snapshot).toContain('Project: Pulse Architecture')
      expect(snapshot).toContain('untrusted reference data')

      // 2. A run without an accepted task outcome is partial and does not become a candidate
      expect(closedSession).toBeDefined()
      expect(closedSession?.id).toBe('mock-session-42')
      expect(closedSession?.result).toBe('partial')
      expect(recordedCandidate).toBeUndefined()
      expect(recordedEvents).toEqual([])

      await host.close()
    })

    it('waits for tool events before closing the Jarvis session', async () => {
      const order: string[] = []
      let pending = 0
      const mockClient = {
        async openSession(workspace: string) {
          return { id: 'mock-session-events', projectId: 'proj-42', workspace }
        },
        async buildContext() {
          return { text: 'Project context' }
        },
        async recordEvent() {
          pending += 1
          await new Promise((resolve) => setTimeout(resolve, 40))
          pending -= 1
          order.push('event')
        },
        async recordCandidate() {
          order.push('candidate')
        },
        async closeSession() {
          expect(pending).toBe(0)
          order.push('close')
        },
      } as unknown as JarvisClient

      await writeFile(join(tempDir, 'note.txt'), 'hello')
      const host = createLocalHost({
        cwd: tempDir,
        dataDir: join(tempDir, 'data'),
        jarvis: { enabled: true },
        jarvisClient: mockClient,
        provider: { provider: 'mock' },
        approvalMode: 'auto',
        mockToolCalls: [{ name: 'fs.read', input: { path: 'note.txt' } }],
        mockAfterToolResponse: 'read the note',
      })
      await host.init()
      const conv = await host.createConversation({ cwd: tempDir })
      const run = await host.sendMessage(conv.id, { text: 'Read note.txt' })
      for await (const _event of run.events) { /* drain */ }
      expect((await run.outcome()).status).toBe('succeeded')
      expect(order).toEqual(['event', 'close'])
      await host.close()
    })

    it.each(['Say hello.', 'Say hello.\nUse a friendly tone.'])('records a candidate with a single-line title after an accepted task: %s', async (objective) => {
      const order: string[] = []
      let closedResult: string | undefined
      const mockClient = {
        async openSession(workspace: string) {
          return { id: 'mock-session-accepted', projectId: 'proj-42', workspace }
        },
        async buildContext() {
          return { text: 'Accepted context' }
        },
        async recordEvent() {},
        async recordCandidate(_id: string, candidate: { title: string }) {
          expect(candidate.title).not.toMatch(/[\r\n]/)
          expect(candidate.title.length).toBeLessThanOrEqual(200)
          order.push('candidate')
        },
        async closeSession(_id: string, input: { result: string }) {
          closedResult = input.result
          order.push('close')
        },
      } as unknown as JarvisClient

      const host = createLocalHost({
        cwd: tempDir,
        dataDir: join(tempDir, 'data'),
        jarvis: { enabled: true, autoCandidate: true },
        jarvisClient: mockClient,
        provider: { provider: 'mock' },
        mockResponse: 'The requested result is ready.',
        mockTaskAssessments: [{ status: 'accepted', criteria: acceptanceCriteriaFromObjective(objective).map((criterion) => ({ criterionId: criterion.id, status: 'passed', evidenceRefs: ['result-1'], rationale: 'The candidate directly satisfies the simple request.' })) }],
      })
      await host.init()
      const conv = await host.createConversation({ cwd: tempDir })
      const run = await host.sendMessage(conv.id, { text: objective })
      for await (const _event of run.events) { /* drain */ }
      expect((await run.outcome()).status).toBe('succeeded')
      expect(await run.taskOutcome()).toMatchObject({ status: 'accepted' })
      expect(closedResult).toBe('success')
      expect(order).toEqual(['candidate', 'close'])
      await host.close()
    })

    it('records safe tool metadata without consuming the UI stream', async () => {
      const order: string[] = []
      const recorded: Array<Record<string, unknown>> = []
      const client = {
        async openSession(workspace: string) { return { id: 'metadata-session', projectId: 'project', workspace } },
        async buildContext() { return { text: '' } },
        async recordEvent(_id: string, _type: string, content: string) { recorded.push(JSON.parse(content)); order.push('event') },
        async recordCandidate() {},
        async closeSession() { order.push('close') },
      } as unknown as JarvisClient
      const host = createLocalHost({ cwd: tempDir, dataDir: join(tempDir, 'data'), jarvisClient: client, provider: { provider: 'mock' }, approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'private-config.json', content: '{"password":"SYNTHETIC_REVIEW_CREDENTIAL"}' } }], mockAfterToolResponse: 'Fixture written.' })
      try {
        await host.init()
        const conv = await host.createConversation()
        const run = await host.sendMessage(conv.id, { text: 'Write the fixture.' })
        expect((await run.outcome()).status).toBe('succeeded')
        expect(recorded).toEqual([{ tool: 'fs.write', effectId: expect.any(String), toolCallId: expect.any(String), status: 'succeeded' }])
        expect(JSON.stringify(recorded)).not.toMatch(/SYNTHETIC|private-config|password/)
        expect(order).toEqual(['event', 'close'])
      } finally { await host.close() }
    })

    it('finishes one run without waiting for another run\'s Jarvis writes', async () => {
      let release!: () => void
      let started!: () => void
      const slowWrite = new Promise<void>((resolve) => { release = resolve })
      const writeStarted = new Promise<void>((resolve) => { started = resolve })
      const closed: string[] = []
      const client = {
        async openSession(workspace: string, task: string) { return { id: task, projectId: 'project', workspace } },
        async buildContext() { return { text: '' } },
        async recordEvent(id: string) { if (id === 'Slow run') { started(); await slowWrite } },
        async recordCandidate() {},
        async closeSession(id: string) { closed.push(id) },
      } as unknown as JarvisClient
      await writeFile(join(tempDir, 'note.txt'), 'hello')
      const host = createLocalHost({ cwd: tempDir, dataDir: join(tempDir, 'data'), jarvisClient: client, provider: { provider: 'mock' }, approvalMode: 'auto', mockToolCalls: [{ name: 'fs.read', input: { path: 'note.txt' } }], mockAfterToolResponse: 'Read.' })
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await host.init()
        const slowConv = await host.createConversation()
        const slow = await host.sendMessage(slowConv.id, { text: 'Slow run' })
        await writeStarted
        const fastConv = await host.createConversation()
        const fast = await host.sendMessage(fastConv.id, { text: 'Fast run' })
        // The held write is the isolation assertion; allow scheduling headroom
        // when this test runs alongside the complete filesystem-heavy suite.
        const completed = await Promise.race([fast.outcome().then(() => true), new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 5000) })])
        expect(completed).toBe(true)
        expect(closed).toEqual(['Fast run'])
        release()
        await slow.outcome()
        expect(closed).toEqual(['Fast run', 'Slow run'])
      } finally { clearTimeout(deadline); release(); await host.close() }
    })

    it('restores Jarvis context and binding without replaying recorded tool events', async () => {
      const events: Array<{ effectId: string; tool: string }> = []
      const opened = vi.fn(async (workspace: string) => ({ id: 'durable-session', projectId: 'project', workspace }))
      const built = vi.fn(async () => ({ text: 'UNIQUE_JARVIS_CONTEXT_MARKER' }))
      const closed = vi.fn(async () => {})
      const client = { openSession: opened, buildContext: built, async recordEvent(_id: string, _type: string, content: string) { events.push(JSON.parse(content)) }, async recordCandidate() {}, closeSession: closed } as unknown as JarvisClient
      await writeFile(join(tempDir, 'note.txt'), 'hello')
      let modelTurn = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        const call = [
          { name: 'fs.read', arguments: JSON.stringify({ path: 'note.txt' }) },
          { name: 'ask.input', arguments: JSON.stringify({ prompt: 'Continue?' }) },
        ][modelTurn++]
        return new Response(JSON.stringify({ choices: [{ message: call ? { content: '', tool_calls: [{ id: `restore-call-${modelTurn}`, type: 'function', function: call }] } : { content: 'Read.' }, finish_reason: call ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
      }))
      const options = { cwd: tempDir, dataDir: join(tempDir, 'data'), jarvisClient: client, provider: { provider: 'deepseek' as const, defaultModel: 'deepseek-flash' }, taskController: false, approvalMode: 'auto' as const }
      const first = createLocalHost(options)
      let second: ReturnType<typeof createLocalHost> | undefined
      try {
        await first.init()
        const conv = await first.createConversation()
        let run = await first.sendMessage(conv.id, { text: 'Read note.txt and ask before continuing.' })
        let waiting = false
        for await (const event of run.events) if (event.type === 'waiting') { waiting = true; break }
        expect(waiting).toBe(true)
        const bindingPath = join(tempDir, 'data', 'conversations', conv.id, 'runs', run.id, 'jarvis.json')
        await vi.waitFor(async () => expect(JSON.parse(await readFile(bindingPath, 'utf8')).recordedEffectIds).toHaveLength(1))
        const runtime = (first as unknown as { active: Map<string, { runtime: PulseRuntime }> }).active.get(run.id)!.runtime
        // Model process loss while preserving a resumable durable human wait.
        runtime.cancelAgent = () => {}
        await first.close()
        expect(closed).not.toHaveBeenCalled()
        second = createLocalHost(options)
        run = await second.resumeRun(conv.id)
        const restored = (second as unknown as { active: Map<string, { runtime: PulseRuntime }> }).active.get(run.id)!.runtime
        for await (const event of run.events) if (event.type === 'waiting') await run.reply((event.data as { effectId: string }).effectId, { text: 'Continue' })
        expect((await run.outcome()).status).toBe('succeeded')
        const lastModel = [...restored.state.effects.values()].filter((effect) => effect.kind === 'llm').at(-1)
        expect(JSON.stringify(lastModel?.input)).toContain('UNIQUE_JARVIS_CONTEXT_MARKER')
        expect(opened).toHaveBeenCalledTimes(1)
        expect(built).toHaveBeenCalledTimes(1)
        expect(closed).toHaveBeenCalledOnce()
        expect(closed).toHaveBeenCalledWith('durable-session', expect.any(Object))
        expect(events.filter((event) => event.tool === 'fs.read')).toHaveLength(1)
        expect(new Set(events.map((event) => event.effectId)).size).toBe(events.length)
        expect(JSON.parse(await readFile(bindingPath, 'utf8')).closed).toBe(true)
      } finally { await second?.close(); await first.close(); vi.unstubAllGlobals() }
    })

    it('closes the Jarvis session when run setup fails', async () => {
      let closed: { result: string; summary: string } | undefined
      const mockClient = {
        async openSession(workspace: string) {
          return { id: 'mock-session-setup', projectId: 'proj-42', workspace }
        },
        async buildContext() {
          return { text: 'setup context' }
        },
        async recordEvent() {},
        async recordCandidate() {},
        async closeSession(_id: string, input: { result: string; summary: string }) {
          closed = input
        },
      } as unknown as JarvisClient

      const host = createLocalHost({
        cwd: tempDir,
        dataDir: join(tempDir, 'data'),
        jarvis: { enabled: true },
        jarvisClient: mockClient,
        provider: { provider: 'mock' },
        capabilityPacks: [{
          manifest: { id: 'boom', version: '1', kind: 'integration', title: 'Boom', description: 'fails activation' },
          async activate() { throw new Error('BOOM') },
        }],
        enabledCapabilityPacks: ['boom'],
      })
      await host.init()
      const conv = await host.createConversation({ cwd: tempDir })
      await expect(host.sendMessage(conv.id, { text: 'go' })).rejects.toThrow('BOOM')
      expect(closed).toMatchObject({ result: 'failure' })
      await host.close()
    })

    it('degrades gracefully without throwing if jarvis calls fail during execution', async () => {
      const failingClient = {
        async openSession() {
          throw new Error('Connection refused')
        },
        async buildContext() {
          throw new Error('Connection refused')
        },
        async recordEvent() {
          throw new Error('Connection refused')
        },
        async recordCandidate() {
          throw new Error('Connection refused')
        },
        async closeSession() {
          throw new Error('Connection refused')
        },
      } as unknown as JarvisClient

      const host = createLocalHost({
        cwd: tempDir,
        dataDir: join(tempDir, 'data'),
        jarvis: { enabled: true },
        jarvisClient: failingClient,
        provider: { provider: 'mock' },
        mockResponse: 'Standalone fallback execution',
      })

      await host.init()

      const conv = await host.createConversation({ cwd: tempDir })
      const run = await host.sendMessage(conv.id, { text: 'Run safely' })

      for await (const _event of run.events) {
        // drain
      }

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')

      await host.close()
    })
  })
})
