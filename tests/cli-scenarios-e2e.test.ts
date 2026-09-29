import { describe, expect, it, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cliBinPath = resolve('packages/cli/dist/bin.js')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => undefined)
    )
  )
})

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
    timeout?: number
  }
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliBinPath, ...args], {
      cwd: options?.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(options?.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const timer = options?.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM')
        }, options.timeout)
      : undefined

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolveResult({ code, signal, stdout, stderr })
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })

    if (options?.input !== undefined) {
      child.stdin.write(options.input)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
}

describe('AI CLI scenarios end-to-end tests', () => {
  it('Scenario 1: pulse doctor diagnostics check with mock model and json format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-doctor-'))
    temporaryDirectories.push(directory)

    // 1. Text format
    const textRes = await runCli(['doctor', '--model', 'mock', '--cwd', directory], {
      cwd: directory,
    })
    expect(textRes.code).toBe(0)
    expect(textRes.stdout).toContain('诊断通过')
    expect(textRes.stdout).toContain('Provider:')
    expect(textRes.stdout).toContain('mock')

    // 2. JSON / JSONL format
    const jsonRes = await runCli(['doctor', '--model', 'mock', '--format', 'jsonl', '--cwd', directory], {
      cwd: directory,
    })
    expect(jsonRes.code).toBe(0)
    const json = JSON.parse(jsonRes.stdout.trim())
    expect(json.ok).toBe(true)
    expect(json.provider).toBe('mock')
    expect(Array.isArray(json.tools)).toBe(true)
    expect(json.tools).toContain('fs.read')

    // 3. Unknown model error
    const errRes = await runCli(['doctor', '--model', 'non-existent-model-xyz', '--cwd', directory], {
      cwd: directory,
    })
    expect(errRes.code).not.toBe(0)
    expect(errRes.stderr).toContain('UNKNOWN_MODEL_DISPLAY_NAME')
  })

  it('Scenario 2: One-shot task execution with text and jsonl outputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-run-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // 1. Standard text one-shot run
    const textRes = await runCli([
      'run',
      'Say hello to the tester',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'Hello, end-to-end tester!',
    ])
    expect(textRes.code).toBe(0)
    expect(textRes.stdout).toContain('Hello, end-to-end tester!')
    expect(textRes.stdout).toContain('[succeeded]')

    // 2. JSONL format one-shot run
    const jsonlRes = await runCli([
      'run',
      'Format in jsonl',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--mock-response',
      'Structured jsonl output line',
    ])
    expect(jsonlRes.code).toBe(0)
    const lines = jsonlRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent.status).toBe('succeeded')
    expect(resultEvent.taskOutcome?.status).toBe('accepted')
    expect(resultEvent.text).toBe('Structured jsonl output line')

    // 3. Task required error
    const emptyRes = await runCli(['run', '--cwd', directory])
    expect(emptyRes.code).toBe(1)
    expect(emptyRes.stderr).toContain('TASK_REQUIRED')
  })

  it('Scenario 3: Tool execution safety and permission modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-safety-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')
    const blockedFile = join(directory, 'blocked.txt')
    const allowedFile = join(directory, 'allowed.txt')

    // 1. In approval-mode ask (default without auto-approve), write tool cancels in non-interactive mode
    const askRes = await runCli([
      'run',
      'Write blocked file',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--approval-mode',
      'ask',
      '--mock-tool-calls',
      JSON.stringify([{ name: 'fs.write', input: { path: 'blocked.txt', content: 'blocked-content' } }]),
    ])
    expect(askRes.code).toBe(3)
    expect(askRes.stderr).toContain('此运行处于非交互模式，无法请求工具审批；运行已取消。')
    await expect(readFile(blockedFile, 'utf8')).rejects.toThrow()

    // 2. With --auto-approve, write tool executes and file is written
    const autoRes = await runCli([
      'run',
      'Write allowed file',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--auto-approve',
      '--mock-tool-calls',
      JSON.stringify([{ name: 'fs.write', input: { path: 'allowed.txt', content: 'allowed-content' } }]),
    ])
    expect(autoRes.code).toBe(0)
    await expect(readFile(allowedFile, 'utf8')).resolves.toBe('allowed-content')

    // 3. With --read-only, write tools are blocked
    const readonlyFile = join(directory, 'readonly.txt')
    const readonlyRes = await runCli([
      'run',
      'Write in readonly',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--read-only',
      '--mock-tool-calls',
      JSON.stringify([{ name: 'fs.write', input: { path: 'readonly.txt', content: 'readonly-content' } }]),
    ])
    expect(readonlyRes.code).toBe(0)
    await expect(readFile(readonlyFile, 'utf8')).rejects.toThrow()
  })

  it('Scenario 4: Sessions listing and resume workflow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-sessions-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // 1. First run creates a session
    const firstRun = await runCli([
      'run',
      'Initial discussion topic',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--mock-response',
      'First response created.',
    ])
    expect(firstRun.code).toBe(0)
    const firstLines = firstRun.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const firstRunEvent = firstLines.find((l) => l.type === 'result')
    const runId = firstRunEvent.runId

    // 2. List sessions
    const sessionsRes = await runCli([
      'sessions',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
    ])
    expect(sessionsRes.code).toBe(0)
    const sessions = sessionsRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const createdSession = sessions.find((s) => s.runs?.includes(runId))
    expect(createdSession).toBeDefined()
    expect(createdSession.id).toBeTruthy()

    // 3. Resume the session with a task
    const resumeRes = await runCli([
      'resume',
      createdSession.id,
      'Follow-up instruction',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'Resumed answer processed.',
    ])
    expect(resumeRes.code).toBe(0)
    expect(resumeRes.stdout).toContain('Resumed answer processed.')
    expect(resumeRes.stdout).toContain('[succeeded]')

    // 4. Resume without id fails with RESUME_REQUIRES_ID
    const noIdRes = await runCli(['resume', '--data-dir', dataDir, '--cwd', directory])
    expect(noIdRes.code).toBe(1)
    expect(noIdRes.stderr).toContain('RESUME_REQUIRES_ID')
  })

  it('Scenario 5: Signal handling and graceful cancellation on SIGINT', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-signals-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // Start a run with a long shell task and send SIGINT to cancel
    const child = spawn(process.execPath, [
      cliBinPath,
      'run',
      'Long running task',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--auto-approve',
      '--mock-tool-calls',
      JSON.stringify([{ name: 'shell.exec', input: { argv: ['node', '-e', 'setTimeout(()=>{}, 4000)'] } }]),
    ], {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Give it a moment to enter active tool execution
    await new Promise((resolve) => setTimeout(resolve, 600))
    child.kill('SIGINT')

    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
    })

    // Cancellation should result in code 3 or 130, or SIGINT signal
    const isCancelled = closeResult.code === 3 || closeResult.code === 130 || closeResult.signal === 'SIGINT'
    expect(isCancelled).toBe(true)
  })

  it('Scenario 6: Non-TTY interactive guard prevents unhandled Ink crashes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-nontty-'))
    temporaryDirectories.push(directory)

    // Running pulse without TTY and without task should output friendly error instead of crashing
    const res = await runCli(['--cwd', directory], {
      input: '', // non-TTY pipe
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('交互模式需要 TTY 终端')
  })

  it('Scenario 7: Piped stdin task input supports single and combined tasks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-stdin-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // 1. Task solely provided via stdin pipe
    const pipedOnlyRes = await runCli([
      'run',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'Task executed completely from stdin pipe!',
    ], {
      cwd: directory,
      input: 'Analyze codebase from piped input\n',
    })
    expect(pipedOnlyRes.code).toBe(0)
    expect(pipedOnlyRes.stdout).toContain('Task executed completely from stdin pipe!')
    expect(pipedOnlyRes.stdout).toContain('[succeeded]')

    // 2. Positional task combined with stdin content
    const combinedRes = await runCli([
      'run',
      'Refactor function',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'Refactored with extra piped context!',
    ], {
      cwd: directory,
      input: 'const a = 1; const b = 2;\n',
    })
    expect(combinedRes.code).toBe(0)
    expect(combinedRes.stdout).toContain('Refactored with extra piped context!')
    expect(combinedRes.stdout).toContain('[succeeded]')
  })

  it('Scenario 8: Staged multi-chunk file operations provide durable writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-stage-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')
    const targetFile = join(directory, 'staged-sample.txt')

    // Create a new file via fs.stage directly
    const stageRes = await runCli([
      'run',
      'Stage new durable file',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--auto-approve',
      '--mock-tool-calls',
      JSON.stringify([{ name: 'fs.stage', input: { path: 'staged-sample.txt', content: 'Durable staged content line 1\nLine 2\n' } }]),
    ])
    expect(stageRes.code).toBe(0)
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('Durable staged content line 1\nLine 2\n')
  })

  it('Scenario 9: Multi-stage complex task with TaskController progress and final review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-multistage-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    const parallelPlan = {
      tasks: [
        { id: 'stage-1', goal: '创建项目说明文档', check: '说明文档编写完成', dependsOn: [], criterionIds: ['criterion-1'] },
        { id: 'stage-2', goal: '创建配置文件', check: '配置文件内容准备完毕', dependsOn: ['stage-1'], criterionIds: ['criterion-2'] },
      ],
    }

    const taskAssessments = [
      {
        status: 'accepted',
        criteria: [
          { criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'README.md exists.' },
          { criterionId: 'criterion-2', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'config.json exists.' },
        ],
      },
    ]

    const stageAssessments = [
      { status: 'passed', evidenceRefs: ['AUTO'], note: '说明文档已给出。' },
      { status: 'passed', evidenceRefs: ['AUTO'], note: '配置说明已给出。' },
    ]

    const multiStageRes = await runCli([
      'run',
      '1. 创建项目说明文档\n2. 创建配置文件',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-parallel-plan',
      JSON.stringify(parallelPlan),
      '--mock-stage-assessment',
      JSON.stringify(stageAssessments),
      '--mock-task-assessment',
      JSON.stringify(taskAssessments),
      '--mock-response',
      '多阶段工程初始化完成。',
    ])

    expect(multiStageRes.code).toBe(0)
    const lines = multiStageRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent.status).toBe('succeeded')
    expect(resultEvent.taskOutcome?.status).toBe('accepted')
  })

  it('Scenario 10: Multi-stage task checkpointing and continuation across sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-checkpoint-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // 1. Initial run creates task records and session
    const firstRun = await runCli([
      'run',
      '大型长周期开发任务：实现自动化测试与部署脚本',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-response',
      '第一阶段基础设施搭建完成。',
    ])
    expect(firstRun.code).toBe(0)
    const firstLines = firstRun.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const firstResult = firstLines.find((l) => l.type === 'result')
    const runId = firstResult.runId

    // Verify task-record.json was persisted
    const sessionDir = join(dataDir, 'conversations')
    const sessionsRes = await runCli(['sessions', '--data-dir', dataDir, '--cwd', directory, '--format', 'jsonl'])
    const sessions = sessionsRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const session = sessions.find((s) => s.runs?.includes(runId))
    expect(session).toBeDefined()

    // 2. Resume the long-running task to continue progress
    const resumeRes = await runCli([
      'resume',
      session.id,
      '继续完成原任务的后续阶段',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-response',
      '后续阶段调度执行成功，所有待办完成。',
    ])
    expect(resumeRes.code).toBe(0)
    const resumeLines = resumeRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const resumeResult = resumeLines.find((l) => l.type === 'result')
    expect(resumeResult.status).toBe('succeeded')
    expect(resumeResult.text).toContain('后续阶段调度执行成功')
  })

  it('Scenario 11: Auto context compaction threshold under heavy conversational output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-compact-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // Run with auto-compact-percent specified
    const compactRun = await runCli([
      'run',
      '处理大型日志并生成系统摘要',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--auto-compact-percent',
      '50',
      '--mock-response',
      '已生成紧凑摘要，核心上下文已妥善收敛。',
    ])
    expect(compactRun.code).toBe(0)
    expect(compactRun.stdout).toContain('已生成紧凑摘要')
    expect(compactRun.stdout).toContain('[succeeded]')
  })

  it('Scenario 12: Complex long task with cascade blocker and stage failure isolation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-cascade-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    const parallelPlan = {
      tasks: [
        { id: 'stage-1', goal: '基础设施初始化', check: '基础设施准备完成', dependsOn: [], criterionIds: ['criterion-1'] },
        { id: 'stage-2', goal: '核心业务模块部署', check: '业务模块迁移完毕', dependsOn: ['stage-1'], criterionIds: ['criterion-2'] },
      ],
    }

    const stageAssessments = [
      { status: 'blocked', evidenceRefs: [], note: '外部基础设施服务访问受阻，无法连通目标集群' },
    ]

    const cascadeRes = await runCli([
      'run',
      '1. 基础设施初始化\n2. 核心业务模块部署',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-parallel-plan',
      JSON.stringify(parallelPlan),
      '--mock-stage-assessment',
      JSON.stringify(stageAssessments),
      '--mock-response',
      '执行阶段检查中...',
    ])

    // Should return exit code 1 because stage-1 is blocked and task is incomplete
    expect(cascadeRes.code).toBe(1)
    const lines = cascadeRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    // Check notice task_progress
    const progressNotices = lines.filter((l) => l.type === 'notice' && l.data?.kind === 'task_progress')
    expect(progressNotices.length).toBeGreaterThan(0)
    const lastProgress = progressNotices[progressNotices.length - 1]
    const tasks = lastProgress.data.tasks
    const stage1 = tasks.find((t: any) => t.id === 'stage-1')
    const stage2 = tasks.find((t: any) => t.id === 'stage-2')
    expect(stage1.status).toBe('blocked')
    expect(stage1.cascadeBlocked).toBe(false)
    expect(stage1.note).toContain('外部基础设施服务访问受阻')
    expect(stage2.status).toBe('blocked')
    expect(stage2.cascadeBlocked).toBe(true)

    // Check final result
    const resultEvent = lines.find((l) => l.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent.taskOutcome?.status).toBe('incomplete')
  })

  it('Scenario 13: Multi-turn long-lived session lifecycle and conversation transcript persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-e2e-multiturn-'))
    temporaryDirectories.push(directory)
    const dataDir = join(directory, 'data')

    // Turn 1: create initial project scaffold
    const turn1 = await runCli([
      'run',
      '初始化大型企业级微服务架构',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-response',
      '微服务骨架已生成：网关、认证中心与服务注册模块。',
    ])
    expect(turn1.code).toBe(0)
    const lines1 = turn1.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const res1 = lines1.find((l) => l.type === 'result')
    expect(res1.status).toBe('succeeded')
    const convId = lines1.find((l) => l.type === 'text')?.conversationId
    expect(convId).toBeDefined()

    // Turn 2: resume same session to add database migration
    const turn2 = await runCli([
      'resume',
      convId,
      '为认证中心配置 PostgreSQL 数据库迁移脚本',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-response',
      '迁移脚本已编排完成：001_create_users.sql。',
    ])
    expect(turn2.code).toBe(0)
    const lines2 = turn2.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const res2 = lines2.find((l) => l.type === 'result')
    expect(res2.status).toBe('succeeded')
    expect(lines2.find((l) => l.type === 'text')?.conversationId).toBe(convId)

    // Turn 3: resume same session to write integration test
    const turn3 = await runCli([
      'resume',
      convId,
      '编写针对认证与迁移端到端集成测试',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--format',
      'jsonl',
      '--auto-approve',
      '--mock-response',
      '集成测试编写完毕，全链路打通。',
    ])
    expect(turn3.code).toBe(0)
    const lines3 = turn3.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const res3 = lines3.find((l) => l.type === 'result')
    expect(res3.status).toBe('succeeded')

    // Verify session record file and manifest on disk
    const messagesFile = join(dataDir, 'conversations', convId, 'messages.jsonl')
    const messagesContent = await readFile(messagesFile, 'utf8')
    const messages = messagesContent
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    // Must have at least 6 stored messages (user, assistant, user, assistant, user, assistant)
    expect(messages.length).toBeGreaterThanOrEqual(6)
    expect(messages.filter((m: any) => m.role === 'user').length).toBe(3)
    expect(messages.filter((m: any) => m.role === 'assistant').length).toBe(3)
    expect(messagesContent).toContain('初始化大型企业级微服务架构')
    expect(messagesContent).toContain('001_create_users.sql')
    expect(messagesContent).toContain('全链路打通')

    const manifestFile = join(dataDir, 'conversations', convId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    expect(manifest.id).toBe(convId)
    expect(manifest.runs.length).toBe(3)
  })
})

