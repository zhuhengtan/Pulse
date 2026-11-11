import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { inspectStableEngine, main, selectInvoker } from '../scripts/self-host.mjs'
import { createSnapshot, snapshotRuntimeDigest } from '../scripts/self-host-snapshot.mjs'

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
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

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
  const f = await fixture(), cwd = await realpath(f.cwd), candidate = join(f.root, 'candidate'), output = join(f.root, 'report')
  await mkdir(candidate)
  await put(join(f.data, 'conversations/conv/runs/run/task-outcome.json'), JSON.stringify({ status: 'accepted' }))
  const task = await put(join(f.root, 'task.txt'), 'fixture'), counter = join(f.root, 'count')
  const stop = ['baseline', 'candidate', 'integration', 'project'].indexOf(phase) + 1
  const check = await put(join(f.root, 'check.mjs'), `import{existsSync,readFileSync,writeFileSync}from'node:fs';const file=${JSON.stringify(counter)};const n=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1;writeFileSync(file,String(n));if(n===${stop}){setInterval(()=>{},1000)}else process.exit(n===1?23:0)`)
  const checks = await put(join(f.root, 'checks.json'), JSON.stringify([[process.execPath, check]]))
  let requests = 0
  class Manager {
    static selfHostBeforeApply = 1
    static selfHostInternalDataBoundary = 1
    async get() { return { conversationId: 'conv', projectRoot: cwd, worktreeRoot: candidate, projectSubdirectory: '', status: 'pending', kind: 'git' } }
    async close() {}
    async finishVerified(_id: string, validate: (cwd: string) => Promise<void>, options: {beforeApply: () => void}) {
      await validate(candidate); options.beforeApply(); await writeFile(join(cwd, 'applied'), 'yes'); return { status: 'merged' }
    }
  }
  const code = await main(['--cwd',cwd,'--data-dir',f.data,'--cli-entry',f.entry,'--transport','h5','--task-file',task,'--checks-file',checks,'--output',output,'--max-attempts','1','--timeout-ms','200'], {
    importModule: async () => ({ H5WorkspaceManager: Manager }), log: () => {},
    http: { request: async (url: string) => {
      requests++
      if(url==='/api/session/local')return{ok:true};if(url==='/api/session')return{capabilities:{selfHostExternalValidation:1,selfHostInternalDataBoundary:1}}
      if(url==='/api/projects')return[{id:'project',cwd}];if(url==='/api/conversations')return{id:'conv'}
      if(url.endsWith('/messages'))return{runId:'run'};if(url.endsWith('/state'))return{state:'succeeded'};return{ok:true}
    } },
  })
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  expect(code).toBe(5); expect(report).toMatchObject({status:'timeout',ok:false})
  if(phase==='baseline')expect(requests).toBe(0)
  if(phase==='project') { expect(report.delivery).toMatchObject({merge:'merged',validation:'project_failed'});expect(await readFile(join(cwd,'applied'),'utf8')).toBe('yes') }
  else { expect(report.delivery.merge).not.toBe('merged');await expect(readFile(join(cwd,'applied'))).rejects.toMatchObject({code:'ENOENT'}) }
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
