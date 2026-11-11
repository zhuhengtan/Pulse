import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { summarizeShellProcess } from '../packages/server/src/shell-processes.js'
import { initialController } from '../packages/server/src/task-controller/state.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { resolveShellIdentity, runShell } from '../packages/adapters/src/tools/shell.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

vi.mock('../packages/adapters/src/tools/shell.js', async original => ({ ...await original<typeof import('../packages/adapters/src/tools/shell.js')>(), runShell: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it.each([0, 1])('waits for the original background check and collects its exit code %s before verification', async exitCode => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-work-shell-settle-'))
  // windows-launch-delay-repro.log: delaying only the 3rd ExecPolicyHost.authorize
  // by 2500ms reproduces finish is not a function. That call is inside executeShell
  // after ShellProcesses has persisted the running intent, so shell.poll can be
  // submitted before this mock is entered. Delaying the 2nd authorize does not.
  // A Windows path mismatch is unproven; this uses the passing canonical node rule.
  const identity = await resolveShellIdentity('node', ['--version'], cwd)
  let finish: (() => void) | undefined, entered = false, workerCalls = 0, reviews = 0
  vi.mocked(runShell).mockReset().mockImplementation(async (command, args, options) => {
    entered = true
    expect(command).toBe('node')
    expect(args).toEqual(['--version'])
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
    if (++workerCalls === 1) return chat({ content: '', tool_calls: [{ id: 'start', function: { name: 'shell_start', arguments: JSON.stringify({ command: 'node', args: ['--version'] }) } }] })
    return chat('The command has started; inspect its result.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 256000 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', execPolicy: { rules: [{ pattern: [identity.path, '--version'], decision: 'allow' }] }, maxModelCalls: 24 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Run the existing local check and report whether it passes.' })
    const dir = join(cwd, 'data/conversations', conversation.id, 'runs', run.id)
    const runtimeState = async () => JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8')).state.state
    await vi.waitFor(async () => {
      const saved = await runtimeState()
      expect(saved.effects.some(([, effect]: any) => effect.input?.name === 'shell.poll')).toBe(true)
      expect(entered).toBe(true)
      expect(vi.mocked(runShell)).toHaveBeenCalledTimes(1)
      expect(finish).toBeTypeOf('function')
    }, { timeout: 8000 })
    expect(reviews).toBe(0)
    finish!()
    const outcome = await run.outcome()
    const settled = await runtimeState()
    const pollIds = new Set(settled.effects.filter(([, effect]: any) => effect.input?.name === 'shell.poll').map(([id]: [string]) => id))
    const receipt = settled.results.map(([, result]: any) => result).find((result: any) => pollIds.has(result.effectId) && result.summary?.status === 'exited')
    expect(receipt?.summary).toMatchObject({ status: 'exited', code: exitCode })
    expect(reviews).toBeGreaterThan(0)
    expect(reviews).toBeLessThanOrEqual(24)
    expect((await run.taskOutcome())?.status === 'accepted', outcome.text).toBe(exitCode === 0)
    expect(vi.mocked(runShell)).toHaveBeenCalledTimes(1)
    expect(outcome.text).not.toContain('Verifier unusable')
    const controller = JSON.parse(await readFile(join(dir, 'task-controller.json'), 'utf8'))
    expect(controller.tasks[0].attempts).toBe(1)
  } finally { finish?.(); await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 30_000)

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

it('bounds background waiting and applies the current settlement policy to obsolete labels', () => {
  const program = buildTaskControllerProgram({ version: '57', system: 'fixture', toolNames: ['shell.start', 'shell.poll'], approvalMode: 'auto', maxTurns: 24 })
  const controller = initialController(24)
  const current = { id: 'check', kind: 'verify' as const, goal: 'Inspect current output', check: 'Read observed output', criterionIds: ['criterion-1'], dependsOn: [], status: 'verifying' as const, attempts: 1, evidenceRefs: ['result-1'] }
  controller.activeId = current.id
  controller.tasks = [current]
  const runtime = new PulseRuntime(), { laneId, agentId } = runtime.createAgent({ goal: 'Inspect output', program, initialGlobal: { taskController: JSON.parse(JSON.stringify(controller)) } as any })
  const lane = runtime.state.lanes.get(laneId)!, processId = 'b'.repeat(64)
  lane.resume.step = 'verify-stage'
  lane.resume.locals = { shellSettleRound: 2, shellSettleNext: 'verify-stage' }
  const body = { processId, agentId, laneId, status: 'running', offset: 0, nextOffset: 8, output: 'still running' }
  lane.visibleResultRefs?.add('result-1')
  runtime.state.effects.set('effect-1', { id: 'effect-1', agentId, ownerLaneId: laneId, kind: 'tool', input: { name: 'shell.start' }, outcome: { status: 'succeeded', resultRef: 'result-1' } } as any)
  runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', producer: { kind: 'effect', id: 'effect-1' }, derivedFrom: [], summary: summarizeShellProcess(body), value: body } as any)
  const agent = runtime.state.agents.get(agentId)!
  agent.globalVersions.set(agent.latestGlobalVersion, { taskController: JSON.parse(JSON.stringify(controller)) } as any)
  const stopped = program.step({ lane, state: runtime.state, now: 0 })
  expect(stopped.actions).toEqual([])
  expect(stopped.next.step).toBe('dispatch')
  const saved = (stopped.contextDelta?.ops ?? []).filter((item: { op?: string; path?: string[] }) => item.op === 'set' && item.path?.[0] === 'taskController').at(-1) as { value?: { tasks: Array<{ status: string; note?: string; evidenceRefs: string[] }> } } | undefined
  expect(saved?.value?.tasks[0]?.status).toBe('blocked')
  expect(saved?.value?.tasks[0]?.note).toContain('SHELL_STILL_RUNNING')
  expect(saved?.value?.tasks[0]?.evidenceRefs).toContain('result-1')
  const legacy = buildTaskControllerProgram({ version: '55', system: 'fixture', toolNames: ['shell.start', 'shell.poll'], approvalMode: 'auto', maxTurns: 24 })
  const legacyRuntime = new PulseRuntime(), created = legacyRuntime.createAgent({ goal: 'Inspect output', program: legacy, initialGlobal: { taskController: JSON.parse(JSON.stringify(controller)) } as any })
  const legacyLane = legacyRuntime.state.lanes.get(created.laneId)!
  legacyLane.resume.step = 'verify-stage'
  legacyLane.visibleResultRefs?.add('result-1')
  legacyRuntime.state.effects.set('effect-1', runtime.state.effects.get('effect-1')!)
  legacyRuntime.state.results.set('result-1', runtime.state.results.get('result-1')!)
  legacyRuntime.state.agents.get(created.agentId)!.globalVersions.set(legacyRuntime.state.agents.get(created.agentId)!.latestGlobalVersion, { taskController: JSON.parse(JSON.stringify(controller)) } as any)
  expect(legacy.step({ lane: legacyLane, state: legacyRuntime.state, now: 0 }).next.step).toBe('shell-settle:collect')
})
