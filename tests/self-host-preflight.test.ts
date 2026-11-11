import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectStableEngine, killOwnedChildGroups, main, selectInvoker } from '../scripts/self-host.mjs'
import { createSnapshot, snapshotRuntimeDigest } from '../scripts/self-host-snapshot.mjs'
import { trackControlledMain } from './helpers/self-host-controlled-main'

const roots: string[] = []
const put = async (file: string, body: string) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, body); return file }
async function fixture(verified = true) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-engine-preflight-')); roots.push(root)
  const cwd = join(root, 'project'), data = join(root, 'data'), engine = join(root, 'engine')
  await mkdir(cwd); await mkdir(data)
  const entry = await put(join(engine, 'dist/bin.js'), `console.log(JSON.stringify({type:'result',status:'succeeded',taskOutcome:{status:'accepted'},conversationId:'fixture'}))`)
  await put(join(engine, 'package.json'), JSON.stringify({ name: '@fixture/cli', version: '1.0.0', type: 'module', dependencies: { '@hunterzhu/pulse-server': '1.0.0' } }))
  const server = join(engine, 'node_modules/@hunterzhu/pulse-server')
  await put(join(server, 'package.json'), JSON.stringify({ name: '@hunterzhu/pulse-server', version: '1.0.0', type: 'module' }))
  const module = await put(join(server, 'dist/h5/workspaces.js'), `export class H5WorkspaceManager { static selfHostBeforeApply = 1; static selfHostInternalDataBoundary = 1; constructor() { throw new Error('PREFLIGHT_MUST_NOT_OPEN_DATA') } async get() {} async close() {} ${verified ? 'async finishVerified() {}' : ''} }`)
  return { root, cwd, data, engine, entry, module }
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('rejects an old stable engine before authentication, model tasks, or opening any data', async () => {
  const f = await fixture(false), calls: string[] = []
  const invoke = selectInvoker({ transport: 'h5', cliEntry: f.entry, http: { request: async (url: string) => { calls.push(url); return {} } } })
  await expect(invoke({ cwd: f.cwd, dataDir: f.data, prompt: 'repair' })).rejects.toThrow('SELF_HOST_VERIFIED_MERGE_UNSUPPORTED')
  expect(calls).toEqual([])
})

it('rejects a manager with verified merge but no before-apply cancellation protocol', async () => {
  const f = await fixture(), calls: string[] = []
  await writeFile(f.module, (await readFile(f.module, 'utf8')).replace('static selfHostBeforeApply = 1;', ''))
  const invoke = selectInvoker({ transport: 'h5', cliEntry: f.entry, http: { request: async (url: string) => { calls.push(url); return {} } } })
  await expect(invoke({ cwd: f.cwd, dataDir: f.data, prompt: 'repair' })).rejects.toThrow('SELF_HOST_BEFORE_APPLY_UNSUPPORTED')
  expect(calls).toEqual([])
})

it('preflights a supported manager without constructing it and freezes its module bytes', async () => {
  const f = await fixture()
  const inspected = await inspectStableEngine({ cliEntry: f.entry, cwd: f.cwd, transport: 'h5' })
  expect(inspected.identity).toMatchObject({ verifiedMerge: true, binding: 'entry-and-workspace-module', runtimeDigest: null })
  await inspected.verify()
  await writeFile(f.module, '// modified after inspection')
  await expect(inspected.verify()).rejects.toThrow()
})

it('refuses a stable manager symlink that resolves into the project before importing it', async () => {
  const f = await fixture()
  const source = await put(join(f.cwd, 'candidate-manager.js'), `throw new Error('MUST_NOT_IMPORT_CANDIDATE')`)
  await rm(f.module); await symlink(source, f.module)
  await expect(inspectStableEngine({ cliEntry: f.entry, cwd: f.cwd, transport: 'h5' })).rejects.toThrow('SELF_HOST_ENGINE_MODULE_INSIDE_PROJECT')
})

it('records an unsupported preflight as stopped before even running the baseline', async () => {
  const f = await fixture(false), calls: string[] = []
  const task = await put(join(f.root, 'task.txt'), 'repair'), checks = await put(join(f.root, 'checks.json'), JSON.stringify([[process.execPath, '-e', 'throw Error("BASELINE_MUST_NOT_RUN")']]))
  const output = join(f.root, 'report')
  const code = await main(['--cwd', f.cwd, '--data-dir', f.data, '--cli-entry', f.entry, '--transport', 'h5', '--task-file', task, '--checks-file', checks, '--output', output], { http: { request: async (url: string) => { calls.push(url); return {} } }, log: () => {} })
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  expect(code).toBe(2); expect(calls).toEqual([]); expect(report.baseline).toBe(null); expect(report.attempts).toEqual([])
  expect(report.error.message).toContain('SELF_HOST_VERIFIED_MERGE_UNSUPPORTED')
  expect(report.stages.map((item: any) => item.name)).toEqual(['engine_preflight', 'complete'])
  expect(report.delivery).toMatchObject({ code: 'not_started', merge: 'not_requested', activation: 'not_requested', runningVersionVerified: false })
})

it('binds an external capsule before loading its manager and detects rewritten runtime plus manifest', async () => {
  const f = await fixture(), snapshot = join(f.root, 'capsule')
  const created = await createSnapshot({ cliEntry: f.entry, cwd: f.cwd, snapshot })
  const entry = join(snapshot, created.entries.cli)
  const inspected = await inspectStableEngine({ cliEntry: entry, cwd: f.cwd, transport: 'h5', engineSnapshot: snapshot, engineDigest: created.runtimeDigest })
  expect(inspected.identity).toMatchObject({ binding: 'runtime-closure', runtimeDigest: created.runtimeDigest, externallyPinned: true })
  const manifest = JSON.parse(await readFile(created.manifest, 'utf8'))
  const file = manifest.files.find((item: any) => item.path.endsWith('/dist/h5/workspaces.js'))
  const bytes = `throw new Error('CHANGED_MODULE_MUST_NOT_IMPORT')`
  await writeFile(join(snapshot, file.path), bytes)
  const { createHash } = await import('node:crypto')
  file.size = Buffer.byteLength(bytes); file.sha256 = createHash('sha256').update(bytes).digest('hex')
  manifest.runtimeIdentity.digest = snapshotRuntimeDigest(manifest)
  await writeFile(created.manifest, JSON.stringify(manifest))
  await expect(inspected.verify()).rejects.toThrow()
  await expect(inspectStableEngine({ cliEntry: entry, cwd: f.cwd, transport: 'h5', engineSnapshot: snapshot, engineDigest: created.runtimeDigest })).rejects.toThrow('SELF_HOST_ENGINE_SNAPSHOT_INVALID')
})

it('auto-discovers a capsule but refuses an entry outside the explicitly selected capsule', async () => {
  const f = await fixture(), snapshot = join(f.root, 'capsule')
  const created = await createSnapshot({ cliEntry: f.entry, cwd: f.cwd, snapshot })
  const inspected = await inspectStableEngine({ cliEntry: join(snapshot, created.entries.cli), cwd: f.cwd, transport: 'h5' })
  expect(inspected.identity).toMatchObject({ binding: 'runtime-closure', runtimeDigest: created.runtimeDigest, externallyPinned: false })
  await expect(inspectStableEngine({ cliEntry: f.entry, cwd: f.cwd, engineSnapshot: snapshot })).rejects.toThrow('SELF_HOST_ENGINE_SNAPSHOT_ENTRY_MISMATCH')
  await expect(inspectStableEngine({ cliEntry: f.entry, cwd: f.cwd, engineDigest: created.runtimeDigest })).rejects.toThrow('SELF_HOST_ENGINE_DIGEST_REQUIRES_SNAPSHOT')
})

it('reports successful CLI checks without claiming isolated merge or activation', async () => {
  const f = await fixture(), output = join(f.root, 'report')
  const task = await put(join(f.root, 'task.txt'), 'fixture'), checks = await put(join(f.root, 'checks.json'), JSON.stringify([[process.execPath, '-e', 'process.exit(0)']]))
  const code = await main(['--cwd', f.cwd, '--data-dir', f.data, '--cli-entry', f.entry, '--task-file', task, '--checks-file', checks, '--output', output], { log: () => {} })
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  expect(code).toBe(0)
  expect(report.delivery).toEqual({ code: 'verified', merge: 'not_requested', validation: 'candidate_passed', activation: 'not_requested', runningVersionVerified: false })
  expect(report.stages.filter((item: any) => item.state === 'passed').map((item: any) => item.name)).toEqual(['engine_preflight', 'baseline_checks', 'candidate_checks', 'complete'])
})

it('retains durable progress and fails if baseline checks change the already pinned engine', async () => {
  const f = await fixture(), output = join(f.root, 'report')
  const task = await put(join(f.root, 'task.txt'), 'fixture')
  const check = await put(join(f.root, 'check.mjs'), `import {writeFileSync,readFileSync} from 'node:fs'; const report=JSON.parse(readFileSync(${JSON.stringify(join(output,'report.json'))},'utf8')); if(report.stages.at(-1).name!=='baseline_checks')process.exit(10);writeFileSync(${JSON.stringify(f.entry)},'throw Error("MUST_NOT_RUN_CHANGED_ENGINE")');`)
  const checks = await put(join(f.root, 'checks.json'), JSON.stringify([[process.execPath, check]]))
  expect(await main(['--cwd', f.cwd, '--data-dir', f.data, '--cli-entry', f.entry, '--task-file', task, '--checks-file', checks, '--output', output], { log: () => {} })).toBe(3)
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  expect(report.status).toBe('freeze_tampered'); expect(report.ok).toBe(false)
  expect(report.attempts).toEqual([])
  expect(report.stages.at(-1)).toMatchObject({ name: 'complete', state: 'stopped' })
})


it('rejects an out-of-capsule fallback before executing its top-level code', async () => {
  const f = await fixture(), snapshot = join(f.root, 'capsule')
  const created = await createSnapshot({ cliEntry: f.entry, cwd: f.cwd, snapshot })
  const manifest = JSON.parse(await readFile(created.manifest, 'utf8'))
  const original = manifest.files.find((item: any) => item.path === created.entries.cli)
  await copyFile(join(snapshot, original.path), join(snapshot, 'shallow.mjs'))
  manifest.files.push({ ...original, path: 'shallow.mjs' }); manifest.entries.cli = 'shallow.mjs'
  manifest.runtimeIdentity.digest = snapshotRuntimeDigest(manifest)
  await writeFile(created.manifest, JSON.stringify(manifest))
  const marker = join(f.root, 'unsafe-import')
  await put(join(f.root, 'node_modules/@hunterzhu/pulse-server/package.json'), '{"type":"module"}')
  await put(join(f.root, 'node_modules/@hunterzhu/pulse-server/dist/h5/workspaces.js'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export class H5WorkspaceManager{}`)
  await expect(inspectStableEngine({ cliEntry: join(snapshot, 'shallow.mjs'), cwd: f.cwd, transport: 'h5', engineSnapshot: snapshot, engineDigest: manifest.runtimeIdentity.digest })).rejects.toThrow('SELF_HOST_ENGINE_MODULE_OUTSIDE_SNAPSHOT')
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('pins the target directory across preflight and invocation', async () => {
  const f = await fixture(), other = join(f.root, 'other'); await mkdir(other)
  const invoke = selectInvoker({ transport: 'cli', cliEntry: f.entry })
  await invoke.preflight({ cwd: f.cwd })
  await expect(invoke({ cwd: other, dataDir: f.data, prompt: 'fixture' })).rejects.toThrow('SELF_HOST_ENGINE_TARGET_CHANGED')
})

it.each(['close', 'engine-change', 'integration-check', 'applied-then-throw'])('retains the actual merge outcome on %s failure', async failure => {
  const f = await fixture(), cwd = await realpath(f.cwd), candidate = join(f.root, 'candidate'), output = join(f.root, 'report')
  await mkdir(candidate); await put(join(candidate, 'ready'), 'fixed')
  await put(join(f.data, 'conversations/conv/runs/run/task-outcome.json'), JSON.stringify({ status: 'accepted' }))
  const task = await put(join(f.root, 'task.txt'), 'fixture')
  const counter = join(f.root, 'checks-count')
  const check = await put(join(f.root, 'check.mjs'), `import{existsSync,readFileSync,writeFileSync}from'node:fs';const file=${JSON.stringify(counter)};const n=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1;writeFileSync(file,String(n));process.exit(${failure === 'integration-check' ? "n===3?23:" : ''}existsSync('ready')?0:1)`)
  const checks = await put(join(f.root, 'checks.json'), JSON.stringify([[process.execPath, check]]))
  let closes = 0
  class Manager {
    static selfHostBeforeApply = 1
    static selfHostInternalDataBoundary = 1
    async get() { return { conversationId: 'conv', projectRoot: cwd, worktreeRoot: candidate, projectSubdirectory: '', status: 'pending', kind: 'git' } }
    async close() { if (++closes === 2 && failure === 'close') throw new Error('FIXTURE_CLOSE_FAILED') }
    async finishVerified(_id: string, validate: (cwd: string) => Promise<void>) {
      await validate(candidate)
      await writeFile(join(cwd, 'ready'), 'fixed')
      if (failure === 'engine-change') await writeFile(f.entry, '// changed after applying patch')
      if (failure === 'applied-then-throw') throw new Error('FIXTURE_SAVE_FAILED_AFTER_APPLY')
      return { status: 'merged' }
    }
  }
  const code = await main(['--cwd', cwd, '--data-dir', f.data, '--cli-entry', f.entry, '--transport', 'h5', '--task-file', task, '--checks-file', checks, '--output', output, '--max-attempts', '1'], {
    importModule: async () => ({ H5WorkspaceManager: Manager }), log: () => {},
    http: { request: async (url: string) => {
      if (url === '/api/session/local') return { ok: true }
      if (url === '/api/session') return { capabilities: { selfHostExternalValidation: 1, selfHostInternalDataBoundary: 1 } }
      if (url === '/api/projects') return [{ id: 'project', cwd }]
      if (url === '/api/conversations') return { id: 'conv' }
      if (url.endsWith('/messages')) return { runId: 'run' }
      if (url.endsWith('/state')) return { state: 'succeeded' }
      return { ok: true }
    } },
  })
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  expect(code).not.toBe(0); expect(report.ok).toBe(false)
  expect(report.delivery).toMatchObject({ merge: failure === 'integration-check' ? 'blocked' : failure === 'applied-then-throw' ? 'unknown' : 'merged', activation: 'not_requested', runningVersionVerified: false })
  if (failure === 'integration-check') await expect(readFile(join(cwd, 'ready'))).rejects.toMatchObject({ code: 'ENOENT' })
  else {
    expect(await readFile(join(cwd, 'ready'), 'utf8')).toBe('fixed')
    if (failure === 'applied-then-throw') { expect(code).toBe(8); expect(report.status).toBe('needs_attention'); expect(report.finalize).toBeUndefined(); expect(report.message).toContain('不自动重试') }
    else expect(report.finalize.merged).toBe(true)
  }
})

it.each(['baseline', 'candidate', 'integration', 'project'])('classifies a real fixed-check timeout at the %s stage without claiming success', async phase => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(0)
  const f = await fixture(), cwd = await realpath(f.cwd), candidate = join(f.root, 'candidate'), output = join(f.root, 'report')
  await mkdir(candidate)
  await put(join(f.data, 'conversations/conv/runs/run/task-outcome.json'), JSON.stringify({ status: 'accepted' }))
  const task = await put(join(f.root, 'task.txt'), 'fixture'), counter = join(f.root, 'count')
  const stop = ['baseline', 'candidate', 'integration', 'project'].indexOf(phase) + 1
  const ready = join(f.root, 'check-ready'), entries = join(f.root, 'check-entries.jsonl'), cliStarted = join(f.root, 'cli-started')
  await writeFile(f.entry, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(cliStarted)},'unexpected CLI')`)
  const check = await put(join(f.root, 'check.mjs'), [
    "import{existsSync,readFileSync,writeFileSync,appendFileSync,renameSync}from'node:fs'",
    `const file=${JSON.stringify(counter)},ready=${JSON.stringify(ready)}`,
    "const n=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1;writeFileSync(file,String(n))",
    `appendFileSync(${JSON.stringify(entries)},JSON.stringify({n,pid:process.pid,cwd:process.cwd()})+'\\n')`,
    `if(n===${stop}){writeFileSync(ready+'.tmp',String(n));renameSync(ready+'.tmp',ready);setInterval(()=>{},1000)}else process.exit(n===1?23:0)`,
  ].join('\n'))
  const checks = await put(join(f.root, 'checks.json'), JSON.stringify([[process.execPath, check]]))
  const requests: string[] = []
  let mergeCalls = 0, closed = 0
  class Manager {
    static selfHostBeforeApply = 1
    static selfHostInternalDataBoundary = 1
    async get() { return { conversationId: 'conv', projectRoot: cwd, worktreeRoot: candidate, projectSubdirectory: '', status: 'pending', kind: 'git' } }
    async close() { closed++ }
    async finishVerified(_id: string, validate: (cwd: string) => Promise<void>, options: {beforeApply: () => void}) {
      mergeCalls++
      await validate(candidate); options.beforeApply(); await writeFile(join(cwd, 'applied'), 'yes'); return { status: 'merged' }
    }
  }
  const pending = main(['--cwd',cwd,'--data-dir',f.data,'--cli-entry',f.entry,'--transport','h5','--task-file',task,'--checks-file',checks,'--output',output,'--max-attempts','1','--timeout-ms','200'], {
    importModule: async () => ({ H5WorkspaceManager: Manager }), log: () => {},
    http: { request: async (url: string) => {
      requests.push(url)
      if(url==='/api/session/local')return{ok:true};if(url==='/api/session')return{capabilities:{selfHostExternalValidation:1,selfHostInternalDataBoundary:1}}
      if(url==='/api/projects')return[{id:'project',cwd}];if(url==='/api/conversations')return{id:'conv'}
      if(url.endsWith('/messages'))return{runId:'run'};if(url.endsWith('/state'))return{state:'succeeded'};return{ok:true}
    } },
  })
  const owned = trackControlledMain(pending, 200)
  try {
    // Earlier real children finish normally. Only the selected child's ready
    // receipt allows its original 200ms timer to fire, independent of OS startup.
    const handshakeDeadline = performance.now() + 5000
    let entered = false
    while (performance.now() < handshakeDeadline) {
      entered = await readFile(ready, 'utf8').then(value => Number(value) === stop, () => false)
      if (entered) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    expect(entered).toBe(true)
    vi.advanceTimersByTime(200)
    const code = await owned.wait()
    const children = (await readFile(entries, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(await Promise.all(children.map(child => realpath(child.cwd)))).toEqual(await Promise.all([cwd, candidate, candidate, cwd].slice(0, stop).map(dir => realpath(dir))))
    expect(children.map(child => child.n)).toEqual(Array.from({ length: stop }, (_, i) => i + 1))
    expect(Number(await readFile(counter, 'utf8'))).toBe(stop)
    for (const child of children) {
      expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    expect(killOwnedChildGroups('SIGTERM')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(readFile(cliStarted)).rejects.toMatchObject({ code: 'ENOENT' })
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    expect(code).toBe(5); expect(report).toMatchObject({status:'timeout',ok:false})
    const groups = [report.baseline.checks, ...report.attempts.map((attempt: any) => attempt.checks), ...(report.integrationChecks ?? []).map((entry: any) => entry.checks), ...(report.mergedChecks ? [report.mergedChecks] : [])]
    expect(groups).toHaveLength(stop)
    groups.forEach((checks: any[], index: number) => {
      expect(checks).toHaveLength(1)
      expect(checks[0].timedOut).toBe(index === stop - 1)
      if (index === stop - 1) expect(checks[0]).toMatchObject({ passed: false, closeReason: 'timeout' })
      else expect(checks[0]).toMatchObject({ code: index === 0 ? 23 : 0, passed: index !== 0 })
    })
    expect(report.error.message).toContain('SELF_HOST_FIXED_CHECK_TIMEOUT')
    const expectedStages = ['baseline_checks', 'candidate_checks', 'integration_checks', 'project_checks'].slice(0, stop)
    expect(report.stages.filter((entry: any) => ['baseline_checks', 'candidate_checks', 'integration_checks', 'project_checks'].includes(entry.name) && entry.state === 'started').map((entry: any) => entry.name)).toEqual(expectedStages)
    expect(mergeCalls).toBe(stop >= 3 ? 1 : 0)
    if(phase==='baseline') {
      expect(requests).toEqual([])
      expect(report.attempts).toEqual([])
      expect(report.conversationId).toBe(null)
      expect(closed).toBe(0)
    } else {
      expect(requests.filter(url => url === '/api/conversations')).toHaveLength(1)
      expect(requests.filter(url => url.endsWith('/messages'))).toHaveLength(1)
      expect(report.conversationId).toBe('conv')
      expect(report.runId).toBe('run')
      expect(closed).toBeGreaterThan(0)
    }
    if(phase==='project') { expect(report.delivery).toMatchObject({merge:'merged',validation:'project_failed'});expect(await readFile(join(cwd,'applied'),'utf8')).toBe('yes') }
    else { expect(report.delivery.merge).not.toBe('merged');await expect(readFile(join(cwd,'applied'))).rejects.toMatchObject({code:'ENOENT'}) }
  } finally { await owned.cleanup() }
})

it('rejects an engine without the internal-data guard before any HTTP request', async () => {
  const f = await fixture(), calls: string[] = []
  await writeFile(f.module, (await readFile(f.module, 'utf8')).replace('static selfHostInternalDataBoundary = 1;', ''))
  const invoke = selectInvoker({ transport: 'h5', cliEntry: f.entry, http: { request: async (url: string) => { calls.push(url); return {} } } })
  await expect(invoke({ cwd: f.cwd, dataDir: f.data, prompt: 'repair' })).rejects.toThrow('SELF_HOST_INTERNAL_DATA_BOUNDARY_UNSUPPORTED')
  expect(calls).toEqual([])
})

it('rejects an old H5 service before creating a project or conversation', async () => {
  const f = await fixture(), calls: string[] = []
  const invoke = selectInvoker({ transport: 'h5', cliEntry: f.entry, http: { request: async (url: string) => {
    calls.push(url); return url === '/api/session' ? { capabilities: { selfHostExternalValidation: 1 } } : { ok: true }
  } } })
  await expect(invoke({ cwd: f.cwd, dataDir: f.data, prompt: 'repair' })).rejects.toThrow('SELF_HOST_INTERNAL_DATA_BOUNDARY_UNSUPPORTED')
  expect(calls).toEqual(['/api/session/local', '/api/session'])
})
