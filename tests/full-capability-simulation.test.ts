import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, type CapabilityPack } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { z } from 'zod'

afterEach(() => {
  vi.unstubAllGlobals()
})

const reply = (message: any, finish_reason?: string) =>
  Response.json({
    choices: [
      {
        message: typeof message === 'string' ? { content: message } : message,
        finish_reason: finish_reason ?? (message?.tool_calls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
  })

const tool = (name: string, args: object, callId = 'call-1') =>
  reply({
    content: '',
    tool_calls: [{ id: callId, function: { name, arguments: JSON.stringify(args) } }],
  })

describe('Pulse Full-Capability Simulation Suite', () => {
  it('1. Assistant Chat mode: performs bounded read-only queries without task controller overhead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-assistant-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    await writeFile(join(root, 'project', 'config.json'), '{"theme":"dark"}', { flag: 'w' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(cwd, { recursive: true })
      await writeFile(join(cwd, 'config.json'), '{"theme":"dark"}')
    })

    const requests: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      if (requests.length === 1) {
        return tool('fs_read', { path: 'config.json' }, 'tool-read-1')
      }
      return reply('配置文件显示当前主题为 dark。')
    }))

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    const host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      assistantModel: 'fixture',
      approvalMode: 'ask',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '请查看 config.json 的配置内容', assistantChat: true })

      const events: any[] = []
      for await (const event of run.events) {
        events.push(event)
      }

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')
      expect(outcome.text).toContain('dark')
      expect(events.some(e => e.type === 'waiting')).toBe(false)

      // Ensure assistant runs do not create task-controller state
      const runDir = join(dataDir, 'conversations', conversation.id, 'runs', run.id)
      const inputMeta = JSON.parse(await readFile(join(runDir, 'input.json'), 'utf8'))
      expect(inputMeta.assistantChat).toBe(true)
      expect(inputMeta.taskController).toBe(false)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('2. Controlled Task mode: generates plan DAG, executes fs.write, performs stage and final acceptance checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-controlled-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwd, { recursive: true })

    const objective = '编写 hello.ts 并导出打招呼函数，验证其存在。'
    const criteriaIds = acceptanceCriteriaFromObjective(objective).map(c => c.id)

    let workTurn = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)
      const refs = suppliedRequestResults(request.messages).map(r => r.id)

      if (text.includes('Create an executable plan')) {
        return reply(JSON.stringify({
          tasks: [
            {
              id: 'write-code',
              kind: 'edit',
              goal: '编写 hello.ts 文件',
              check: '文件已生成且包含 hello 函数',
              criterionIds: criteriaIds,
              dependsOn: [],
            },
          ],
        }))
      }

      if (text.includes('Verify ONLY the active taskController stage')) {
        return reply(JSON.stringify({
          status: 'passed',
          evidenceRefs: refs,
          note: 'Stage verification: hello.ts exists and compiles successfully.',
        }))
      }

      if (text.includes('Independently verify every ORIGINAL')) {
        return reply(JSON.stringify({
          criteria: criteriaIds.map(criterionId => ({
            criterionId,
            status: 'passed',
            evidenceRefs: refs,
            rationale: 'Original objective satisfied completely.',
          })),
        }))
      }

      workTurn++
      if (workTurn === 1) {
        return tool('fs_write', { path: 'hello.ts', content: 'export function hello(): string { return "world"; }\n' }, 'work-1')
      }
      return reply('hello.ts 已生成完成。')
    }))

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    const host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      taskController: true,
      approvalMode: 'auto',
      jarvis: { enabled: false },
      maxModelCalls: 20,
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })

      for await (const _event of run.events) {
        // stream until finish
      }

      const outcome = await run.outcome()
      const taskOutcome = await run.taskOutcome()
      expect(outcome.status).toBe('succeeded')
      expect(taskOutcome?.status).toBe('accepted')

      // Verify file written to disk
      const content = await readFile(join(cwd, 'hello.ts'), 'utf8')
      expect(content).toContain('export function hello()')

      // Checkpoint verification
      const runDir = join(dataDir, 'conversations', conversation.id, 'runs', run.id)
      const checkpoint = JSON.parse(await readFile(join(runDir, 'checkpoint.json'), 'utf8'))
      expect(checkpoint.facts.some((f: any) => f.result?.path === 'hello.ts')).toBe(true)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('3. Capability Pack mode: activates custom pack and invokes namespaced tool within task execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-pack-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwd, { recursive: true })

    const customTool = defineTool({
      name: 'metrics.ping',
      description: 'Ping custom metrics pack',
      input: z.object({ query: z.string() }),
      output: z.object({ status: z.string(), length: z.number() }),
      execute: async (input) => ({ status: 'pong', length: input.query.length }),
    })

    let packActivated = false
    let packDisposed = false
    const samplePack: CapabilityPack = {
      manifest: {
        id: 'metrics',
        version: '1.0.0',
        kind: 'integration',
        title: 'Metrics pack',
        description: 'Custom metrics capability pack',
      },
      activate: async () => {
        packActivated = true
        return {
          tools: [customTool],
          dispose: () => {
            packDisposed = true
          },
        }
      },
    }

    const objective = '运行 metrics ping 测试扩展能力。'
    const criteriaIds = acceptanceCriteriaFromObjective(objective).map(c => c.id)

    let workCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)
      const refs = suppliedRequestResults(request.messages).map(r => r.id)

      if (text.includes('Create an executable plan')) {
        return reply(JSON.stringify({
          tasks: [
            {
              id: 'ping-stage',
              kind: 'analyze',
              goal: '测试 metrics pack',
              check: '获取 ping 响应',
              criterionIds: criteriaIds,
              dependsOn: [],
            },
          ],
        }))
      }

      if (text.includes('Verify ONLY the active taskController stage')) {
        return reply(JSON.stringify({
          status: 'passed',
          evidenceRefs: refs,
          note: 'Metrics ping verified.',
        }))
      }

      if (text.includes('Independently verify every ORIGINAL')) {
        return reply(JSON.stringify({
          criteria: criteriaIds.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Metrics ping succeeded.' })),
        }))
      }

      workCount++
      if (workCount === 1) {
        return tool('metrics_ping', { query: 'pulse-test' }, 'metrics-call-1')
      }
      return reply('Metrics check complete.')
    }))

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    const host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      capabilityPacks: [samplePack],
      enabledCapabilityPacks: ['metrics'],
      taskController: true,
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })

      for await (const _event of run.events) {
        // stream events
      }

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')
      expect(packActivated).toBe(true)
    } finally {
      await host.close()
      expect(packDisposed).toBe(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('4. Human Approval Flow: halts side-effect for approval; verifies both approve and reject branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-approval-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwd, { recursive: true })

    // Branch A: Approved
    {
      let callCount = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return tool('fs_write', { path: 'approved.txt', content: 'secure data' }, 'call-write-1')
        }
        return reply('写入已完成')
      }))

      const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
      const host = createLocalHost({
        cwd,
        dataDir,
        provider,
        providerProfiles: { fixture: provider },
        providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
        activeModel: 'fixture',
        assistantModel: 'fixture',
        taskController: false,
        approvalMode: 'ask',
        jarvis: { enabled: false },
      })

      try {
        const conversation = await host.createConversation()
        const run = await host.sendMessage(conversation.id, { text: '创建 approved.txt' })

        for await (const event of run.events) {
          if (event.type === 'waiting') break
        }

        const pending = await run.pendingInteractions()
        expect(pending.length).toBeGreaterThan(0)
        expect(pending[0]!.kind).toBe('approval')

        const effect = pending[0]!.items[0]!
        // Approve execution
        await run.reply(effect.effectId, { approved: true })

        const outcome = await run.outcome()
        expect(outcome.status).toBe('succeeded')
        expect(await readFile(join(cwd, 'approved.txt'), 'utf8')).toBe('secure data')
      } finally {
        await host.close()
      }
    }

    // Branch B: Rejected
    {
      let callCount = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return tool('fs_write', { path: 'rejected.txt', content: 'should not write' }, 'call-write-2')
        }
        return reply('收到拒绝，已取消写入。')
      }))

      const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
      const host = createLocalHost({
        cwd,
        dataDir,
        provider,
        providerProfiles: { fixture: provider },
        providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
        activeModel: 'fixture',
        assistantModel: 'fixture',
        taskController: false,
        approvalMode: 'ask',
        jarvis: { enabled: false },
      })

      try {
        const conversation = await host.createConversation()
        const run = await host.sendMessage(conversation.id, { text: '创建 rejected.txt' })

        for await (const event of run.events) {
          if (event.type === 'waiting') break
        }

        const pending = await run.pendingInteractions()
        expect(pending.length).toBeGreaterThan(0)
        expect(pending[0]!.kind).toBe('approval')

        const effect = pending[0]!.items[0]!
        // Reject execution
        await run.reply(effect.effectId, { approved: false, reason: '用户拒绝此文件写入' })

        const outcome = await run.outcome()
        // Ensure file was NOT written
        const exists = await readFile(join(cwd, 'rejected.txt'), 'utf8').then(() => true).catch(() => false)
        expect(exists).toBe(false)
        expect(outcome.status).toBe('failed')
        expect(outcome.error?.code).toBe('APPROVAL_DENIED')
        expect(outcome.text).toContain('APPROVAL_DENIED')
      } finally {
        await host.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('5. Ask / Clarification Flow: suspends execution for user choice and resumes cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-ask-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwd, { recursive: true })

    let callCount = 0
    let userChoiceReceived: any = null
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      callCount++
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)

      if (callCount === 1) {
        return tool(
          'ask_choice',
          {
            prompt: '请选择部署目标环境：',
            options: ['staging', 'production'],
          },
          'ask-call-1'
        )
      }

      userChoiceReceived = text
      return reply('已选择目标环境部署完成。')
    }))

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    const host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      assistantModel: 'fixture',
      taskController: false,
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '请帮我部署系统' })

      for await (const event of run.events) {
        if (event.type === 'waiting') break
      }

      const pending = await run.pendingInteractions()
      expect(pending.length).toBeGreaterThan(0)
      expect(pending[0]!.kind).toBe('ask')

      const effect = pending[0]!.items[0]!
      expect((effect.input as any).prompt).toContain('请选择部署目标环境')

      // Reply with choice
      await run.reply(effect.effectId, { value: 'staging' })

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')
      expect(outcome.text).toContain('已选择目标环境部署完成')
      expect(userChoiceReceived).toContain('staging')
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('6. Plan Criterion ID Normalization: fuzzy maps crit-1 or numerical IDs to formal criterion-1 without mismatch error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-crit-norm-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwd, { recursive: true })

    const objective = '编写 readme.md 说明文档'
    const formalCriteriaIds = acceptanceCriteriaFromObjective(objective).map(c => c.id)

    let workTurn = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)
      const refs = suppliedRequestResults(request.messages).map(r => r.id)

      if (text.includes('Create an executable plan')) {
        // Model provides informal ID "crit-1" instead of "criterion-1"
        return reply(JSON.stringify({
          tasks: [
            {
              id: 'write-doc',
              kind: 'edit',
              goal: '编写 readme.md 文件',
              check: 'readme.md 已创建',
              criterionIds: ['crit-1'],
              dependsOn: [],
            },
          ],
        }))
      }

      if (text.includes('Verify ONLY the active taskController stage')) {
        return reply(JSON.stringify({
          status: 'passed',
          evidenceRefs: refs,
          note: 'readme.md verified.',
        }))
      }

      if (text.includes('Independently verify every ORIGINAL')) {
        return reply(JSON.stringify({
          criteria: formalCriteriaIds.map(criterionId => ({
            criterionId,
            status: 'passed',
            evidenceRefs: refs,
            rationale: 'Formal criterion satisfied.',
          })),
        }))
      }

      workTurn++
      if (workTurn === 1) {
        return tool('fs_write', { path: 'readme.md', content: '# Pulse\n' }, 'work-norm-1')
      }
      return reply('readme.md 已完成。')
    }))

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    const host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      taskController: true,
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })

      for await (const _event of run.events) {}

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')
      const taskOutcome = await run.taskOutcome()
      expect(taskOutcome?.status).toBe('accepted')
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('7. Analysis Stage Verification: allows analyze stage without tool runs to pass with empty evidenceRefs via candidateRef', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sim-analyze-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwd, { recursive: true })

    const objective = '调研系统架构并总结方案'
    const formalCriteriaIds = acceptanceCriteriaFromObjective(objective).map(c => c.id)

    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)

      if (text.includes('Create an executable plan')) {
        return reply(JSON.stringify({
          tasks: [
            {
              id: 'analyze-arch',
              kind: 'analyze',
              goal: '调研系统架构并总结方案',
              check: '输出架构方案总结',
              criterionIds: formalCriteriaIds,
              dependsOn: [],
            },
          ],
        }))
      }

      if (text.includes('Verify ONLY the active taskController stage')) {
        // Verifier returns passed with empty evidenceRefs because no tool was run
        return reply(JSON.stringify({
          status: 'passed',
          evidenceRefs: [],
          note: 'Architecture analysis is sound and complete.',
        }))
      }

      if (text.includes('Independently verify every ORIGINAL')) {
        return reply(JSON.stringify({
          criteria: formalCriteriaIds.map(criterionId => ({
            criterionId,
            status: 'passed',
            evidenceRefs: [],
            rationale: 'Analysis requirements satisfied.',
          })),
        }))
      }

      // No tools run; pure text response candidate
      return reply('架构调研总结：Pulse 采用原子事务与分层上下文架构。')
    }))

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    const host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      taskController: true,
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })

      for await (const _event of run.events) {}

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')
      const taskOutcome = await run.taskOutcome()
      expect(taskOutcome?.status).toBe('accepted')
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
