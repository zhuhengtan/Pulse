import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { summarizeShellProcess } from '../packages/server/src/shell-processes.js'
import { initialController } from '../packages/server/src/task-controller/state.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { runShell } from '../packages/adapters/src/tools/shell.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

vi.mock('../packages/adapters/src/tools/shell.js', async original => ({ ...await original<typeof import('../packages/adapters/src/tools/shell.js')>(), runShell: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it.each([0, 1])('waits for the original background check and collects its exit code %s before verification', async exitCode => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-work-shell-settle-'))
  let finish!: () => void, workerCalls = 0, reviews = 0
  vi.mocked(runShell).mockReset().mockImplementation(async (_command, _args, options) => {
    options?.onOutput?.('stdout', Buffer.from('check started\n'))
    await new Promise<void>(resolve => { finish = resolve; options?.signal?.addEventListener('abort', () => resolve(), { once: true }) })
    return { code: exitCode, stdout: 'check finished', stderr: '', timedOut: false, aborted: false, truncated: false }
  })
  const chat = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages), results = suppliedRequestResults(request.messages)
    const refs = results.map(result => result.id)
    if (text.includes("You write Pulse's final user-facing reply")) return chat(exitCode ? 'The existing check failed.' : 'The existing check passed.')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'check', kind: 'verify', goal: 'Run the existing local check', check: 'Wait for the command and inspect its final exit code', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      reviews++
      expect(JSON.stringify(results)).toContain('exited')
      expect(finish).toBeTypeOf('function')
      return chat(JSON.stringify({ status: exitCode ? 'blocked' : 'passed', evidenceRefs: refs, note: exitCode ? 'The check exited with failure.' : 'The check exited successfully.' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: exitCode ? 'unverifiable' : 'passed', evidenceRefs: refs, rationale: 'Observed the final check result.' }] }))
    if (++workerCalls === 1) return chat({ content: '', tool_calls: [{ id: 'start', function: { name: 'shell_start', arguments: JSON.stringify({ command: process.execPath, args: ['--version'] }) } }] })
    return chat('The command has started; inspect its result.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', execPolicy: { rules: [{ pattern: [process.execPath, '--version'], decision: 'allow' }] }, maxModelCalls: 24 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Run the existing local check and report whether it passes.' })
    const dir = join(cwd, 'data/conversations', conversation.id, 'runs', run.id)
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8')).state.state
      expect(saved.effects.some(([, effect]: any) => effect.input?.name === 'shell.poll')).toBe(true)
    }, { timeout: 4000 })
    expect(reviews).toBe(0)
    finish()
    const outcome = await run.outcome()
    expect(reviews).toBeGreaterThan(0)
    expect(reviews).toBeLessThanOrEqual(2)
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: exitCode ? 'incomplete' : 'accepted' })
    expect(vi.mocked(runShell)).toHaveBeenCalledTimes(1)
    expect(outcome.text).not.toContain('Verifier unusable')
    const controller = JSON.parse(await readFile(join(dir, 'task-controller.json'), 'utf8'))
    expect(controller.tasks[0].attempts).toBe(1)
  } finally { finish?.(); await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

it.each(['56', '57'] as const)('retains a background handle across a v%s replan and ignores its superseded running receipt after exit', version => {
  const program = buildTaskControllerProgram({ version, system: 'fixture', toolNames: ['shell.start', 'shell.poll'], approvalMode: 'auto', maxTurns: 24 })
  const controller = initialController(24)
  const current = { id: 'new-check', kind: 'verify' as const, goal: 'Inspect current output', check: 'Read observed output', criterionIds: ['criterion-1'], dependsOn: [], status: 'verifying' as const, attempts: 1, evidenceRefs: [] as string[] }
  controller.activeId = current.id; controller.tasks = [current]
  controller.priorTasks = [{ ...current, id: 'prior-check', status: 'blocked', evidenceRefs: ['result-1'] }]
  const runtime = new PulseRuntime(), { laneId, agentId } = runtime.createAgent({ goal: 'Inspect output', program, initialGlobal: { taskController: JSON.parse(JSON.stringify(controller)) } as any })
  const lane = runtime.state.lanes.get(laneId)!, processId = 'a'.repeat(64)
  lane.resume.step = 'verify-stage'
  const receipt = (index: number, status: string, owner = laneId) => {
    lane.visibleResultRefs?.add(`result-${index}`)
    runtime.state.effects.set(`effect-${index}`, { id: `effect-${index}`, agentId, ownerLaneId: laneId, kind: 'tool', input: { name: index === 1 ? 'shell.start' : 'shell.poll' }, outcome: { status: 'succeeded', resultRef: `result-${index}` } } as any)
    const body = { processId, agentId, laneId: owner, status, offset: 0, nextOffset: 42, output: 'x'.repeat(42) }
    runtime.state.results.set(`result-${index}`, { id: `result-${index}`, privacy: 'public', producer: { kind: 'effect', id: `effect-${index}` }, derivedFrom: [], summary: summarizeShellProcess(body), ...(version === '56' ? { value: body } : {}) } as any)
  }
  receipt(1, 'running')
  const draining = program.step({ lane, state: runtime.state, now: 0 })
  expect(draining.next.step).toBe('shell-settle:collect')
  expect(draining.actions[0]).toMatchObject({ type: 'submit_effects', effects: [{ input: { name: 'shell.poll', arguments: { processId, offset: 42, waitMs: 30000 } } }] })
  receipt(2, 'exited')
  controller.tasks[0]!.evidenceRefs = ['result-2']
  const agent = runtime.state.agents.get(agentId)!
  agent.globalVersions.set(agent.latestGlobalVersion, { taskController: controller } as any)
  expect(program.step({ lane, state: runtime.state, now: 0 }).next.step).not.toBe('shell-settle:collect')
  controller.tasks[0]!.evidenceRefs = []
  receipt(1, 'running', 'foreign-lane')
  expect(program.step({ lane, state: runtime.state, now: 0 }).next.step).not.toBe('shell-settle:collect')
})
