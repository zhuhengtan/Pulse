import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime, FileRuntimePersistenceBackend, FileRuntimeContentStore, contentHash } from '@hunterzhu/pulse-runtime'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { captureCheck, finishCheck } from '../packages/server/src/check-receipt.js'
import { staleFileEvidence } from '../packages/server/src/task-controller/evidence-current.js'
import { ShellOutput } from '../packages/adapters/src/tools/shell-output.js'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { StagedEditor, STREAM_BYTES } from '../packages/server/src/editing.js'
import { confirmedInteractionSurface } from '../packages/runtime/src/dsl/program.js'
import { recoveryCompatibility, prepareRecovery } from '../packages/server/src/recovery-contract.js'
import { freezeConstraintBaseline, violatedConstraints } from '../packages/server/src/constraint-baseline.js'
import { PagedEventArchive } from '../packages/server/src/event-archive.js'
import { canReadShellArchive } from '../packages/server/src/shell-archive.js'

const roots: string[] = []
const temporary = async () => { const dir = await mkdtemp(join(tmpdir(), 'pulse-harness-repair-')); roots.push(dir); return dir }
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })

it.each((['27','28'] as const).flatMap(version => ['valid', 'empty', 'missing', 'duplicate', 'unknown', 'error'].map(mode => ({version,mode}))))('final acceptance fails closed: $version $mode', async ({version,mode}) => {
  let agentId = '', finalCalls = 0, workCalls = 0, plans = 0
  const program = buildTaskControllerProgram({ version, system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 16 })
  const global = () => { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) as any }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.key?.startsWith('plan')) { plans++; return { value: { tasks: [{ id: 'explain', goal: 'Explain the design', check: 'Response delivered', dependsOn: [], criterionIds: ['criterion-1', 'criterion-2'] }] } } }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: [global().taskController.tasks[0].candidateRef], note: 'Response delivered' } }
    if (effect.key?.startsWith('verify-task')) {
      finalCalls++
      if (mode === 'error') return { value: null, status: 'failed', error: { code: 'ENOTFOUND', message: 'offline', retryable: false } }
      const refs = [global().taskController.tasks[0].candidateRef]
      const criteria = ['criterion-1', 'criterion-2'].map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: mode === 'unknown' ? ['result-does-not-exist'] : refs, rationale: 'Delivered' }))
      return { value: { criteria: mode === 'empty' ? [] : mode === 'missing' ? criteria.slice(0, 1) : mode === 'duplicate' ? [criteria[0]!, { ...criteria[0]!, status: 'not_met' }] : criteria } }
    }
    workCalls++; return { value: { text: 'Design: a queue and a durable checkpoint.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Explain a design', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Explain a design', acceptanceCriteria: [{ id: 'criterion-1', description: 'Explain queue' }, { id: 'criterion-2', description: 'Explain checkpoints' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(global().taskOutcome.status).toBe(mode === 'valid' ? 'accepted' : 'incomplete')
  expect(global().taskController.tasks[0].status).toBe('passed')
  expect(plans).toBe(1); expect(workCalls).toBe(1); expect(finalCalls).toBe(mode === 'unknown' || version === '28' && ['empty','missing','duplicate'].includes(mode) ? 2 : 1)
})

it('keeps prose, constraints, every long-list item and exact document source spans', () => {
  const objective = '实现用户注册。必须复用现有数据库，禁止新增依赖。\n- 支持邮箱注册\n- 支持手机号注册'
  const criteria = acceptanceCriteriaFromObjective(objective, 'requirements.md')
  expect(criteria).toHaveLength(4)
  expect(criteria[1]!.kind).toBe('constraint')
  for (const c of criteria) { expect(objective.slice(c.source!.start, c.source!.end)).toBe(c.description); expect(c.source!.document).toBe('requirements.md'); expect(c.source!.hash).toMatch(/^[a-f0-9]{64}$/) }
  expect(acceptanceCriteriaFromObjective(Array.from({ length: 100 }, (_, i) => `- Requirement ${i}`).join('\n'))).toHaveLength(100)
})

it('binds tests to artifact versions and freezes check definitions', async () => {
  const root = await temporary()
  await writeFile(join(root, 'feature.mjs'), 'export const answer = 42\n')
  await writeFile(join(root, 'feature.test.mjs'), "import { answer } from './feature.mjs'; if (answer !== 42) throw Error('wrong')\n")
  const receipt = await finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'feature.test.mjs']), join(root, 'receipts'))
  expect(receipt.files['feature.mjs']).toMatch(/^[a-f0-9]{64}$/)
  const runtime = new PulseRuntime()
  runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: receipt as any } })
  await writeFile(join(root, 'unrelated.md'), 'unrelated')
  expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual([])
  await writeFile(join(root, 'feature.mjs'), 'export const answer = 43\n')
  expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual(['result-1'])
  const rerun = await finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'feature.test.mjs']), join(root, 'receipts'))
  expect(rerun.definitionChanged).toBe(false)
  runtime.state.results.get('result-1')!.value = { code: 0, checkReceipt: rerun as any }
  expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual([])
  await writeFile(join(root, 'feature.test.mjs'), 'process.exit(0)\n')
  const weakened = await finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'feature.test.mjs']), join(root, 'receipts'))
  expect(weakened.definitionChanged).toBe(true)
})

it('retains the original shell tail, hash and bounded disk overflow without another execution', async () => {
  const root = await temporary(), capture = new ShellOutput(100, root, 1000)
  capture.append('stderr', Buffer.from('HEAD' + 'x'.repeat(300) + 'FINAL ERROR'))
  expect(capture.text('stderr')).toContain('FINAL ERROR')
  expect(Buffer.byteLength(capture.text('stderr'))).toBeLessThanOrEqual(100)
  const receipt = capture.finish().stderr!
  expect(receipt.complete).toBe(true)
  expect(await readFile(join(root, receipt.id), 'utf8')).toContain('FINAL ERROR')
  expect(receipt.bytes).toBe(315); expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
  const overflow = new ShellOutput(100, root, 10); overflow.append('stdout', Buffer.alloc(1000)); expect(overflow.finish().stdout).toMatchObject({ bytes: 1000, storedBytes: 10, complete: false })
})

it('delivers 100 KiB in eight bounded tool operations, retaining CAS and existing-file protection', async () => {
  const root = await temporary(), editor = new StagedEditor(new FilesystemTool(root), 'run-1')
  const content = 'x'.repeat(100 * 1024)
  let draft = await editor.execute({ operation: 'begin', path: 'deliverable.txt', content: content.slice(0, STREAM_BYTES) }), steps = 1
  for (let offset = STREAM_BYTES; offset < content.length; offset += STREAM_BYTES) { draft = await editor.execute({ operation: 'append', draftId: draft.draftId, revision: draft.revision, content: content.slice(offset, offset + STREAM_BYTES) }); steps++ }
  await editor.execute({ operation: 'commit', draftId: draft.draftId, revision: draft.revision, expectedBytes: content.length }); steps++
  expect(steps).toBe(8); expect(await readFile(join(root, 'deliverable.txt'), 'utf8')).toBe(content)
  await expect(editor.execute({ operation: 'begin', path: 'deliverable.txt' })).rejects.toMatchObject({ code: 'EXISTING_FILE_NEEDS_PATCH' })
})

it('protects verification reservations, role counts, unknown costs and resume limits', async () => {
  const root = await temporary(), path = join(root, 'budget.json')
  const budget = await ModelAttemptBudget.open(path, 5, 0, { verificationReserve: 2 })
  await Promise.all(['planning', 'approval', 'compaction'].map(role => budget.reserve(role)))
  await expect(budget.reserve('work')).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  await budget.reserve('verification'); await expect(budget.reserve('verification')).rejects.toThrow()
  await budget.reserve('final-verification')
  const restored = await ModelAttemptBudget.open(path, 100)
  expect(restored.limit).toBe(5); expect(restored.accounting.purposes).toEqual({ planning: 1, approval: 1, compaction: 1, verification: 1, 'final-verification': 1 })
  const metered = await ModelAttemptBudget.open(join(root, 'metered.json'), 16, 0, { maxTokens: 20 })
  await metered.reserve(); await expect(metered.reserve()).rejects.toThrow(/unknown/i)
  await metered.recordUsage({ inputTokens: 10, outputTokens: 10 }); await expect(metered.reserve()).rejects.toThrow(/token budget/i)
})

it.each([30, 100])('keeps the earliest critical constraint through %s decisions with bounded bytes', count => {
  const answers = Array.from({ length: count }, (_, i) => ({ decisionId: `decision-${i}`, question: i === 0 ? '禁止新增依赖' : `Question ${i}`, pinned: i === 0, answer: 'Answer '.repeat(30), resultRef: `result-${i}` }))
  const surface = confirmedInteractionSurface(answers) as any
  expect(surface.recent.some((a: any) => a.decisionId === 'decision-0')).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(surface))).toBeLessThanOrEqual(8192)
  expect(surface.omitted).toBeGreaterThan(0)
})

it('requires explicit owner confirmation and keeps the original legacy draft', async () => {
  const root = await temporary(), files = new FilesystemTool(root), id = '11111111-1111-4111-8111-111111111111'
  const original = JSON.stringify({ version: 1, path: 'new.txt', baseline: null, content: 'unfinished', committed: false })
  await files.writeIfUnchanged(`.pulse/drafts/${id}.json`, original, null)
  const editor = new StagedEditor(files, 'run-1'), preview = await editor.migrateLegacy(id)
  expect(preview.migrated).toBe(false); expect(await files.read(`.pulse/drafts/${id}.json`)).toBe(original)
  await expect(editor.migrateLegacy(id, 'a'.repeat(64), true)).rejects.toMatchObject({ code: 'DRAFT_REVISION_CONFLICT' })
  const migrated = await editor.migrateLegacy(id, preview.revision, true)
  expect(migrated.migrated).toBe(true)
  expect((await editor.execute({ operation: 'begin', path: 'new.txt' })).draftId).toBe(id)
  expect(await files.read(`.pulse/draft-migrations/${id}-${preview.revision}.json`)).toBe(original)
  const committed = await editor.execute({ operation: 'commit', draftId: id, revision: migrated.revision, expectedBytes: 10 })
  expect(committed.committed).toBe(true)
})

it('classifies schema and policy drift without changing the original snapshot', async () => {
  const fingerprint = { build: 'build-a', policy: 'ask', tools: { 'fs.write': 'schema-a' } }
  expect(recoveryCompatibility(undefined, fingerprint).status).toBe('migratable')
  expect(recoveryCompatibility(fingerprint, { ...fingerprint, build: 'build-b' }).status).toBe('migratable')
  expect(recoveryCompatibility(fingerprint, { ...fingerprint, tools: { 'fs.write': 'schema-b' } })).toMatchObject({ status: 'incompatible', reasons: ['TOOL_SCHEMA_INCOMPATIBLE:fs.write'] })
  const root = await temporary(), backend = new FileRuntimePersistenceBackend(join(root, 'runtime.json'))
  const runtime = new PulseRuntime(); await runtime.persist(backend)
  const original = await readFile(backend.filePath, 'utf8')
  expect((await prepareRecovery(backend, root, fingerprint)).status).toBe('migratable')
  expect(await readFile(backend.filePath, 'utf8')).toBe(original)
})

it('requires exact build migration authorization and never rewrites an unapproved snapshot', async () => {
  const root = await temporary(), backend = new FileRuntimePersistenceBackend(join(root, 'runtime.json'))
  const previous = { build: 'a'.repeat(64), tools: {}, policy: 'p' }, current = { ...previous, build: 'b'.repeat(64) }
  await new PulseRuntime({ recoveryFingerprints: previous }).persist(backend)
  const original = await readFile(backend.filePath, 'utf8')
  await expect(prepareRecovery(backend, root, current)).rejects.toThrow('RECOVERY_BUILD_MIGRATION_REQUIRED')
  await expect(PulseRuntime.restore(backend, { recoveryFingerprints: current })).rejects.toThrow('RECOVERY_BUILD_MIGRATION_REQUIRED')
  expect(await readFile(backend.filePath, 'utf8')).toBe(original)
  await expect(prepareRecovery(backend, root, current, { from: previous.build, to: current.build })).resolves.toMatchObject({ status: 'migratable' })
  await expect(PulseRuntime.restore(backend, { recoveryFingerprints: current, recoveryBuildMigration: { from: previous.build, to: current.build } })).resolves.toBeInstanceOf(PulseRuntime)
})

it('enforces the original no-new-dependencies constraint independently of model verdicts', async () => {
  const root = await temporary(), data = join(root, 'data')
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { existing: '1' } }))
  await freezeConstraintBaseline(root, data)
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { existing: '2', unsolicited: '1' } }))
  expect(await violatedConstraints(root, data, ['禁止新增依赖。'])).toEqual(['package.json: added dependencies:unsolicited'])
  expect(await violatedConstraints(root, data, ['升级现有依赖。'])).toEqual([])
})

it('allows package dependency edits while keeping the invoked check script immutable', async () => {
  const root = await temporary(), store = join(root, 'data')
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, dependencies: {} }))
  await finishCheck(root, await captureCheck(root, root, 'pnpm', ['test']), store)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { permitted: '1' } }))
  expect((await finishCheck(root, await captureCheck(root, root, 'pnpm', ['test']), store)).definitionChanged).toBe(false)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo success' }, dependencies: { permitted: '1' } }))
  expect((await finishCheck(root, await captureCheck(root, root, 'pnpm', ['test']), store)).definitionChanged).toBe(true)
})

it('archives event pages idempotently and rejects conflicting historical events', async () => {
  const root = await temporary(), archive = new PagedEventArchive(root)
  const event = (seq: number) => ({ id: `event-${seq}`, schemaVersion: 1 as const, seq, timestamp: 0, sessionId: 'test', type: 'step.committed' as const, data: null })
  await archive.append([event(1), event(2)])
  await archive.append([event(2), event(3)])
  expect((await archive.read(2, 3)).map(e => e.seq)).toEqual([2, 3])
  await expect(archive.append([{ ...event(2), timestamp: 1 }])).rejects.toThrow('RUNTIME_EVENT_ARCHIVE_CONFLICT')
})

it('external result restore reads only the requested body and detects a corrupted result', async () => {
  const root = await temporary(), backend = Object.assign(new FileRuntimePersistenceBackend(join(root, 'runtime.json')), { resultStore: new FileRuntimeContentStore(join(root, 'results')), lazyResultBodies: true })
  const runtime = new PulseRuntime()
  for (let i = 1; i <= 20; i++) runtime.state.results.set(`result-${i}`, { id: `result-${i}`, privacy: 'public', derivedFrom: [], contentHash: contentHash({ index: i }), value: { index: i } })
  await runtime.persist(backend)
  let reads = 0
  const load = backend.resultStore.loadSync.bind(backend.resultStore)
  backend.resultStore.loadSync = ref => { reads++; return load(ref) }
  const restored = await PulseRuntime.restore(backend)
  expect(reads).toBe(0)
  expect(restored.results.get('result-7')?.value).toEqual({ index: 7 })
  expect(reads).toBe(1)
  expect(restored.results.get('result-7')?.value).toEqual({ index: 7 })
  expect(reads).toBe(1)
  backend.resultStore.loadSync = ref => ref === 'result-8' ? { index: 999 } : load(ref)
  expect(() => restored.results.get('result-8')).toThrow('RUNTIME_RESULT_INTEGRITY_MISMATCH')
})

it('keeps shell archives within their original result visibility', () => {
  const runtime = new PulseRuntime()
  const { laneId } = runtime.createAgent('inspect', { id: 'inspect', version: '1', step: () => ({ actions: [], next: { programId: 'inspect', programVersion: '1', step: 'start' } }) })
  runtime.state.effects.set('effect-output', { input: { name: 'shell.exec' }, outcome: { status: 'succeeded', resultRef: 'result-output' } } as any)
  runtime.state.results.set('result-output', { id: 'result-output', privacy: 'public', derivedFrom: [], value: { outputArchive: { stdout: { id: 'log-output' } } } })
  runtime.state.lanes.get(laneId)!.visibleResultRefs = new Set(['result-output'])
  expect(canReadShellArchive(runtime, laneId, 'log-output')).toBe(true)
  expect(canReadShellArchive(runtime, laneId, 'another-log')).toBe(false)
  runtime.state.results.get('result-output')!.privacy = 'local_only'
  expect(canReadShellArchive(runtime, laneId, 'log-output')).toBe(false)
  runtime.state.results.get('result-output')!.privacy = 'public'
  runtime.state.lanes.get(laneId)!.visibleResultRefs!.clear()
  expect(canReadShellArchive(runtime, laneId, 'log-output')).toBe(false)
})
