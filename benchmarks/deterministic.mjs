import { performance } from 'node:perf_hooks'
import { PulseRuntime } from '../packages/runtime/dist/index.js'

const operations = 4
const runs = Math.max(1, Number.parseInt(process.env.PULSE_BENCHMARK_RUNS ?? '20', 10) || 20)

function point(step, locals = {}) {
  return { programId: 'pulse-deterministic-benchmark', programVersion: '1', step, locals }
}

function indexOf(lane) {
  const locals = lane.resume.locals
  return locals && typeof locals === 'object' && !Array.isArray(locals) && typeof locals.index === 'number' ? locals.index : 0
}

function makeProgram(mode) {
  return {
    id: 'pulse-deterministic-benchmark',
    version: '1',
    step: ({ lane, resumeInput }) => {
      if (lane.resume.step === 'worker') {
        if (resumeInput?.type === 'wait') return { actions: [{ type: 'complete', result: { worker: lane.goal } }], next: point('worker') }
        return { actions: [{ type: 'submit_effects', effects: [{ key: `worker-${lane.id}`, kind: 'tool', concurrencyClass: 'tool', input: { operation: lane.goal } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('worker') }
      }
      if (lane.resume.step === 'join') return { actions: [{ type: 'complete', result: { mode, operations } }], next: point('join') }
      if (mode === 'lanes' || mode === 'coalesced') {
        return { actions: [{ type: 'fork', lanes: Array.from({ length: operations }, (_, index) => ({ key: `worker-${index + 1}`, goal: `operation-${index + 1}`, program: point('worker'), ...(mode === 'coalesced' ? { affinityKey: 'same-context' } : {}) })), join: { condition: 'settled', onUnsatisfied: 'resume_with_error' } }], next: point('join') }
      }
      if (mode === 'batch') {
        return { actions: [{ type: 'submit_effects', effects: Array.from({ length: operations }, (_, index) => ({ key: `batch-${index + 1}`, kind: 'tool', concurrencyClass: 'tool', input: { operation: index + 1 } })), wait: { onUnsatisfied: 'resume_with_error' } }], next: point('join') }
      }
      const index = indexOf(lane) + (resumeInput?.type === 'wait' ? 1 : 0)
      if (index >= operations) return { actions: [{ type: 'complete', result: { mode, operations } }], next: point('start') }
      return { actions: [{ type: 'submit_effects', effects: [{ key: `serial-${index + 1}`, kind: 'tool', concurrencyClass: 'tool', input: { operation: index + 1 } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('start', { index }) }
    },
  }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]
}

async function measure(mode) {
  const samples = []
  let totalEffects = 0
  let totalLanes = 0
  const statuses = {}
  const failures = {}
  const rootStates = {}
  for (let iteration = 0; iteration < runs; iteration += 1) {
    const runtime = new PulseRuntime({ forkAffinity: mode === 'coalesced' ? 'coalesce' : 'off', effectExecutor: async (effect) => ({ value: { key: effect.key } }) })
    const program = makeProgram(mode)
    runtime.register(program)
    const started = performance.now()
    const { agentId } = runtime.createAgent(`benchmark:${mode}`, program)
    const outcome = await runtime.runAgent(agentId)
    samples.push(performance.now() - started)
    statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1
    const root = runtime.state.lanes.get(runtime.state.agents.get(agentId)?.rootLaneId)
    rootStates[root?.status ?? 'missing'] = (rootStates[root?.status ?? 'missing'] ?? 0) + 1
    const failureCode = root?.failure?.error.code ?? root?.outcome?.error?.code
    if (failureCode) failures[failureCode] = (failures[failureCode] ?? 0) + 1
    totalEffects += runtime.state.effects.size
    totalLanes += runtime.state.lanes.size
  }
  return {
    runs,
    samplesMs: samples.map((sample) => Number(sample.toFixed(3))),
    meanMs: Number((samples.reduce((sum, sample) => sum + sample, 0) / samples.length).toFixed(3)),
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    statuses,
    ...(Object.keys(failures).length ? { failures } : {}),
    rootStates,
    averageEffects: Number((totalEffects / runs).toFixed(2)),
    averageLanes: Number((totalLanes / runs).toFixed(2)),
  }
}

const results = {}
for (const mode of ['serial', 'batch', 'lanes', 'coalesced']) results[mode] = await measure(mode)
console.log(JSON.stringify({ schemaVersion: 1, workload: { operations, runs, executor: 'deterministic-immediate' }, results }, null, 2))
