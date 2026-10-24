import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const reply = (message: any, finish_reason?: string) => {
  const msg = typeof message === 'string'
    ? { content: message }
    : (message && (message.tool_calls || message.content !== undefined))
      ? message
      : { content: JSON.stringify(message) }
  return Response.json({
    choices: [
      {
        message: msg,
        finish_reason: finish_reason ?? (msg?.tool_calls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
  })
}

const tool = (name: string, args: object, callId = 'call-1') =>
  reply({
    content: '',
    tool_calls: [{ id: callId, function: { name, arguments: JSON.stringify(args) } }],
  })

describe('Pulse Parallel Lane & Long Task Interruption Deep Tests', () => {
  it('1. Parallel Delivery Chains: forks independent lanes, executes concurrently, joins deliveries and passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-parallel-e2e-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    await mkdir(cwd, { recursive: true })

    const objective = '1. 创建 module-a.ts 并导出 a\n2. 创建 module-b.ts 并导出 b'
    const criteria = acceptanceCriteriaFromObjective(objective)
    const critA = criteria[0]?.id ?? 'criterion-1'
    const critB = criteria[1]?.id ?? 'criterion-2'

    let activeLanes = 0
    let maxOverlappingLanes = 0
    let writtenA = false
    let writtenB = false
    const toolExecutions: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)

      // 1. Planner Step
      if (text.includes('Return only JSON {"tasks":[...]}')) {
        return reply({
          tasks: [
            { id: 'stage-a', kind: 'edit', goal: '创建 module-a.ts', check: 'module-a.ts 存在', dependsOn: [], criterionIds: [critA] },
            { id: 'stage-b', kind: 'edit', goal: '创建 module-b.ts', check: 'module-b.ts 存在', dependsOn: [], criterionIds: [critB] },
          ],
        })
      }

      // 2. Stage Verification
      if (text.includes('Verify ONLY the active taskController stage')) {
        const results = suppliedRequestResults(request.messages)
        const refs = results.map(r => r.id)
        return reply({
          status: 'passed',
          evidenceRefs: refs.length ? refs : ['mock-ref'],
          note: 'Stage check verified',
        })
      }

      // 3. Final Task Verification
      if (text.includes('Independently verify every ORIGINAL')) {
        const results = suppliedRequestResults(request.messages)
        const refs = results.map(r => r.id)
        return reply({
          criteria: [
            { criterionId: critA, status: 'passed', evidenceRefs: refs, rationale: 'module-a.ts created' },
            { criterionId: critB, status: 'passed', evidenceRefs: refs, rationale: 'module-b.ts created' },
          ],
        })
      }

      // 4. Worker turns for stage-a and stage-b
      activeLanes++
      maxOverlappingLanes = Math.max(maxOverlappingLanes, activeLanes)
      const isStageA = text.includes('"id":"stage-a"')
      const isStageB = text.includes('"id":"stage-b"')

      try {
        if (isStageA) {
          if (!writtenA) {
            writtenA = true
            toolExecutions.push('module-a.ts')
            return tool('fs_write', { path: 'module-a.ts', content: 'export const a = 1;\n' }, 'call-a')
          }
          return reply('module-a.ts 创建完成。')
        }
        if (isStageB) {
          if (!writtenB) {
            writtenB = true
            toolExecutions.push('module-b.ts')
            return tool('fs_write', { path: 'module-b.ts', content: 'export const b = 2;\n' }, 'call-b')
          }
          return reply('module-b.ts 创建完成。')
        }
        return reply('Done.')
      } finally {
        activeLanes--
      }
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
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')

      const taskOutcome = await run.taskOutcome()
      expect(taskOutcome?.status).toBe('accepted')
      expect(taskOutcome?.criteria.every(c => c.status === 'passed')).toBe(true)

      // Verify files were actually written to project cwd
      const fileA = await readFile(join(cwd, 'module-a.ts'), 'utf8')
      const fileB = await readFile(join(cwd, 'module-b.ts'), 'utf8')
      expect(fileA).toContain('export const a = 1')
      expect(fileB).toContain('export const b = 2')

      // Verify controller state
      const taskController = JSON.parse(await readFile(join(dataDir, 'conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
      expect(taskController.tasks).toHaveLength(2)
      expect(taskController.tasks[0].status).toBe('passed')
      expect(taskController.tasks[1].status).toBe('passed')
      expect(taskController.tasks[0].delivery).toBeTruthy()
      expect(taskController.tasks[1].delivery).toBeTruthy()
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('2. Mid-flight Interruption and Continuation: preserves completed parallel chain deliveries, resumes pending chain without redundant writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-parallel-interrupt-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    await mkdir(cwd, { recursive: true })

    const objective = '1. 创建 alpha.ts 并导出 alpha\n2. 创建 beta.ts 并导出 beta'
    const criteria = acceptanceCriteriaFromObjective(objective)
    const critA = criteria[0]?.id ?? 'criterion-1'
    const critB = criteria[1]?.id ?? 'criterion-2'

    let run1WrittenA = false
    let run1Cancelled = false
    let betaInFlight = false
    let run2WrittenB = false
    let run2ReadA = false

    const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
    let host = createLocalHost({
      cwd,
      dataDir,
      provider,
      providerProfiles: { fixture: provider },
      providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
      activeModel: 'fixture',
      assistantModel: 'fixture',
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)

      // 1. Planner Step
      if (text.includes('Return only JSON {"tasks":[...]}')) {
        // Resuming after mid-flight interruption: verify existing deliverables, implement pending beta
        if (run1Cancelled) {
          return reply({
            tasks: [
              { id: 'stage-alpha', kind: 'verify', goal: '核验已创建的 alpha.ts', check: 'alpha.ts 导出 alpha', dependsOn: [], criterionIds: [critA] },
              { id: 'stage-beta', kind: 'edit', goal: '创建 beta.ts', check: 'beta.ts 存在', dependsOn: [], criterionIds: [critB] },
            ],
          })
        }
        return reply({
          tasks: [
            { id: 'stage-alpha', kind: 'edit', goal: '创建 alpha.ts', check: 'alpha.ts 存在', dependsOn: [], criterionIds: [critA] },
            { id: 'stage-beta', kind: 'edit', goal: '创建 beta.ts', check: 'beta.ts 存在', dependsOn: [], criterionIds: [critB] },
          ],
        })
      }

      // 2. Stage Verification
      if (text.includes('Verify ONLY the active taskController stage')) {
        const results = suppliedRequestResults(request.messages)
        const refs = results.map(r => r.id)
        return reply({
          status: 'passed',
          evidenceRefs: refs.length ? refs : ['mock-ref'],
          note: 'Stage check verified',
        })
      }

      // 3. Final Task Verification
      if (text.includes('Independently verify every ORIGINAL')) {
        const results = suppliedRequestResults(request.messages)
        const refs = results.map(r => r.id)
        return reply({
          criteria: [
            { criterionId: critA, status: 'passed', evidenceRefs: refs, rationale: 'alpha.ts created' },
            { criterionId: critB, status: 'passed', evidenceRefs: refs, rationale: 'beta.ts created' },
          ],
        })
      }

      // 4. Worker turns
      const isStageAlpha = text.includes('"id":"stage-alpha"')
      const isStageBeta = text.includes('"id":"stage-beta"')

      if (isStageAlpha) {
        if (!run1WrittenA) {
          run1WrittenA = true
          return tool('fs_write', { path: 'alpha.ts', content: 'export const alpha = "A";\n' }, 'call-alpha')
        }
        if (run1Cancelled) {
          if (!run2ReadA) {
            run2ReadA = true
            return tool('fs_read', { path: 'alpha.ts' }, 'call-read-alpha')
          }
          return reply('alpha.ts 经核验已存在且内容正确。')
        }
        return reply('alpha.ts 创建完成。')
      }

      if (isStageBeta) {
        if (!run1Cancelled) {
          // Keep beta in flight until cancellation, independently of disk and
          // runner speed. A timed reply can finish before alpha is checkpointed.
          betaInFlight = true
          const signal = init?.signal
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Run cancelled', 'AbortError'))
            if (signal?.aborted) abort()
            else signal?.addEventListener('abort', abort, { once: true })
          })
        }
        if (!run2WrittenB) {
          run2WrittenB = true
          return tool('fs_write', { path: 'beta.ts', content: 'export const beta = "B";\n' }, 'call-beta')
        }
        return reply('beta.ts 创建完成。')
      }

      return reply('Done.')
    }))

    try {
      const conversation = await host.createConversation()
      const run1 = await host.sendMessage(conversation.id, { text: objective })

      // The verifier request starts before the Host commits its result. Cancel
      // only after the completed stage and its delivery are durably recorded.
      let observed: Record<string, unknown> = {}
      try {
        await expect.poll(async () => {
          try {
            const alphaOnDisk = await readFile(join(cwd, 'alpha.ts'), 'utf8').then(() => true, () => false)
            const snapshot = JSON.parse(await readFile(join(dataDir, 'conversations', conversation.id, 'runs', run1.id, 'runtime.json'), 'utf8')).state.state
            const chains = snapshot.lanes.map(([id, lane]: any) => ({ id, status: lane.status, tasks: lane.context.state?.taskControllerChain?.tasks?.map((task: any) => ({ id: task.id, status: task.status, delivery: Boolean(task.delivery), note: task.note })) }))
            observed = { betaInFlight, run1WrittenA, alphaOnDisk, chains, failures: snapshot.effects.filter(([, effect]: any) => effect.state === 'failed').map(([id, effect]: any) => ({ id, key: effect.key, error: effect.outcome?.error?.code })).slice(-8) }
            return alphaOnDisk && betaInFlight && chains.some((lane: any) => lane.tasks?.some((task: any) => task.id === 'stage-alpha' && task.status === 'passed' && task.delivery))
          } catch (error) {
            observed = { ...observed, betaInFlight, run1WrittenA, readError: String(error).slice(0, 300) }
            return false
          }
        // Preparation includes a real write, verifier and durable checkpoint;
        // its speed does not change the interruption/continuation assertions.
        }, { timeout: 30_000, interval: 30 }).toBe(true)
      } catch (error) {
        throw new Error('PARALLEL_DELIVERY_CHECKPOINT_NOT_READY: ' + JSON.stringify(observed), { cause: error })
      }

      // Cancel Run 1 while beta is in progress
      await run1.cancel('USER_REQUESTED')
      run1Cancelled = true

      const outcome1 = await run1.outcome()
      expect(outcome1.status).toBe('cancelled')

      // Checkpoint and controller state inspection
      const tc1Path = join(dataDir, 'conversations', conversation.id, 'runs', run1.id, 'task-controller.json')
      const tc1 = JSON.parse(await readFile(tc1Path, 'utf8'))
      const alphaStage1 = tc1.tasks.find((t: any) => t.id === 'stage-alpha')
      const betaStage1 = tc1.tasks.find((t: any) => t.id === 'stage-beta')
      expect(alphaStage1?.status).toBe('passed')
      expect(betaStage1?.status).toBe('blocked')
      expect(betaStage1?.note).toContain('RUN_INTERRUPTED')

      // Now close host and restart to simulate cold restart or new run continuation
      await host.close()
      host = createLocalHost({
        cwd,
        dataDir,
        provider,
        providerProfiles: { fixture: provider },
        providerModels: { fixture: { provider: 'fixture', model: 'fixture' } },
        activeModel: 'fixture',
        assistantModel: 'fixture',
        approvalMode: 'auto',
        jarvis: { enabled: false },
      })

      // Send continuation command
      const run2 = await host.sendMessage(conversation.id, { text: '刚才运行在中途被中断了。请先检查工作区里哪些阶段产物已经生成，切勿破坏已完成的文件，继续把剩余未完成的任务全部完成。' })

      const outcome2 = await run2.outcome()
      expect(outcome2.status).toBe('succeeded')

      const taskOutcome2 = await run2.taskOutcome()
      expect(taskOutcome2?.status).toBe('accepted')

      // Ensure alpha.ts was not overwritten/re-written in run 2
      const audit = JSON.parse(await readFile(join(dataDir, 'conversations', conversation.id, 'runs', run2.id, 'operations.json'), 'utf8'))
      expect(audit.operations.filter((operation: any) => operation.tool === 'fs.write' && operation.path === 'alpha.ts')).toHaveLength(0)
      expect(run2WrittenB).toBe(true)

      const fileA = await readFile(join(cwd, 'alpha.ts'), 'utf8')
      const fileB = await readFile(join(cwd, 'beta.ts'), 'utf8')
      expect(fileA).toContain('export const alpha = "A"')
      expect(fileB).toContain('export const beta = "B"')
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('3. Partial Failure in Parallel Lane: retains passed chain deliveries while reporting clear blocker on failing chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-parallel-partial-fail-'))
    const cwd = join(root, 'project')
    const dataDir = join(root, 'data')
    await mkdir(cwd, { recursive: true })

    const objective = '1. 创建 passed.ts\n2. 创建 blocked.ts'
    const criteria = acceptanceCriteriaFromObjective(objective)
    const crit1 = criteria[0]?.id ?? 'criterion-1'
    const crit2 = criteria[1]?.id ?? 'criterion-2'

    let writtenPassed = false

    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const text = currentRequestText(request.messages)

      if (text.includes('Return only JSON {"tasks":[...]}')) {
        return reply({
          tasks: [
            { id: 'stage-passed', kind: 'edit', goal: '创建 passed.ts', check: 'passed.ts 存在', dependsOn: [], criterionIds: [crit1] },
            { id: 'stage-blocked', kind: 'edit', goal: '创建 blocked.ts', check: 'blocked.ts 存在', dependsOn: [], criterionIds: [crit2] },
          ],
        })
      }

      if (text.includes('Verify ONLY the active taskController stage')) {
        const isPassed = text.includes('"id":"stage-passed"')
        const results = suppliedRequestResults(request.messages)
        const refs = results.map(r => r.id)
        if (isPassed) {
          return reply({
            status: 'passed',
            evidenceRefs: refs.length ? refs : ['mock-ref'],
            note: 'passed.ts verified',
          })
        }
        // Stage-blocked fails stage verification
        return reply({
          status: 'blocked',
          correctionKind: 'verify',
          evidenceRefs: [],
          note: 'Blocked: external build permission denied for blocked.ts',
        })
      }

      if (text.includes('Independently verify every ORIGINAL')) {
        const results = suppliedRequestResults(request.messages)
        const refs = results.map(r => r.id)
        return reply({
          criteria: [
            { criterionId: crit1, status: 'passed', evidenceRefs: refs, rationale: 'passed.ts done' },
            { criterionId: crit2, status: 'not_met', evidenceRefs: [], rationale: 'blocked.ts was blocked' },
          ],
        })
      }

      const isStagePassed = text.includes('"id":"stage-passed"')
      const isStageBlocked = text.includes('"id":"stage-blocked"')

      if (isStagePassed) {
        if (!writtenPassed) {
          writtenPassed = true
          return tool('fs_write', { path: 'passed.ts', content: 'export const ok = true;\n' }, 'call-passed')
        }
        return reply('passed.ts done.')
      }

      if (isStageBlocked) {
        return reply('blocked.ts attempted but halted.')
      }

      return reply('Done.')
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
      approvalMode: 'auto',
      jarvis: { enabled: false },
    })

    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: objective })

      const outcome = await run.outcome()
      expect(outcome.status).toBe('succeeded')

      const taskOutcome = await run.taskOutcome()
      expect(taskOutcome?.status).toBe('incomplete')
      expect(taskOutcome?.criteria.find(c => c.criterionId === crit1)?.status).toBe('unverifiable')
      expect(taskOutcome?.criteria.find(c => c.criterionId === crit2)?.status).toBe('unverifiable')

      // Ensure passed file exists
      const passedContent = await readFile(join(cwd, 'passed.ts'), 'utf8')
      expect(passedContent).toContain('export const ok = true')

      // Ensure controller records passed delivery for stage-passed
      const tc = JSON.parse(await readFile(join(dataDir, 'conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
      const passedStage = tc.tasks.find((t: any) => t.id === 'stage-passed')
      const blockedStage = tc.tasks.find((t: any) => t.id === 'stage-blocked')
      expect(passedStage?.status).toBe('passed')
      expect(passedStage?.delivery).toBeTruthy()
      expect(blockedStage?.status).toBe('blocked')
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
