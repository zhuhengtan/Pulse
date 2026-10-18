import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'
import { heuristicFastAck, processFrontModel, sanitizeFrontModelResult } from '../packages/server/src/front-model.js'

describe('heuristicFastAck', () => {
  it('returns appropriate instant responses based on user keywords', () => {
    expect(heuristicFastAck('请修复这个 bug')).toContain('排查')
    expect(heuristicFastAck('帮我新建一个登录页面')).toContain('梳理方案')
    expect(heuristicFastAck('解释一下这段代码')).toContain('查看相关代码')
    expect(heuristicFastAck('重构一下数据存储')).toContain('优化')
    expect(heuristicFastAck('你好呀')).toBe('好的，我马上开始处理。')
  })
})

describe('processFrontModel', () => {
  it('uses the original request and clarification question when the user answers with a filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'front-model-dialogue-'))
    const prompts: string[] = []
    const ollama = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const prompt = JSON.parse(body).prompt as string; prompts.push(prompt)
        const answered = prompt.includes('src/login.ts') && prompt.includes('修复登录按钮重复提交的问题') && prompt.includes('要修改哪个文件？')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response: JSON.stringify({ instantResponse: '收到', brief: { intent: '修复重复提交', requirements: answered ? ['修改 src/login.ts'] : [], needsClarification: !answered, clarificationQuestion: '要修改哪个文件？' } }) }))
      })
    })
    await new Promise<void>((resolve, reject) => { ollama.once('error', reject); ollama.listen(0, '127.0.0.1', resolve) })
    const port = (ollama.address() as { port: number }).port
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockResponse: '已处理请求', frontModel: { enabled: true, model: 'fixture', baseURL: `http://127.0.0.1:${port}` } })
    try {
      const conversation = await host.createConversation()
      const first = await host.sendMessage(conversation.id, { text: '修复登录按钮重复提交的问题' })
      expect((await first.outcome()).text).toBe('要修改哪个文件？')
      const second = await host.sendMessage(conversation.id, { text: 'src/login.ts' })
      for await (const _event of second.events) {}
      // A mock answer without a fix is no longer sufficient to accept the
      // original implementation request after its filename clarification.
      expect((await second.taskOutcome())?.status).not.toBe('accepted')
      const record = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', second.id, 'task-record.json'), 'utf8'))
      expect(record.acceptanceCriteria[0].description).toBe('修复登录按钮重复提交的问题')
      expect(prompts[1]).toContain('修复登录按钮重复提交的问题')
      expect(prompts[1]).toContain('要修改哪个文件？')
    } finally {
      await host.close()
      await new Promise<void>((resolve) => ollama.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to heuristic ack when frontModel is not enabled', async () => {
    const res = await processFrontModel('帮我看看这个错误', undefined, { enabled: false })
    expect(res.instantResponse).toContain('排查')
    expect(res.brief).toBeUndefined()
  })

  it('calls Ollama and extracts structured brief and instant response', async () => {
    let request: Record<string, unknown> | undefined
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        request = JSON.parse(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          response: JSON.stringify({
            instantResponse: '收到，我这就帮您分析并修改配置。',
            brief: {
              intent: '修改配置',
              requirements: ['更新端口'],
              profileHints: ['偏好简洁'],
              needsClarification: false,
            },
          }),
        }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const res = await processFrontModel('更新端口为 8080', 'User prefers concise output', {
        enabled: true,
        model: 'test-model',
        baseURL: `http://127.0.0.1:${port}`,
        timeoutMs: 2000,
      })
      expect(res.instantResponse).toBe('收到，我这就帮您分析并修改配置。')
      expect(res.brief?.intent).toBe('修改配置')
      expect(res.brief?.requirements).toEqual(['更新端口'])
      expect(request?.think).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('uses the selected non-Ollama provider model for instant pre-replies', async () => {
    let request: Record<string, any> | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      request = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ instantResponse: '我马上查看。', brief: { intent: '查看问题', requirements: [], profileHints: [], needsClarification: false } }) }, finish_reason: 'stop' }] })
    }) as typeof fetch
    try {
      const result = await processFrontModel('帮我检查问题', undefined, { enabled: true, provider: 'openai-compatible', model: 'same-model', baseURL: 'http://provider.invalid/v1', apiKey: 'fixture-key', timeoutMs: 2_000 })
      expect(result.instantResponse).toBe('我马上查看。')
      expect(request).toMatchObject({ model: 'same-model' })
      expect(request?.messages?.[0]?.content).toContain('帮我检查问题')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('gracefully degrades to heuristic ack when Ollama times out or errors', async () => {
    const res = await processFrontModel('帮我写个脚本', undefined, {
      enabled: true,
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1', // unreachable port
      timeoutMs: 200,
    })
    expect(res.instantResponse).toContain('梳理方案')
    expect(res.brief).toBeUndefined()
  })

  it('drops a brief whose requirements are not a string list', () => {
    const result = sanitizeFrontModelResult({
      instantResponse: '收到',
      brief: { intent: '改配置', requirements: '不是数组', needsClarification: false },
    }, '回退')
    expect(result.instantResponse).toBe('收到')
    expect(result.brief?.requirements).toEqual([])
  })

  it('sanitizes the current-turn Jarvis selection without requiring a non-empty result', () => {
    const selected = sanitizeFrontModelResult({ instantResponse: '收到', brief: { intent: '检查项目约定', needsClarification: false, contextSelection: { refs: ['memory/relevant', 'memory/relevant', 'memory/forged'], summary: '使用项目约定。' } } }, '回退')
    expect(selected.brief?.contextSelection).toEqual({ refs: ['memory/relevant', 'memory/forged'], summary: '使用项目约定。' })
    const empty = sanitizeFrontModelResult({ instantResponse: '收到', brief: { intent: '简单问候', needsClarification: false, contextSelection: { refs: [], summary: '' } } }, '回退')
    expect(empty.brief?.contextSelection).toEqual({ refs: [], summary: '' })
  })

  it('passes only cited Jarvis items to the primary model and persists the selected sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'front-model-jarvis-selection-'))
    let frontPrompt = ''
    const ollama = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        frontPrompt = JSON.parse(body).prompt as string
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response: JSON.stringify({ instantResponse: '收到', brief: { intent: '遵循 Pulse 项目约定', requirements: [], profileHints: [], needsClarification: false, contextSelection: { refs: ['memory/pulse-style'], summary: '项目采用蓝色强调色和独立 packages/web 前端。' } } }) }))
      })
    })
    await new Promise<void>((resolve, reject) => { ollama.once('error', reject); ollama.listen(0, '127.0.0.1', resolve) })
    const port = (ollama.address() as { port: number }).port
    const mockClient = {
      async openSession(workspace: string) { return { id: 'selection-session', projectId: 'pulse', workspace } },
      async buildContext() {
        return {
          text: 'FULL RAW PACKAGE MUST NOT REACH THE PRIMARY MODEL',
          memories: [
            { id: 'pulse-style', scope: 'project', kind: 'constraint', title: 'UI', content: '项目采用蓝色强调色和独立 packages/web 前端。' },
            { id: 'other-project-secret', scope: 'project', kind: 'fact', title: 'Other project', content: 'UNSELECTED OTHER PROJECT DETAIL' },
          ],
          profileDigest: '用户偏好简体中文',
          recentEvents: [{ id: 'irrelevant-event', type: 'result', content: 'UNSELECTED RECENT EVENT' }],
        }
      },
      async recordEvent() {}, async recordCandidate() {}, async closeSession() {},
    }
    const host = createLocalHost({
      cwd: dir, dataDir: join(dir, 'data'), jarvis: { enabled: true }, jarvisClient: mockClient as never,
      provider: { provider: 'mock' }, mockResponse: '已按项目约定处理',
      frontModel: { enabled: true, model: 'selection-fixture', baseURL: `http://127.0.0.1:${port}`, timeoutMs: 2000 },
    })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '调整聊天页样式，遵循项目约定' })
      for await (const _event of run.events) { /* Drain the completed run. */ }
      expect((await run.outcome()).text).toContain('已按项目约定处理')
      expect(frontPrompt).toContain('memory/pulse-style')
      expect(frontPrompt).toContain('UNSELECTED OTHER PROJECT DETAIL')
      const runtime = await readFile(join(dir, 'data', 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')
      expect(runtime).toContain('项目采用蓝色强调色和独立 packages/web 前端。')
      expect(runtime).not.toContain('UNSELECTED OTHER PROJECT DETAIL')
      expect(runtime).not.toContain('UNSELECTED RECENT EVENT')
      expect(runtime).not.toContain('FULL RAW PACKAGE MUST NOT REACH THE PRIMARY MODEL')
      const selection = JSON.parse(await readFile(join(dir, 'data', 'conversations', conversation.id, 'runs', run.id, 'jarvis-context-selection.json'), 'utf8')) as { status: string; refs: string[]; context: string }
      expect(selection).toMatchObject({ status: 'curated', refs: ['memory/pulse-style'] })
      expect(selection.context).toContain('memory/pulse-style')
    } finally {
      await host.close()
      await new Promise<void>(resolve => ollama.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('asks the clarification question without starting the main run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'front-model-clarify-'))
    const ollama = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        response: JSON.stringify({
          instantResponse: '想确认一下',
          brief: {
            intent: '范围不清',
            requirements: [],
            needsClarification: true,
            clarificationQuestion: '你想处理哪一个文件？',
          },
        }),
      }))
    })
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', () => resolve()))
    const address = ollama.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const host = createLocalHost({
      cwd: dir,
      dataDir: dir,
      mockResponse: 'SHOULD_NOT_RUN',
      frontModel: { enabled: true, model: 'test-model', baseURL: `http://127.0.0.1:${port}`, timeoutMs: 2000 },
    })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '帮我改一下' })
      const events: Array<{ type: string; data?: unknown }> = []
      for await (const event of run.events) events.push(event)
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: '你想处理哪一个文件？' })
      expect(events.some((event) => event.type === 'text' && event.data === '你想处理哪一个文件？')).toBe(true)
      expect(events.some((event) => event.type === 'text' && event.data === 'SHOULD_NOT_RUN')).toBe(false)
    } finally {
      await host.close()
      await new Promise<void>((resolve) => ollama.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
