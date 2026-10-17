import { expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it('runs independent ready stages in a connected dependency graph concurrently before fan-in', async () => {
  const objective = 'Implement independent modules in parallel, then integrate them.'
  let agentId = '', overlapping = 0, integratedAfterBoth = false
  const turns = new Map<string, number>(), started = new Set<string>(), active = new Set<string>()
  let release!: () => void
  const both = new Promise<void>(resolve => { release = resolve })
  const timer = setTimeout(release, 1500)
  const program = buildTaskControllerProgram({ system: 'fixture', version: '18', approvalMode: 'auto', maxTurns: 36, toolNames: ['fs.read', 'fs.write'], readOnlyToolNames: ['fs.read'], modelBudgetView: () => ({ limit: 36, used: 0, workAllowed: true, verificationAllowed: true, finalAllowed: true }) })
  const state = (): any => { const a = runtime.state.agents.get(agentId)!; return (a.globalVersions.get(a.latestGlobalVersion) as any).taskController }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') {
      const args = (effect.input as any).arguments
      return { value: { path: args.path, hash: 'hash-' + args.path, changed: true, content: 'original input' } }
    }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [
      { id: 'inspect', kind: 'verify', goal: 'Read input.mjs', check: 'Input inspected', dependsOn: [], criterionIds: ['c1'] },
      { id: 'a', kind: 'edit', goal: 'Create module-a.mjs', check: 'Module saved', dependsOn: ['inspect'], criterionIds: ['c2'] },
      { id: 'b', kind: 'edit', goal: 'Create module-b.mjs', check: 'Module saved', dependsOn: ['inspect'], criterionIds: ['c3'] },
      { id: 'join', kind: 'edit', goal: 'Create registry.mjs', check: 'Integration saved', dependsOn: ['a', 'b'], criterionIds: ['c4'] },
    ] } }
    const current = state()
    if (effect.key?.startsWith('verify-stage')) {
      const active = current.tasks.find((t: any) => t.id === current.activeId)
      return { value: { status: 'passed', evidenceRefs: active.evidenceRefs, note: 'Current tool evidence checked' } }
    }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: ['c1', 'c2', 'c3', 'c4'].map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: current.tasks.flatMap((t: any) => t.evidenceRefs), rationale: 'Dependency-gated integration checked' })) } }
    const lane = runtime.state.lanes.get(effect.ownerLaneId)!
    const id = (lane.resume.locals as any).taskControllerTaskId as string
    const turn = (turns.get(id) ?? 0) + 1
    turns.set(id, turn)
    if (turn > 1) return { value: { text: 'Done.', finishReason: 'stop' } }
    if (id === 'a' || id === 'b') {
      started.add(id)
      active.add(id)
      overlapping = Math.max(overlapping, active.size)
      if (started.size === 2) { clearTimeout(timer); release() }
      await both
      active.delete(id)
    }
    if (id === 'join') integratedAfterBoth = current.tasks.filter((t: any) => ['a', 'b'].includes(t.id)).every((t: any) => t.status === 'passed')
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: id === 'inspect' ? 'fs.read' : 'fs.write', input: { path: id === 'inspect' ? 'input.mjs' : id === 'join' ? 'registry.mjs' : 'module-' + id + '.mjs', content: 'export const ready = true\n' } }] } }
  } })
  agentId = runtime.createAgent({ goal: objective, program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'parallel', objective, acceptanceCriteria: ['c1', 'c2', 'c3', 'c4'].map(id => ({ id, description: 'Requirement ' + id })), status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } as JsonValue }).agentId
  try {
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'succeeded' })
    const a = runtime.state.agents.get(agentId)!
    expect((a.globalVersions.get(a.latestGlobalVersion) as any).taskOutcome.status).toBe('accepted')
    expect(overlapping).toBe(2)
    expect(integratedAfterBoth).toBe(true)
    expect(runtime.state.lanes.size).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(runtime.state.events)).not.toContain('GLOBAL_CONTEXT_WRITE_NOT_AUTHORIZED')
  } finally { clearTimeout(timer); release() }
})
