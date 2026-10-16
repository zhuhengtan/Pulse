import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PulseRuntime, FileRuntimePersistenceBackend } from '../../packages/runtime/dist/index.js'
import { runPersistence } from '../../packages/server/dist/run-persistence.js'

// No providers, credentials, network or user sessions. This measures deterministic
// scheduler steps and separately measures result-history storage, not model success.
const root = resolve(process.argv[2] ?? '.pulse-dev/harness-repair-20261015/scale')
await mkdir(root, { recursive: true })
async function bytes(path) {
  const info = await stat(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const name of await readdir(path)) total += await bytes(join(path, name))
  return total
}
const rows = []
for (const count of [100, 1000, 10000]) {
  const directory = join(root, `steps-${count}`)
  await mkdir(directory, { recursive: true })
  const backend = await runPersistence(directory, 'external-files')
  let written = 0, writes = 0
  const save = backend.save.bind(backend)
  backend.save = async (snapshot, digest) => { written += Buffer.byteLength(JSON.stringify(snapshot)); writes++; return save(snapshot, digest) }
  const program = { id: 'storage-scale', version: '1', step: ({ lane }) => {
    const n = Number(lane.resume.locals?.n ?? 0) + 1
    return n >= count ? { actions: [{ type: 'complete', result: { steps: n } }], next: { programId: 'storage-scale', programVersion: '1', step: 'loop', locals: { n } } } : { actions: [], next: { programId: 'storage-scale', programVersion: '1', step: 'loop', locals: { n } } }
  } }
  const runtime = new PulseRuntime({ sessionId: `scale-${count}`, persistenceBackend: backend, maxLaneStepsPerTick: 32 })
  const { agentId } = runtime.createAgent({ goal: 'Measure deterministic steps', program })
  const start = performance.now()
  const outcome = await runtime.start(agentId).outcome()
  await runtime.flushPersistence()
  const executionMs = performance.now() - start
  const restoreStart = performance.now()
  const restored = await PulseRuntime.restore(backend, { programs: [program], persistenceBackend: backend })
  const restoreMs = performance.now() - restoreStart
  const first = [...restored.state.lanes.values()].find(l => l.agentId === agentId)
  rows.push({ scenario: 'scheduler', requestedSteps: count, actualSteps: restored.results.get(first?.resultRef)?.value?.steps, status: outcome.status, executionMs, restoreMs, snapshotBytesWritten: written, writes, diskBytes: await bytes(directory), peakRSSBytes: process.resourceUsage().maxRSS * 1024 })
  console.log(JSON.stringify(rows.at(-1)))
  if (outcome.status !== 'succeeded' || restored.results.get(first?.resultRef)?.value?.steps !== count) throw new Error(`SCALE_STEPS_FAILED:${count}`)
}
for (const count of process.argv.includes('--scheduler-only') ? [] : [100, 1000, 10000]) {
  const directory = join(root, `results-${count}`)
  await mkdir(directory, { recursive: true })
  const backend = await runPersistence(directory, 'external-files')
  const runtime = new PulseRuntime({ sessionId: `results-${count}` })
  const start = performance.now()
  // Install an already durable historical batch in the same shape produced by
  // settled effects. Admission limits are unchanged; only one record is resident.
  for (let i = 1; i <= count; i++) {
    const ref = `result-${i}`, value = { i, content: 'x'.repeat(1024) }
    await backend.resultStore.save(ref, value)
    runtime.state.results.set(ref, { id: ref, privacy: 'public', derivedFrom: [], storageState: 'persisted' })
    runtime.storagePolicy.put('result', `result:${ref}`, { id: ref, value, privacy: 'public', derivedFrom: [] })
    runtime.storagePolicy.markPersisted([`result:${ref}`])
  }
  runtime.state.nextIds.result = count + 1
  await runtime.persist(backend)
  const persistMs = performance.now() - start
  const restoreStart = performance.now()
  const restored = await PulseRuntime.restore(backend)
  const restoreMs = performance.now() - restoreStart
  const descriptor = Object.getOwnPropertyDescriptor(restored.state.results.get(`result-${count}`), 'value')
  if (!descriptor?.get || restored.results.get(`result-${count}`)?.value?.i !== count) throw new Error('LAZY_RESULT_RETRIEVAL_FAILED')
  const file = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
  rows.push({ scenario: 'historical-results', results: count, persistMs, restoreMs, snapshotBytes: (await stat(join(directory, 'runtime.json'))).size, diskBytes: await bytes(directory), lazy: descriptor.enumerable === false, storedBodyInline: file.state.state.results.some(([, r]) => r.value !== undefined), peakRSSBytes: process.resourceUsage().maxRSS * 1024 })
  console.log(JSON.stringify(rows.at(-1)))
}
// A failed snapshot save must leave the last atomic snapshot readable.
const fault = await runPersistence(join(root, 'fault'), 'external-files')
const stable = new PulseRuntime(); await stable.persist(fault)
const before = JSON.stringify(await fault.load())
await stable.persist({ ...fault, save: async () => { throw new Error('INJECTED_STORAGE_FAILURE') } }).then(() => { throw new Error('MISSING_FAILURE') }, error => { if (error.message !== 'INJECTED_STORAGE_FAILURE') throw error })
if (JSON.stringify(await fault.load()) !== before) throw new Error('ORIGINAL_SNAPSHOT_CHANGED')
rows.push({ scenario: 'save-failure', originalPreserved: true, actualProviderCalls: 0 })
await writeFile(join(root, 'results.json'), JSON.stringify(rows, null, 2))
