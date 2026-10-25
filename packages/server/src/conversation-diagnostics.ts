import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const pairs = (value: unknown): any[] => Array.isArray(value) ? value.flatMap(item => Array.isArray(item) && item.length === 2 ? [record(item[1])] : []) : []
const identifier = /^(?:conv|run)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export function assertDiagnosticTarget(request: string, conversationId: string, runId?: string): void {
  const named = new Set(request.match(/\bconv-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\w-])/gi) ?? [])
  if (!identifier.test(conversationId) || !conversationId.startsWith('conv-') || !named.has(conversationId) || runId !== undefined && (!identifier.test(runId) || !runId.startsWith('run-'))) throw new Error('DIAGNOSTIC_TARGET_NOT_AUTHORIZED')
}

/** Bounded metadata only; no config, raw prompts, result bodies or shell stdout. */
export async function inspectConversationRun(directory: string) {
  const root = await realpath(directory)
  let remainingBytes = 32 * 1024 * 1024
  let truncated = false
  const unavailable: string[] = []
  const load = async (name: string): Promise<any> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const path = await realpath(join(root, name)), scope = relative(root, path)
      if (scope === '..' || scope.startsWith(`..${sep}`)) throw new Error('DIAGNOSTIC_PATH_OUTSIDE_RUN')
      handle = await open(path, 'r')
      const size = (await handle.stat()).size
      if (size > remainingBytes) { truncated = true; throw new Error('DIAGNOSTIC_SIZE_LIMIT') }
      const bytes = Buffer.alloc(size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > size) { truncated = true; throw new Error('DIAGNOSTIC_SIZE_CHANGED') }
      remainingBytes -= bytesRead
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    } catch { unavailable.push(name); return undefined }
    finally { await handle?.close() }
  }
  const outcome = record(await load('outcome.json')), acceptance = record(await load('task-outcome.json'))
  const controller = record(await load('task-controller.json')), budget = record(await load('model-budget.json'))
  const persisted = record(await load('runtime.json')), state = record(record(persisted.state).state)
  const events = Array.isArray(state.events) ? [...state.events] : []
  const archives = (await readdir(join(root, 'runtime-events')).catch(() => [])).filter(name => /^\d+-\d+\.json$/.test(name)).sort()
  for (const name of archives.slice(-64)) {
    const archived = await load(join('runtime-events', name))
    if (Array.isArray(archived)) events.push(...archived)
  }
  const idle = [...new Map(events.filter(event => record(event).type === 'runtime.idle_blocked').map(event => [event.seq, event])).values()]
  const lanes = pairs(state.lanes), agents = pairs(state.agents), effects = pairs(state.effects)
  return {
    execution: { status: outcome.status ?? null, errorCode: record(outcome.error).code ?? null, completedAt: outcome.completedAt ?? null },
    acceptance: { status: acceptance.status ?? null, blockers: (Array.isArray(acceptance.blockers) ? acceptance.blockers : []).map((value: any) => ({ stageId: value.stageId, code: value.code, recovery: value.recovery })) },
    modelBudget: { used: budget.used ?? null, limit: budget.limit ?? null },
    agents: agents.map(agent => ({ id: agent.id, state: agent.state, rootLaneId: agent.rootLaneId })),
    lanes: lanes.map(lane => ({ id: lane.id, status: lane.status, resultRef: lane.resultRef ?? null, errorCode: record(record(lane.failure).error).code ?? null })),
    idleEvents: idle.map(event => ({ seq: event.seq, timestamp: event.timestamp, status: record(event.data ?? event.payload).status })),
    failedEffects: effects.filter(effect => record(effect.outcome).status === 'failed').map(effect => ({ id: effect.id, tool: record(effect.input).name ?? null, code: record(record(effect.outcome).error).code ?? null })),
    openEffectIds: effects.filter(effect => !effect.outcome).map(effect => effect.id),
    stages: (Array.isArray(controller.tasks) ? controller.tasks : []).map((stage: any) => ({ id: stage.id, status: stage.status, goal: String(stage.goal ?? '').slice(0, 180), blockerCode: String(stage.note ?? '').match(/\b[A-Z][A-Z_]{3,}\b/)?.[0] ?? null })),
    stateMismatch: outcome.status === 'failed' && agents.some(agent => agent.state === 'running' && lanes.some(lane => lane.id === agent.rootLaneId && lane.status === 'succeeded')),
    unavailable,
    truncated: truncated || archives.length > 64 || remainingBytes <= 0,
    verification: 'Historical execution metadata only; stage completion is distinct from original-task acceptance. No data was repaired or resumed.',
  }
}
