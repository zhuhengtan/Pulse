import { describe, expect, it, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Real LLM API Integration Test Suite
 *
 * This test suite executes the Pulse CLI against real LLM provider endpoints
 * (OpenAI, DeepSeek, Anthropic, or any OpenAI-compatible provider).
 *
 * How to run:
 *   OPENAI_API_KEY="sk-..." pnpm vitest run tests/live/cli-real-llm.live.test.ts
 *   or
 *   DEEPSEEK_API_KEY="sk-..." pnpm vitest run tests/live/cli-real-llm.live.test.ts
 */

const cliBinPath = resolve('packages/cli/dist/bin.js')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => undefined)
    )
  )
})

interface LiveConfig {
  provider: 'openai' | 'deepseek' | 'anthropic' | 'openai-compatible'
  model: string
  apiKey: string
  baseURL?: string
}

function resolveLiveConfig(): LiveConfig | undefined {
  const preferred = process.env.PULSE_LIVE_PROVIDER
  if (preferred === 'openai' && process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }
  }
  if (process.env.DEEPSEEK_API_KEY && preferred !== 'openai' && preferred !== 'anthropic') {
    return {
      provider: 'deepseek',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    }
  }
  if (process.env.OPENAI_API_KEY && preferred !== 'anthropic') {
    return {
      provider: 'openai',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model: process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-20241022',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    }
  }
  return undefined
}

const liveConfig = resolveLiveConfig()

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function runCli(
  args: string[],
  options?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: string
  }
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliBinPath, ...args], {
      cwd: options?.cwd,
      env: {
        ...process.env,
        ...(options?.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', reject)
    child.on('close', (code, signal) => {
      resolveResult({ code, signal, stdout, stderr })
    })

    if (options?.input !== undefined) {
      child.stdin.write(options.input)
    }
    child.stdin.end()
  })
}

async function setupWorkspaceWithConfig(config: LiveConfig): Promise<{ workspace: string; dataDir: string; configPath: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'pulse-live-workspace-'))
  temporaryDirectories.push(workspace)
  const dataDir = join(workspace, 'data')
  const configPath = join(workspace, 'pulse.config.json')

  const pulseConfig = {
    providers: {
      [config.provider]: {
        provider: config.provider === 'openai' ? 'openai-compatible' : config.provider,
        name: config.provider,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        apiKeyEnv: config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : config.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
        maxContextTokens: 64_000,
      },
    },
    models: {
      [config.model]: {
        displayName: config.model,
        provider: config.provider,
        modelCode: config.model,
        maxContextTokens: 64_000,
      },
    },
    activeModel: config.model,
    dataDir,
    approvalMode: 'auto',
  }

  await writeFile(configPath, JSON.stringify(pulseConfig, null, 2), 'utf8')
  return { workspace, dataDir, configPath }
}

describe.skipIf(!liveConfig)('Pulse CLI Real LLM Integration Suite (Live API)', () => {
  it('Scenario 1: pulse doctor diagnostics against real remote LLM provider', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    const doctorRes = await runCli([
      'doctor',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'json',
    ])

    expect(doctorRes.code).toBe(0)
    const report = JSON.parse(doctorRes.stdout)
    expect(report.ok).toBe(true)
    expect(report.provider).toBe(cfg.provider)
    expect(report.errors).toEqual([])
  }, 45_000)

  it('Scenario 2: Real LLM one-shot reasoning with actual token usage reporting', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    const res = await runCli([
      'run',
      '请准确计算 125 * 8 的乘积数值，只输出最终纯数字结果',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
    ])

    if (res.code !== 0) {
      console.log('STDOUT:', res.stdout)
      console.log('STDERR:', res.stderr)
    }
    expect(res.code).toBe(0)
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent.status).toBe('succeeded')
    // Result should contain the mathematical product 1000
    expect(resultEvent.text).toContain('1000')

    // Real API returns nonzero token consumption
    expect(resultEvent.usage?.inputTokens).toBeGreaterThan(0)
    expect(resultEvent.usage?.outputTokens).toBeGreaterThan(0)
    expect(resultEvent.usage?.modelCalls).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('Scenario 3: Real LLM autonomous tool calling and filesystem creation loop', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    const res = await runCli([
      'run',
      '请在当前工作目录下创建文件 note.txt，写入内容：Hello Pulse Real API，然后读取它确认内容。',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
    ])

    if (res.code !== 0) {
      console.log('STDOUT:', res.stdout)
      console.log('STDERR:', res.stderr)
    }
    expect(res.code).toBe(0)
    const noteFilePath = join(workspace, 'note.txt')
    const fileContent = await readFile(noteFilePath, 'utf8')
    expect(fileContent).toContain('Hello Pulse Real API')

    const lines = res.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent.status).toBe('succeeded')
  }, 90_000)

  it('Scenario 4: Real LLM multi-turn session persistence and memory recall', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    // Turn 1: Teach model a secret token
    const turn1 = await runCli([
      'run',
      '请记下一个专属安全口令代码：PULSE_REAL_TOKEN_9988，无需执行其他操作，仅回复已记住。',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
    ])
    if (turn1.code !== 0) {
      console.log('STDOUT:', turn1.stdout)
      console.log('STDERR:', turn1.stderr)
    }
    expect(turn1.code).toBe(0)
    const lines1 = turn1.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const convId = lines1.find((l) => l.type === 'text')?.conversationId
    expect(convId).toBeDefined()

    // Turn 2: Resume the conversation and ask model to recall the secret token
    const turn2 = await runCli([
      'resume',
      convId,
      '请问我刚才让你记住的专属安全口令代码是什么？',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
    ])
    if (turn2.code !== 0) {
      console.log('STDOUT:', turn2.stdout)
      console.log('STDERR:', turn2.stderr)
    }
    expect(turn2.code).toBe(0)
    const lines2 = turn2.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const resultEvent = lines2.find((l) => l.type === 'result')
    expect(resultEvent.status).toBe('succeeded')
    expect(resultEvent.text).toContain('PULSE_REAL_TOKEN_9988')
  }, 120_000)

  it('Scenario 5: Real LLM multi-stage DAG task execution with taskController', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    const res = await runCli([
      'run',
      '1. 在当前目录创建 app.config.json 文件写入 {"appName":"PulseApp","version":"1.0.0"}\n2. 校验该配置文件确保是合法 JSON',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
      '--task-controller',
    ])

    if (res.code !== 0) {
      console.log('STDOUT:', res.stdout)
      console.log('STDERR:', res.stderr)
    }
    expect(res.code).toBe(0)
    const configContent = await readFile(join(workspace, 'app.config.json'), 'utf8')
    const parsedJson = JSON.parse(configContent)
    expect(parsedJson.appName).toBe('PulseApp')

    const lines = res.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent.status).toBe('succeeded')
    expect(resultEvent.taskOutcome?.status).toBe('accepted')
  }, 150_000)

  it('Scenario 6: Massive multi-file system architecture & autonomous test verification loop', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    const prompt = [
      '请完成一个完整的任务调度与事件系统开发：',
      '1. 创建 src/event-bus.js：实现带有 on(event, fn), emit(event, ...args), off(event, fn) 的事件总线类。',
      '2. 创建 src/task-queue.js：基于 EventBus 实现支持并发限制 concurrency 的异步任务队列 TaskQueue，提供 add(taskFn) 与 runAll() 方法。',
      '3. 创建 test/runner.js：使用 Node.js 原生 assert 编写针对上述两模块的简明自动化测试（直接通过 assert 验证 EventBus 监听触发与 TaskQueue 任务并发执行，不要引入任何未定义变量或外部测试库），运行成功时打印 "ALL TESTS PASSED"。',
      '4. 调用 shell 命令执行 node test/runner.js，验证测试全部通过。',
      '5. 测试通过后请给出最终完成说明并结束任务。',
    ].join('\n')

    const res = await runCli([
      'run',
      prompt,
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
      '--no-task-controller',
    ])

    if (res.code !== 0) {
      console.log('STDOUT:', res.stdout)
      console.log('STDERR:', res.stderr)
    }
    expect(res.code).toBe(0)
    // Verify files created on disk
    const eventBusContent = await readFile(join(workspace, 'src/event-bus.js'), 'utf8')
    const queueContent = await readFile(join(workspace, 'src/task-queue.js'), 'utf8')
    const testRunnerContent = await readFile(join(workspace, 'test/runner.js'), 'utf8')

    expect(eventBusContent.length).toBeGreaterThan(50)
    expect(queueContent.length).toBeGreaterThan(50)
    expect(testRunnerContent.length).toBeGreaterThan(50)

    const lines = res.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent.status).toBe('succeeded')
    expect(resultEvent.usage?.modelCalls).toBeGreaterThanOrEqual(3)
  }, 240_000)

  it('Scenario 7: Continuous 4-turn software evolution lifecycle across resumed sessions', async () => {
    const cfg = liveConfig!
    const { workspace, dataDir, configPath } = await setupWorkspaceWithConfig(cfg)

    // Turn 1: Core KV Store Engine
    const turn1 = await runCli([
      'run',
      '第一阶段架构构建：在工作区创建 kv-store.js，实现一个内存键值存储类 KVStore，支持 set(key, value, ttlSeconds) 与 get(key) 操作并处理过期失效，并调用 node 命令验证 set/get 基础功能。',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
      '--no-task-controller',
    ])
    if (turn1.code !== 0) {
      console.log('STDOUT:', turn1.stdout)
      console.log('STDERR:', turn1.stderr)
    }
    expect(turn1.code).toBe(0)
    const lines1 = turn1.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const convId = lines1.find((l) => l.type === 'text')?.conversationId
    expect(convId).toBeDefined()
    expect(await readFile(join(workspace, 'kv-store.js'), 'utf8')).toContain('set')

    // Turn 2: Feature Extension - Query & Export
    const turn2 = await runCli([
      'resume',
      convId,
      '第二阶段功能迭代：直接修改 kv-store.js 文件，增加 keys(prefix) 前缀检索方法，以及 dump() 返回当前所有未过期键值对象的方法。当前无需编写或运行测试。',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
      '--no-task-controller',
    ])
    if (turn2.code !== 0) {
      console.log('STDOUT:', turn2.stdout)
      console.log('STDERR:', turn2.stderr)
    }
    expect(turn2.code).toBe(0)
    const storeUpdated = await readFile(join(workspace, 'kv-store.js'), 'utf8')
    expect(storeUpdated).toContain('dump')

    // Turn 3: Verification Script & Execution
    const turn3 = await runCli([
      'resume',
      convId,
      '第三阶段自测演练：编写 verify-kv.js 脚本测试 set, get, keys, dump 方法，并执行 node verify-kv.js 运行自测，确保终端输出 VERIFIED。',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
      '--no-task-controller',
    ])
    if (turn3.code !== 0) {
      console.log('STDOUT:', turn3.stdout)
      console.log('STDERR:', turn3.stderr)
    }
    expect(turn3.code).toBe(0)
    expect(await readFile(join(workspace, 'verify-kv.js'), 'utf8')).toBeDefined()

    // Turn 4: Documentation & Delivery
    const turn4 = await runCli([
      'resume',
      convId,
      '第四阶段工程交付：在工作区生成 README.md，包含 KVStore 的设计架构、核心 API 说明、以及前述阶段的测试执行情况。',
      '--config',
      configPath,
      '--data-dir',
      dataDir,
      '--cwd',
      workspace,
      '--format',
      'jsonl',
      '--auto-approve',
      '--no-task-controller',
    ])
    if (turn4.code !== 0) {
      console.log('STDOUT:', turn4.stdout)
      console.log('STDERR:', turn4.stderr)
    }
    expect(turn4.code).toBe(0)
    const readmeContent = await readFile(join(workspace, 'README.md'), 'utf8')
    expect(readmeContent).toContain('KVStore')

    // Verify session persistence has all 8 dialogue turns (4 user + 4 assistant)
    const messagesFile = join(dataDir, 'conversations', convId, 'messages.jsonl')
    const messages = (await readFile(messagesFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(messages.filter((m: any) => m.role === 'user').length).toBe(4)
    expect(messages.filter((m: any) => m.role === 'assistant').length).toBe(4)
  }, 360_000)
})
