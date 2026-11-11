import { readConversationFixture } from './conversation-fixtures.js'
import { describe, expect, it } from 'vitest'
import { ScenarioProcesses, type ScenarioProcessResult } from './cli-scenario-process.js'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cliBinPath = resolve('packages/cli/dist/bin.js')
// Hosted Mac observations: 3–4 cold CLI invocations cost 7–10s;
// the cascade's 15-effect process exceeded 10s under native CI load.
// Provider time was only 162ms locally: this is persisted CLI work, not an API SLA.
// Keep these fixture budgets local, with a deadline for EVERY child. Windows
// keeps its existing 180s native allowance (doctor: 120s), not a global increase.
const childBudget = (cascade = false) => process.platform === 'win32' ? 150_000 : cascade ? 20_000 : 10_000
const scenarioBudget = (children: number, cascade = false) => process.platform === 'win32' ? 180_000 : children * childBudget(cascade) + 5_000

async function persistedRunInputs(dataDir: string): Promise<string> {
  const conversations = await readdir(join(dataDir, 'conversations')).catch(() => [] as string[])
  const texts: string[] = []
  for (const conversation of conversations) {
    const runs = await readdir(join(dataDir, 'conversations', conversation, 'runs')).catch(() => [] as string[])
    for (const run of runs) texts.push(await readFile(join(dataDir, 'conversations', conversation, 'runs', run, 'input.json'), 'utf8').catch(() => ''))
  }
  return texts.join('\n')
}

async function runStates(dataDir: string): Promise<any[]> {
  const states: any[] = []
  for (const conversation of await readdir(join(dataDir, 'conversations'))) {
    for (const run of await readdir(join(dataDir, 'conversations', conversation, 'runs'))) {
      const directory = join(dataDir, 'conversations', conversation, 'runs', run)
      const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')).state.state
      const budget = JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'))
      const task = JSON.parse(await readFile(join(directory, 'task-controller.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error }))
      states.push({ runtime, budget, task, effects: runtime.effects.map((entry: any) => entry[1]) })
    }
  }
  return states
}

async function assertBoundedWork(dataDir: string, modelCalls: number[], toolCalls = 0, humanCalls = 0) {
  const states = await runStates(dataDir)
  expect(states.map(state => state.budget.used).sort((a, b) => a - b)).toEqual([...modelCalls].sort((a, b) => a - b))
  const effects = states.flatMap(state => state.effects)
  expect(effects.filter(effect => effect.kind === 'llm')).toHaveLength(modelCalls.reduce((a, b) => a + b, 0))
  expect(effects.filter(effect => effect.kind === 'tool')).toHaveLength(toolCalls)
  expect(effects.filter(effect => effect.kind === 'human')).toHaveLength(humanCalls)
  expect(effects.every(effect => ['succeeded', 'failed', 'cancelled'].includes(effect.state))).toBe(true)
  console.info('[cli:work] ' + JSON.stringify(states.map(state => ({ calls: state.budget.used, purposes: state.budget.purposes, providerMs: state.budget.metrics?.latencyMs?.total, effects: state.effects.length, recoveries: state.task.recoveryAttempts?.length ?? 0 }))))
  return states
}

function createFixture() {
  const temporaryDirectories: string[] = []
  const processes = new ScenarioProcesses()
  let invocationCount = 0
  let disposed = false
  const pendingDirectories = new Set<Promise<string>>()
  const createDirectory = (prefix: string) => {
    if (disposed) return Promise.reject(new Error('CLI_SCENARIO_DISPOSED'))
    const pending = mkdtemp(join(tmpdir(), prefix)).then(async directory => {
      if (disposed) {
        await rm(directory, { recursive: true, force: true })
        throw new Error('CLI_SCENARIO_DISPOSED')
      }
      temporaryDirectories.push(directory)
      return directory
    })
    pendingDirectories.add(pending)
    void pending.finally(() => pendingDirectories.delete(pending)).catch(() => undefined)
    return pending
  }
function runCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; interruptAfterMs?: number }
): Promise<ScenarioProcessResult> {
  if (disposed) return Promise.reject(new Error('CLI_SCENARIO_DISPOSED'))
  invocationCount++
  const configHome = mkdtempSync(join(tmpdir(), 'pulse-e2e-config-'))
  temporaryDirectories.push(configHome)
  let interrupt: ReturnType<typeof setTimeout> | undefined
  return processes.run(process.execPath, [cliBinPath, ...args], {
    cwd: options?.cwd ?? process.cwd(),
    env: { ...process.env, PULSE_HOME: configHome, PULSE_JARVIS_ENABLED: '0', ...(options?.env ?? {}) },
    input: options?.input,
    timeoutMs: options?.timeout ?? childBudget(),
    onSpawn: child => {
      if (options?.interruptAfterMs !== undefined) interrupt = setTimeout(() => child.kill('SIGINT'), options.interruptAfterMs)
    },
    onClose: result => {
      clearTimeout(interrupt)
      console.info('[cli:phase] ' + JSON.stringify({ command: args[0], ...result, stdout: undefined, stderr: undefined }))
    },
  })
}

  return { createDirectory, runCli, invocations: () => invocationCount, dispose: async () => {
    disposed = true
    const started = performance.now()
    await processes.dispose()
    await Promise.allSettled([...pendingDirectories])
    expect(processes.activeCount).toBe(0)
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })))
    console.info(`[cli:cleanup] elapsed=${Math.round(performance.now() - started)}ms active=${processes.activeCount}`)
  } }
}

function scenario(name: string, run: (fixture: ReturnType<typeof createFixture>) => Promise<void>, timeout: number) {
  it(name, async context => {
    const fixture = createFixture()
    context.onTestFinished(() => fixture.dispose())
    await run(fixture)
  }, timeout)
}

describe('AI CLI scenarios end-to-end tests', () => {
  scenario('Scenario 1: pulse doctor diagnostics check with mock model and json format', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-doctor-')

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
    expect(invocations()).toBe(3)
  }, process.platform === 'win32' ? 120_000 : scenarioBudget(3))

  scenario('Scenario 2: One-shot task execution with text and jsonl outputs', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-run-')
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
    expect(textRes.stdout).toContain('[任务验收通过]')

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
    expect(invocations()).toBe(3)
  }, scenarioBudget(3))

  scenario('Scenario 3: Tool execution safety and permission modes', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-safety-')
    const dataDir = join(directory, 'data')
    const blockedFile = join(directory, 'blocked.txt')
    const allowedFile = join(directory, 'allowed.txt')
    const runMode = async (mode: string, args: string[]) => {
      const started = Date.now()
      console.info(`[cli:safety] ${mode}:start`)
      const result = await runCli(args)
      console.info(`[cli:safety] ${mode}:exit=${result.code} elapsed=${Date.now() - started}ms`)
      return result
    }

    // 1. In approval-mode ask (default without auto-approve), write tool cancels in non-interactive mode
    const askRes = await runMode('ask', [
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
    const autoRes = await runMode('auto', [
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
    const readonlyRes = await runMode('read-only', [
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
    expect(readonlyRes.code).toBe(1)
    expect(readonlyRes.stdout).toContain('[复核暂不可用，已保留工作结果]')
    expect(readonlyRes.stderr).toContain('Read-only mode cannot execute fs.write.')
    await expect(readFile(readonlyFile, 'utf8')).rejects.toThrow()
    expect(invocations()).toBe(3)
    const safetyStates = await assertBoundedWork(dataDir, [1, 3, 3], 2, 1)
    const policyEffects = safetyStates.flatMap(state => state.effects).filter(effect => effect.kind !== 'llm')
    expect(policyEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'human', state: 'cancelled', outcome: expect.objectContaining({ reason: 'INTERACTION_REQUIRED' }) }),
      expect.objectContaining({ kind: 'tool', state: 'succeeded', input: expect.objectContaining({ name: 'fs.write' }) }),
      expect.objectContaining({ kind: 'tool', state: 'failed', outcome: expect.objectContaining({ error: expect.objectContaining({ code: 'READ_ONLY_TOOL_DENIED' }) }) }),
    ]))
  }, scenarioBudget(3))

  scenario('Scenario 4: Sessions listing and resume workflow', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-sessions-')
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
    expect(firstRunEvent).toMatchObject({ status: 'succeeded', taskOutcome: { status: 'accepted' } })
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
    expect(resumeRes.stdout).toContain('[任务验收通过]')

    // 4. Resume without id fails with RESUME_REQUIRES_ID
    const noIdRes = await runCli(['resume', '--data-dir', dataDir, '--cwd', directory])
    expect(noIdRes.code).toBe(1)
    expect(noIdRes.stderr).toContain('RESUME_REQUIRES_ID')
    expect(invocations()).toBe(4)
    await assertBoundedWork(dataDir, [2, 2])
  }, scenarioBudget(4))

  scenario('Scenario 5: Signal handling and graceful cancellation on SIGINT', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-signals-')
    const dataDir = join(directory, 'data')

    // Start a run with a long shell task and send SIGINT to cancel
    const closeResult = await runCli([
      'run',
      'Long running task',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--auto-approve',
      '--mock-tool-calls',
      JSON.stringify([{ name: 'shell.exec', input: { argv: ['node', '-e', 'setTimeout(()=>{}, 4000)'] } }]),
    ], { cwd: directory, interruptAfterMs: 600 })

    // Cancellation should result in code 3 or 130, or SIGINT signal
    const isCancelled = closeResult.code === 3 || closeResult.code === 130 || closeResult.signal === 'SIGINT'
    expect(isCancelled).toBe(true)
    expect(invocations()).toBe(1)
  }, scenarioBudget(1))

  scenario('Scenario 6: Non-TTY interactive guard prevents unhandled Ink crashes', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-nontty-')

    // Running pulse without TTY and without task should output friendly error instead of crashing
    const res = await runCli(['--cwd', directory], {
      input: '', // non-TTY pipe
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('交互模式需要 TTY 终端')
    expect(invocations()).toBe(1)
  }, scenarioBudget(1))

  scenario('Scenario 7: Piped stdin task input supports single and combined tasks', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-stdin-')
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
    expect(pipedOnlyRes.stdout).toContain('[任务验收通过]')

    // 2. A pure single-line explanation is accepted without file evidence
    const explainRes = await runCli([
      'run',
      'Explain this snippet',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'This snippet declares two constants.',
    ], { cwd: directory, input: '' })
    expect(explainRes.code).toBe(0)
    expect(explainRes.stdout).toContain('[任务验收通过]')

    // 3. Positional task plus stdin: both parts reach the persisted run input. The text becomes two
    // acceptance criteria and the default mock assesses only one, so acceptance is correctly not granted.
    const combinedRes = await runCli([
      'run',
      'Explain the piped snippet',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'This snippet declares two constants.',
    ], {
      cwd: directory,
      input: 'const a = 1; const b = 2;\n',
    })
    expect(combinedRes.code).toBe(1)
    expect(combinedRes.stdout).toContain('This snippet declares two constants.')
    expect(combinedRes.stdout).not.toContain('[任务验收通过]')
    const persisted = await persistedRunInputs(dataDir)
    expect(persisted).toContain('Explain the piped snippet')
    expect(persisted).toContain('const a = 1; const b = 2;')

    // 4. Claiming a write without a file receipt cannot pass acceptance
    const claimedRes = await runCli([
      'run',
      'Write the snippet to out.txt',
      '--data-dir',
      dataDir,
      '--cwd',
      directory,
      '--mock-response',
      'Refactored with extra piped context!',
    ], { cwd: directory, input: '' })
    expect(claimedRes.code).toBe(1)
    expect(claimedRes.stdout).toContain('Refactored with extra piped context!')
    expect(claimedRes.stdout).toContain('[复核暂不可用，已保留工作结果]')
    expect(claimedRes.stdout).not.toContain('[任务验收通过]')
    await expect(readFile(join(directory, 'out.txt'), 'utf8')).rejects.toThrow()
    expect(invocations()).toBe(4)
    await assertBoundedWork(dataDir, [2, 2, 2, 2])
  }, process.platform === 'win32' ? 30_000 : scenarioBudget(4))

  scenario('Scenario 8: Staged multi-chunk file operations provide durable writing', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-stage-')
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
    expect(invocations()).toBe(1)
  }, scenarioBudget(1))

  scenario('Scenario 9: Multi-stage complex task with TaskController progress and final review', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-multistage-')
    const dataDir = join(directory, 'data')

    // Text-only mock responses prove writing stages, not filesystem mutations.
    const parallelPlan = {
      tasks: [
        { id: 'stage-1', goal: '起草项目介绍', check: '回复包含项目用途说明', dependsOn: [], criterionIds: ['criterion-1'] },
        { id: 'stage-2', goal: '起草配置说明', check: '回复包含配置建议', dependsOn: ['stage-1'], criterionIds: ['criterion-2'] },
      ],
    }

    const taskAssessments = [
      {
        status: 'accepted',
        criteria: [
          { criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'Project introduction is supplied in the response.' },
          { criterionId: 'criterion-2', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'Configuration guidance is supplied in the response.' },
        ],
      },
    ]

    const stageAssessments = [
      { status: 'passed', evidenceRefs: ['AUTO'], note: '说明文档已给出。' },
      { status: 'passed', evidenceRefs: ['AUTO'], note: '配置说明已给出。' },
    ]

    const multiStageRes = await runCli([
      'run',
      '1. 起草项目介绍\n2. 起草配置说明',
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
      '项目用途：演示多阶段流程。配置建议：使用本地默认配置。',
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
    expect(resultEvent.text).toContain('项目用途：演示多阶段流程。')
    expect(resultEvent.text).not.toMatch(/stage-1|stage-2|criterion-1|逐项验收/)
    expect(invocations()).toBe(1)
  }, scenarioBudget(1))

  scenario('Scenario 10: Multi-stage task checkpointing and continuation across sessions', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-checkpoint-')
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
    expect(firstResult).toMatchObject({ status: 'succeeded', taskOutcome: { status: 'accepted' } })
    const runId = firstResult.runId

    // Find the durable conversation for the checkpoint and resume it.
    const sessionsRes = await runCli(['sessions', '--data-dir', dataDir, '--cwd', directory, '--format', 'jsonl'])
    expect(sessionsRes.code).toBe(0)
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
    expect(resumeResult.taskOutcome.status).toBe('accepted')
    expect(resumeResult.runId).not.toBe(runId)
    expect(resumeResult.text).toContain('后续阶段调度执行成功')
    expect(invocations()).toBe(3)
    await assertBoundedWork(dataDir, [2, 2])
  }, scenarioBudget(3))

  scenario('Scenario 11: Auto context compaction threshold under heavy conversational output', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-compact-')
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
    expect(compactRun.stdout).toContain('[任务验收通过]')
    expect(invocations()).toBe(1)
  }, scenarioBudget(1))

  scenario('Scenario 12: Complex long task with cascade blocker and stage failure isolation', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-cascade-')
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
      '--max-model-calls', '16',
      '--mock-parallel-plan',
      JSON.stringify(parallelPlan),
      '--mock-stage-assessment',
      JSON.stringify(stageAssessments),
      '--mock-response',
      '执行阶段检查中...',
    ], { timeout: childBudget(true) })

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
    const initialBlocked = [...progressNotices].reverse().find((notice: any) => notice.data.tasks.some((task: any) => task.id === 'stage-1' && task.status === 'blocked'))
    expect(initialBlocked).toBeDefined()
    const tasks = initialBlocked.data.tasks
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
    expect(invocations()).toBe(1)
    const [state] = await assertBoundedWork(dataDir, [15])
    expect(state.budget).toMatchObject({ limit: 16, used: 15, purposes: { planning: 10, work: 2, verification: 3 } })
    expect(state.task.recoveryAttempts).toHaveLength(2)
    expect(state.task.recoveryAttempts[0].failures).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DELIVERY_UNMET' })]))
    const original = state.task.priorTasks.filter((task: any) => ['stage-1', 'stage-2'].includes(task.id))
    expect(original).toEqual([
      expect.objectContaining({ id: 'stage-1', status: 'blocked', attempts: 1, modelCalls: 1 }),
      expect.objectContaining({ id: 'stage-2', status: 'blocked', attempts: 0, modelCalls: 0 }),
    ])
    expect(resultEvent.taskOutcome.criteria).toHaveLength(2)
    expect(resultEvent.taskOutcome.criteria.every((criterion: any) => criterion.status !== 'passed')).toBe(true)
  }, scenarioBudget(1, true))

  scenario('Scenario 13: Multi-turn long-lived session lifecycle and conversation transcript persistence', async ({ createDirectory, runCli, invocations }) => {
    const directory = await createDirectory('pulse-e2e-multiturn-')
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
    const messagesContent: string = await readConversationFixture(messagesFile, 'utf8')
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
    const manifest = JSON.parse(await readConversationFixture(manifestFile, 'utf8'))
    expect(manifest.id).toBe(convId)
    expect(manifest.runs.length).toBe(3)
    expect(invocations()).toBe(3)
    await assertBoundedWork(dataDir, [2, 2, 2])
  }, scenarioBudget(3))
})


it('keeps a late case callback bound to its disposed fixture', async () => {
  const previous = createFixture()
  await previous.dispose()
  const next = createFixture()
  try {
    await expect(previous.runCli(['--version'])).rejects.toThrow('CLI_SCENARIO_DISPOSED')
    expect(previous.invocations()).toBe(0)
    expect(next.invocations()).toBe(0)
  } finally { await next.dispose() }
})

it('removes a directory whose creation completes after fixture disposal', async () => {
  const fixture = createFixture()
  const prefix = `pulse-late-fixture-${process.pid}-${Date.now()}-`
  const pending = fixture.createDirectory(prefix)
  const rejected = expect(pending).rejects.toThrow('CLI_SCENARIO_DISPOSED')
  await fixture.dispose()
  await rejected
  expect((await readdir(tmpdir())).filter(name => name.startsWith(prefix))).toEqual([])
})
