// H5 候选目录定位 + 精确 run 验收的独立离线回归。
// 只用假 workspace manager、假 HTTP 与 mkdtemp 临时目录：不联网、不调用真实 Provider，
// 也不读写真实 Pulse 任务数据。本文件不修改 tests/self-host-main.test.ts。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createH5EngineInvoker, main, locateWorkspace, readTaskOutcomeFile, resolveRecordCwd, selectInvoker } from '../scripts/self-host.mjs'

const newRoot = (tag) => mkdtempSync(path.join(tmpdir(), `pulse-h5-ws-${tag}-`))
const real = (target) => realpathSync(target)

// project/pkg/app 是原目录；worktrees/conv-1/pkg/app 才是本次会话的候选目录。
const makeFixture = (tag, options = {}) => {
  const withCandidate = options.withCandidate !== false
  const root = newRoot(tag)
  const subdirectory = path.join('pkg', 'app')
  const projectRoot = path.join(root, 'project')
  const worktreeRoot = path.join(root, 'worktrees', 'conv-1')
  const targetCwd = path.join(projectRoot, subdirectory)
  const candidateCwd = path.join(worktreeRoot, subdirectory)
  mkdirSync(targetCwd, { recursive: true })
  if (withCandidate) mkdirSync(candidateCwd, { recursive: true })
  else mkdirSync(path.join(worktreeRoot, 'pkg'), { recursive: true })
  const dataDir = path.join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const cliEntry = path.join(root, 'cli', 'pulse.mjs')
  mkdirSync(path.dirname(cliEntry), { recursive: true })
  writeFileSync(cliEntry, '// 假稳定 cli entry\n', 'utf8')
  const record = {
    schemaVersion: 1,
    kind: 'git',
    conversationId: 'conv-1',
    projectId: 'proj-1',
    projectRoot,
    worktreeRoot,
    projectSubdirectory: subdirectory,
    baselineCommit: 'deadbeef',
    status: 'running',
  }
  return { root, subdirectory, projectRoot, worktreeRoot, targetCwd, candidateCwd, dataDir, cliEntry, record }
}

// 假 H5WorkspaceManager：close 计数用于「无论成败都必须 close」断言。
const fakeManager = (behavior = {}) => {
  const state = { gets: 0, finishes: 0, closes: 0, dataDirs: [], ids: [] }
  class FakeH5WorkspaceManager {
    constructor(dataDir) {
      state.dataDirs.push(dataDir)
    }
    async get(conversationId) {
      state.gets += 1
      state.ids.push(conversationId)
      if (behavior.getThrows) throw new Error('fake get failure')
      return behavior.record
    }
    async finish() {
      state.finishes += 1
      return behavior.finish || { status: 'merged' }
    }
    async close() {
      state.closes += 1
    }
  }
  return { state, importModule: async () => ({ H5WorkspaceManager: FakeH5WorkspaceManager }) }
}

// 假 HTTP：只覆盖 H5 建会话/启动/轮询所需端点，绝不联网。
const fakeHttp = (cwd, calls = []) => ({
  request: async (target, init = {}) => {
    const pathname = String(target).split('?')[0]
    const method = init.method || 'GET'
    calls.push({ path: pathname, method, body: init.body || null })
    if (pathname === '/api/session/local' && method === 'POST') return { ok: true }
    if (pathname === '/api/projects' && method === 'GET') return [{ id: 'proj-1', name: 'fixture', cwd, pinned: false }]
    if (pathname === '/api/conversations' && method === 'POST') return { id: 'conv-1' }
    if (pathname === '/api/conversations/conv-1' && method === 'PATCH') return { ok: true }
    if (pathname === '/api/conversations/conv-1/messages' && method === 'POST') return { runId: 'run-1' }
    if (pathname === '/api/runs/run-1/state') return { state: 'succeeded' }
    throw new Error(`假适配器未覆盖 ${method} ${pathname}`)
  },
})

const h5Invoker = (fixture, manager, calls) =>
  selectInvoker({
    transport: 'h5',
    cliEntry: fixture.cliEntry,
    apiBase: 'http://127.0.0.1:9',
    uiBase: 'http://127.0.0.1:9',
    http: fakeHttp(fixture.targetCwd, calls),
    importModule: manager.importModule,
    log: () => {},
  })

describe('候选目录只来自 manager.get 的精确记录', () => {
  it('running 用 worktreeRoot+子目录，候选与原目录不同', () => {
    const f = makeFixture('running')
    for (const status of ['running', 'pending']) {
      const resolved = resolveRecordCwd({ ...f.record, status }, { conversationId: 'conv-1', cwd: f.targetCwd })
      expect(resolved.ok).toBe(true)
      expect(real(resolved.cwd)).toBe(real(f.candidateCwd))
      expect(real(resolved.cwd)).not.toBe(real(f.targetCwd))
      expect(resolved.isolated).toBe(true)
      expect(resolved.status).toBe(status)
    }
  })

  it('merged/noop/shared 用经核对的原目录，isolated=false', () => {
    const f = makeFixture('merged')
    for (const status of ['merged', 'noop', 'shared']) {
      const resolved = resolveRecordCwd({ ...f.record, status }, { conversationId: 'conv-1', cwd: f.targetCwd })
      expect(resolved.ok).toBe(true)
      expect(real(resolved.cwd)).toBe(real(f.targetCwd))
      expect(resolved.isolated).toBe(false)
    }
  })

  it('符号链接逃逸 worktree 的候选目录被拒绝', () => {
    const f = makeFixture('escape', { withCandidate: false })
    const outside = path.join(f.root, 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, f.candidateCwd, 'dir')
    const resolved = resolveRecordCwd(f.record, { conversationId: 'conv-1', cwd: f.targetCwd })
    expect(resolved.ok).toBe(false)
    expect(resolved.error).toBe('WORKSPACE_CANDIDATE_ESCAPES_WORKTREE')
  })

  it('候选目录不存在时不通过', () => {
    const f = makeFixture('absent', { withCandidate: false })
    const resolved = resolveRecordCwd(f.record, { conversationId: 'conv-1', cwd: f.targetCwd })
    expect(resolved.ok).toBe(false)
    expect(resolved.error).toBe('WORKSPACE_CANDIDATE_UNAVAILABLE')
  })

  it('未知 status 一律拒绝，kind=shared 不能绕过', () => {
    const f = makeFixture('unknown')
    const cases = [
      { ...f.record, status: 'paused' },
      { ...f.record, status: 'paused', kind: 'shared' },
      { ...f.record, status: undefined, kind: 'shared' },
      { ...f.record, status: 'merging' },
    ]
    for (const record of cases) {
      const resolved = resolveRecordCwd(record, { conversationId: 'conv-1', cwd: f.targetCwd })
      expect(resolved.ok).toBe(false)
      expect(String(resolved.error)).toMatch(/^WORKSPACE_STATUS_UNKNOWN:/)
    }
  })

  it('conversationId 或项目目录不一致时不得当成原目录成功', () => {
    const f = makeFixture('mismatch')
    const otherConversation = resolveRecordCwd(f.record, { conversationId: 'conv-2', cwd: f.targetCwd })
    expect(otherConversation.ok).toBe(false)
    expect(otherConversation.error).toBe('WORKSPACE_CONVERSATION_MISMATCH')
    const otherProject = resolveRecordCwd(f.record, { conversationId: 'conv-1', cwd: path.join(f.root, 'elsewhere') })
    expect(otherProject.ok).toBe(false)
    expect(otherProject.error).toBe('WORKSPACE_PROJECT_MISMATCH')
  })
})

describe('H5 验收只认本次 run 的 task-outcome.json', () => {
  it('精确 run 文件为唯一来源，无 runId 字段也支持', async () => {
    const f = makeFixture('outcome')
    const runDir = (runId) => {
      const dir = path.join(f.dataDir, 'conversations', 'conv-1', 'runs', runId)
      mkdirSync(dir, { recursive: true })
      return dir
    }
    writeFileSync(path.join(runDir('run-1'), 'task-outcome.json'), JSON.stringify({ status: 'accepted' }), 'utf8')
    writeFileSync(path.join(runDir('run-2'), 'task-outcome.json'), JSON.stringify({ runId: 'run-2', status: 'accepted' }), 'utf8')
    writeFileSync(path.join(runDir('run-3'), 'task-outcome.json'), JSON.stringify({ runId: 'run-9', status: 'accepted' }), 'utf8')

    const exact = await readTaskOutcomeFile({ dataDir: f.dataDir, conversationId: 'conv-1', runId: 'run-1' })
    expect(exact && exact.outcome).toBe('accepted')
    expect(exact && exact.path).toBe(path.join(f.dataDir, 'conversations', 'conv-1', 'runs', 'run-1', 'task-outcome.json'))

    // 缺失的本次 run 不得用别的 run 的 accepted 顶上。
    expect(await readTaskOutcomeFile({ dataDir: f.dataDir, conversationId: 'conv-1', runId: 'run-4' })).toBe(null)
    // runId 字段与请求不一致时拒绝。
    expect(await readTaskOutcomeFile({ dataDir: f.dataDir, conversationId: 'conv-1', runId: 'run-3' })).toBe(null)
  })
})

describe('locateWorkspace 与 H5 传输的候选目录接线', () => {
  it('成功时给出候选目录并关闭 manager', async () => {
    const f = makeFixture('locate')
    const manager = fakeManager({ record: f.record })
    const located = await locateWorkspace({
      cliEntry: f.cliEntry,
      dataDir: f.dataDir,
      conversationId: 'conv-1',
      cwd: f.targetCwd,
      importModule: manager.importModule,
    })
    expect(located.ok).toBe(true)
    expect(real(located.cwd)).toBe(real(f.candidateCwd))
    expect(real(located.cwd)).not.toBe(real(f.targetCwd))
    expect(located.isolated).toBe(true)
    expect(manager.state.ids).toEqual(['conv-1'])
    expect(manager.state.dataDirs).toEqual([f.dataDir])
    expect(manager.state.closes).toBe(1)
  })

  it('记录缺失、conversationId 不符、get 抛错都必须关闭 manager 且不成功', async () => {
    const f = makeFixture('locate-fail')
    const missing = fakeManager({ record: undefined })
    const none = await locateWorkspace({
      cliEntry: f.cliEntry,
      dataDir: f.dataDir,
      conversationId: 'conv-1',
      cwd: f.targetCwd,
      importModule: missing.importModule,
    })
    expect(none.ok).toBe(false)
    expect(none.error).toBe('WORKSPACE_RECORD_MISSING')
    expect(missing.state.closes).toBe(1)

    const other = fakeManager({ record: { ...f.record, conversationId: 'conv-2' } })
    const mismatch = await locateWorkspace({
      cliEntry: f.cliEntry,
      dataDir: f.dataDir,
      conversationId: 'conv-1',
      cwd: f.targetCwd,
      importModule: other.importModule,
    })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.error).toBe('WORKSPACE_CONVERSATION_MISMATCH')
    expect(other.state.closes).toBe(1)

    const throwing = fakeManager({ getThrows: true })
    await expect(
      locateWorkspace({
        cliEntry: f.cliEntry,
        dataDir: f.dataDir,
        conversationId: 'conv-1',
        cwd: f.targetCwd,
        importModule: throwing.importModule,
      }),
    ).rejects.toThrow('fake get failure')
    expect(throwing.state.closes).toBe(1)
  })

  it('定位失败时 workspace 为 null，绝不回落到原目录', async () => {
    const f = makeFixture('invoke')
    const missing = fakeManager({ record: undefined })
    const calls = []
    const invoker = h5Invoker(f, missing, calls)
    const engine = await invoker({ prompt: 'fixture', cwd: f.targetCwd, dataDir: f.dataDir, timeoutMs: 30_000, log: () => {} })
    expect(engine.workspace).toBe(null)
    expect(engine.workspaceError).toBe('WORKSPACE_RECORD_MISSING')
    expect(engine.workspaceIsolated).toBe(false)
    expect(missing.state.closes).toBe(1)
    // 认证仍必须早于查项目。
    expect(calls[0]).toEqual({ path: '/api/session/local', method: 'POST', body: null })
    expect(calls[1].path).toBe('/api/projects')
  })

  it('成功时把候选目录与状态交给 main', async () => {
    const f = makeFixture('invoke-ok')
    const manager = fakeManager({ record: f.record })
    const calls = []
    const invoker = h5Invoker(f, manager, calls)
    const engine = await invoker({ prompt: 'fixture', cwd: f.targetCwd, dataDir: f.dataDir, timeoutMs: 30_000, log: () => {} })
    expect(engine.workspace).toBeTruthy()
    expect(real(engine.workspace)).toBe(real(f.candidateCwd))
    expect(engine.workspaceStatus).toBe('running')
    expect(engine.workspaceIsolated).toBe(true)
    expect(engine.workspaceError).toBe(null)
    expect(manager.state.closes).toBe(1)
  })
})

describe('合入失败不得判定 success', () => {
  it('conflict 合入返回 merged=false 且始终关闭 manager', async () => {
    const f = makeFixture('finalize-conflict')
    const manager = fakeManager({ record: f.record, finish: { status: 'conflict', conflictPaths: ['pkg/app/a.ts'] } })
    const calls = []
    const invoker = h5Invoker(f, manager, calls)
    const engine = await invoker({ prompt: 'fixture', cwd: f.targetCwd, dataDir: f.dataDir, timeoutMs: 30_000, log: () => {} })
    const finalized = await invoker.finalize({
      conversationId: 'conv-1',
      runId: 'run-1',
      workspace: engine.workspace,
      cwd: f.targetCwd,
      dataDir: f.dataDir,
    })
    expect(finalized.merged).toBe(false)
    expect(finalized.status).toBe('conflict')
    expect(manager.state.finishes).toBe(1)
    expect(manager.state.closes).toBe(2)
  })

  it('候选目录与记录不一致时不合入，正常合入才 merged=true', async () => {
    const f = makeFixture('finalize')
    const manager = fakeManager({ record: f.record, finish: { status: 'merged' } })
    const calls = []
    const invoker = h5Invoker(f, manager, calls)
    const engine = await invoker({ prompt: 'fixture', cwd: f.targetCwd, dataDir: f.dataDir, timeoutMs: 30_000, log: () => {} })

    const mismatch = await invoker.finalize({
      conversationId: 'conv-1',
      runId: 'run-1',
      workspace: f.targetCwd,
      cwd: f.targetCwd,
      dataDir: f.dataDir,
    })
    expect(mismatch.merged).toBe(false)
    expect(mismatch.error).toBe('WORKSPACE_CANDIDATE_MISMATCH')
    expect(manager.state.finishes).toBe(0)

    const merged = await invoker.finalize({
      conversationId: 'conv-1',
      runId: 'run-1',
      workspace: engine.workspace,
      cwd: f.targetCwd,
      dataDir: f.dataDir,
    })
    expect(merged.merged).toBe(true)
    expect(manager.state.finishes).toBe(1)
    expect(manager.state.closes).toBe(3)
  })
})

it('terminal run wins over stale approval interactions, including --wait-for-human', async () => {
  const f = makeFixture('stale-attention'), calls = []
  const base = fakeHttp(f.targetCwd, calls)
  const http = { request: async (url, init) => url === '/api/runs/run-1/state'
    ? { state: 'succeeded', interactions: [{ type: 'approval', status: 'pending' }] }
    : base.request(url, init) }
  const invoke = createH5EngineInvoker({ http, waitForHuman: true, sleep: async () => { throw new Error('Terminal run must not wait') } })
  const result = await invoke({ cwd: f.targetCwd, prompt: 'fixture', timeoutMs: 2000, log: () => {} })
  expect(result.state).toBe('succeeded')
  expect(result.waiting).toBe(false)
})

it('workspace lookup failures retain the already-created run identity and close the manager', async () => {
  const f = makeFixture('lookup-error'), manager = fakeManager({ getThrows: true }), calls = []
  await expect(h5Invoker(f, manager, calls)({ cwd: f.targetCwd, dataDir: f.dataDir, prompt: 'fixture', timeoutMs: 2000 }))
    .rejects.toMatchObject({ h5Started: true, h5RunId: 'run-1', h5ConversationId: 'conv-1', h5TaskUrl: expect.stringContaining('conv-1') })
  expect(manager.state.closes).toBe(1)
  expect(calls.filter(call => call.path.endsWith('/messages'))).toHaveLength(1)
})

it.each(['accepted', 'incomplete', 'missing', 'lookup-error'])('main checks candidate then merges and rechecks original only with exact accepted outcome (%s)', async outcome => {
  const f = makeFixture(`main-${outcome}`), calls = [], checked = []
  const check = path.join(f.root, 'check.mjs'), checks = path.join(f.root, 'checks.json'), task = path.join(f.root, 'task.txt'), output = path.join(f.root, 'out')
  const trace = path.join(f.root, 'trace.jsonl')
  writeFileSync(check, `import fs from 'node:fs';import path from 'node:path';fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.cwd())+'\\n');process.exit(fs.existsSync(path.join(process.cwd(),'ready'))?0:1)\n`)
  writeFileSync(checks, JSON.stringify([[process.execPath, check]]))
  writeFileSync(task, 'Fixture repair')
  writeFileSync(path.join(f.candidateCwd, 'ready'), 'fixed')
  const runDir = path.join(f.dataDir, 'conversations/conv-1/runs/run-1')
  mkdirSync(runDir, { recursive: true })
  if (outcome !== 'missing') writeFileSync(path.join(runDir, 'task-outcome.json'), JSON.stringify({ status: outcome }))
  let closes = 0, finishes = 0
  class Manager {
    async get() { if (outcome === 'lookup-error') throw new Error('fixture workspace lookup failed'); return f.record }
    async close() { closes++ }
    async finish() { finishes++; writeFileSync(path.join(f.targetCwd, 'ready'), 'fixed'); return { status: 'merged' } }
  }
  const code = await main(['--transport', 'h5', '--cwd', f.targetCwd, '--data-dir', f.dataDir, '--cli-entry', f.cliEntry, '--checks-file', checks, '--task-file', task, '--output', output, '--max-attempts', '1'], {
    http: { request: async (url, init) => url === '/api/runs/run-1/state' ? { state: 'succeeded', taskOutcome: { status: 'accepted' } } : fakeHttp(f.targetCwd, calls).request(url, init) },
    importModule: async () => ({ H5WorkspaceManager: Manager }), log: () => {},
  })
  const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'))
  checked.push(...readFileSync(trace, 'utf8').trim().split('\n').map(line => real(JSON.parse(line))))
  expect(checked).toEqual(outcome === 'accepted' ? [real(f.targetCwd), real(f.candidateCwd), real(f.targetCwd)] : outcome === 'lookup-error' ? [real(f.targetCwd)] : [real(f.targetCwd), real(f.candidateCwd)])
  expect(code).toBe(outcome === 'accepted' ? 0 : outcome === 'lookup-error' ? 2 : 6)
  expect(report.conversationId).toBe('conv-1')
  expect(report.runId).toBe('run-1')
  expect(report.ok).toBe(outcome === 'accepted')
  expect(finishes).toBe(outcome === 'accepted' ? 1 : 0)
  expect(closes).toBe(outcome === 'accepted' ? 2 : 1)
})
