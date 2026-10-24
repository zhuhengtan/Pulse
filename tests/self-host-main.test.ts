// scripts/self-host.mjs 的离线回归：不联网、不读写真实 Pulse 任务数据。
// 所有 fixture 都建在自己的 mkdtemp 临时目录里，引擎是可读的假 CLI 脚本。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { main } from '../scripts/self-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF_HOST = path.resolve(HERE, '..', 'scripts', 'self-host.mjs')
const NODE = process.execPath

const write = (file, content) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

const newRoot = (tag) => mkdtempSync(path.join(tmpdir(), `pulse-selfhost-${tag}-`))

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * 假引擎：只在自身 fixture 目录写 ready 标记，然后打印一条 result 事件。
 * 它不读也不写调用者的 dataDir，因此结论完全由 taskOutcome 决定。
 */
const fakeEngine = (root, outcome) => {
  const dir = path.join(root, 'engine')
  const ready = path.join(dir, 'ready')
  const entry = write(
    path.join(dir, 'fake-engine.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      "import { fileURLToPath } from 'node:url'",
      "import path from 'node:path'",
      "const here = path.dirname(fileURLToPath(import.meta.url))",
      "writeFileSync(path.join(here, 'ready'), 'ready\\n')",
      "process.stdout.write(JSON.stringify({",
      "  type: 'result',",
      "  status: 'succeeded',",
      "  conversationId: 'fixture-conv',",
      `  taskOutcome: { status: '${outcome}' },`,
      "}) + '\\n')",
      '',
    ].join('\n'),
  )
  return { dir, entry, ready }
}

/** 固定检查：第一次真实退出码 1，第二次真实退出码 0（复现「检查从失败转成功」）。 */
const flipCheck = (root) => {
  const state = path.join(root, 'flip-state')
  const script = write(
    path.join(root, 'checks', 'flip-check.mjs'),
    [
      "import { existsSync, writeFileSync } from 'node:fs'",
      `const state = ${JSON.stringify(state)}`,
      'if (existsSync(state)) process.exit(0)',
      "writeFileSync(state, 'ran\\n')",
      'process.exit(1)',
      '',
    ].join('\n'),
  )
  return { script, state }
}

const fixture = (tag) => {
  const root = newRoot(tag)
  const cwd = path.join(root, 'workspace')
  const dataDir = path.join(root, 'data')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const outDir = path.join(root, 'out')
  const checksFile = path.join(root, 'checks.json')
  const taskFile = write(path.join(root, 'task.txt'), '修复 fixture 里的缺陷\n')
  const writeChecks = (checks) => writeFileSync(checksFile, JSON.stringify(checks), 'utf8')
  return { root, cwd, dataDir, outDir, checksFile, taskFile, writeChecks }
}

describe('scripts/self-host.mjs main 离线回归', () => {
  it('导入模块不运行 main，也不产生任何标准输出', () => {
    const root = newRoot('import')
    const probe = write(path.join(root, 'import-probe.mjs'), `await import(${JSON.stringify(SELF_HOST)})\n`)
    const res = spawnSync(NODE, [probe], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(typeof main).toBe('function')
  })

  it('真实 CLI --help 打印实际帮助文本', () => {
    const out = execFileSync(NODE, [SELF_HOST, '--help'], { encoding: 'utf8' })
    expect(out).toContain('--checks-file')
    expect(out).toContain('--baseline-only')
    expect(out).toContain('成功条件')
  })

  it('负例：taskOutcome=status failed 且检查全绿时不得判定成功', async () => {
    const f = fixture('failed')
    const engine = fakeEngine(f.root, 'failed')
    const flip = flipCheck(f.root)
    f.writeChecks([[NODE, flip.script]])
    const argv = [
      '--task-file', f.taskFile,
      '--checks-file', f.checksFile,
      '--cwd', f.cwd,
      '--data-dir', f.dataDir,
      '--output', f.outDir,
      '--cli-entry', engine.entry,
      '--max-attempts', '1',
    ]
    const code = await main(argv, { log: () => {} })
    const report = readJson(path.join(f.outDir, 'report.json'))
    expect(existsSync(engine.ready)).toBe(true)
    expect(report.attempts.length).toBe(1)
    expect(report.attempts[0].taskOutcome).toBe('failed')
    expect(report.attempts[0].checks.every((item) => item.passed === true)).toBe(true)
    expect(code).not.toBe(0)
    expect(report.exitCode).toBe(code)
    expect(report.status).not.toBe('success')
    expect(report.ok).toBe(false)
  })

  it('负例：--baseline-only 首条检查篡改冻结文件即 3/freeze_tampered，第二条不执行', async () => {
    const f = fixture('tamper')
    const freezeFile = write(path.join(f.root, 'freeze-target.txt'), 'original\n')
    const marker = path.join(f.root, 'second-check-ran')
    const tamper = write(
      path.join(f.root, 'checks', 'first.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(freezeFile)}, 'changed\\n')\n`,
    )
    const restore = write(
      path.join(f.root, 'checks', 'second.mjs'),
      [
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(freezeFile)}, 'original\\n')`,
        `writeFileSync(${JSON.stringify(marker)}, 'ran\\n')`,
        '',
      ].join('\n'),
    )
    f.writeChecks([[NODE, tamper], [NODE, restore]])
    const argv = [
      '--checks-file', f.checksFile,
      '--cwd', f.cwd,
      '--data-dir', f.dataDir,
      '--output', f.outDir,
      '--baseline-only',
      '--freeze-file', freezeFile,
    ]
    const code = await main(argv, { log: () => {} })
    const report = readJson(path.join(f.outDir, 'report.json'))
    expect(code).toBe(3)
    expect(report.exitCode).toBe(3)
    expect(report.status).toBe('freeze_tampered')
    expect(report.ok).toBe(false)
    expect(report.error.kind).toBe('frozen')
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(freezeFile, 'utf8')).toBe('changed\n')
  })

  it('正例：taskOutcome=accepted 且固定检查通过时返回 0/success', async () => {
    const f = fixture('accepted')
    const engine = fakeEngine(f.root, 'accepted')
    const okCheck = write(path.join(f.root, 'checks', 'ok.mjs'), 'process.exit(0)\n')
    f.writeChecks([[NODE, okCheck]])
    const argv = [
      '--task-file', f.taskFile,
      '--checks-file', f.checksFile,
      '--cwd', f.cwd,
      '--data-dir', f.dataDir,
      '--output', f.outDir,
      '--cli-entry', engine.entry,
      '--max-attempts', '1',
    ]
    const code = await main(argv, { log: () => {} })
    const report = readJson(path.join(f.outDir, 'report.json'))
    expect(existsSync(engine.ready)).toBe(true)
    expect(code).toBe(0)
    expect(report.exitCode).toBe(0)
    expect(report.status).toBe('success')
    expect(report.ok).toBe(true)
  })

  it('负例：taskOutcome=incomplete 且检查全绿时同样不得判定成功', async () => {
    const f = fixture('incomplete')
    const engine = fakeEngine(f.root, 'incomplete')
    const flip = flipCheck(f.root)
    f.writeChecks([[NODE, flip.script]])
    const argv = [
      '--task-file', f.taskFile,
      '--checks-file', f.checksFile,
      '--cwd', f.cwd,
      '--data-dir', f.dataDir,
      '--output', f.outDir,
      '--cli-entry', engine.entry,
      '--max-attempts', '1',
    ]
    const code = await main(argv, { log: () => {} })
    const report = readJson(path.join(f.outDir, 'report.json'))
    expect(existsSync(engine.ready)).toBe(true)
    expect(report.attempts[0].taskOutcome).toBe('incomplete')
    expect(report.attempts[0].checks.every((item) => item.passed === true)).toBe(true)
    expect(code).not.toBe(0)
    expect(report.status).not.toBe('success')
    expect(report.ok).toBe(false)
  })
})

// 覆盖清单（对应 scripts/self-host.mjs 四处缺陷的回归）：
// 1. 重复 helper 去重与单一 CLI guard：导入本模块不运行 main，真实 --help 有输出。
// 2. 严格 accepted：failed / incomplete 即固定检查全绿，也不得返回 0/success。
// 3. 基线逐条核冻：--baseline-only 首条检查篡改额外冻结文件即返回 3/freeze_tampered，
//    第二条检查不执行（marker 未生成），冻结文件内容停留在被改写状态。
// 4. 正例：accepted 且固定检查通过时返回 0/success/ok=true。
// 所有 fixture 都建在各自的 mkdtemp 临时目录内，不读写真实 Pulse 任务数据。

// H5 传输离线回归：注入假 HTTP 适配器 + 临时目录，不联网、不访问真实 Provider。
it('H5 离线：认证先于查项目，且只置顶本次新建 conversation', async () => {
  const { createH5EngineInvoker } = await import('../scripts/self-host.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const nodePath = (await import('node:path')).default
  const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pulse-h5-auth-'))
  const calls: Array<{ path: string; method: string; body: unknown; timeout: unknown }> = []
  const http = {
    request: async (target: string, init: { method?: string; body?: unknown; timeout?: number } = {}) => {
      const pathname = String(target).split('?')[0]
      const method = init.method ?? 'GET'
      calls.push({ path: pathname, method, body: init.body ?? null, timeout: init.timeout })
      if (pathname === '/api/session/local' && method === 'POST') return { ok: true, localAdmin: true }
      if (pathname === '/api/projects' && method === 'GET') return [{ id: 'proj-1', name: 'fixture', cwd, pinned: false }]
      if (pathname === '/api/conversations' && method === 'POST') return { id: 'conv-1' }
      if (pathname === '/api/conversations/conv-1' && method === 'PATCH') return { ok: true }
      if (pathname === '/api/conversations/conv-1/messages' && method === 'POST') return { runId: 'run-1' }
      if (pathname === '/api/runs/run-1/state') return { state: 'succeeded' }
      throw new Error(`假适配器未覆盖 ${method} ${pathname}`)
    },
  }
  const invoker = createH5EngineInvoker({ http, sleep: () => Promise.resolve(), pollMs: 1 })
  const result = await invoker({ prompt: 'fixture', cwd, timeoutMs: 60_000, log: () => {} })
  const order = calls.map((call) => `${call.method} ${call.path}`)
  expect(order[0]).toBe('POST /api/session/local')
  expect(order[1]).toBe('GET /api/projects')
  expect(order.indexOf('POST /api/conversations')).toBe(2)
  const pinAt = order.indexOf('PATCH /api/conversations/conv-1')
  expect(pinAt).toBeGreaterThan(order.indexOf('POST /api/conversations'))
  expect(calls[pinAt].body).toEqual({ pinned: true })
  expect(order.some((item) => item.startsWith('PATCH /api/projects'))).toBe(false)
  expect(calls.every((call) => typeof call.timeout === 'number' && Number(call.timeout) > 0 && Number(call.timeout) <= 60_000)).toBe(true)
  expect(result.runId).toBe('run-1')
  expect(result.conversationId).toBe('conv-1')
  expect(result.projectId).toBe('proj-1')
  expect(typeof result.taskUrl).toBe('string')
})

it('H5 离线：认证后总预算耗尽立即停止，不查项目也不建会话', async () => {
  const { createH5EngineInvoker } = await import('../scripts/self-host.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const nodePath = (await import('node:path')).default
  const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pulse-h5-deadline-'))
  const calls: Array<{ path: string; method: string }> = []
  const http = {
    request: async (target: string, init: { method?: string; body?: unknown; timeout?: number } = {}) => {
      const pathname = String(target).split('?')[0]
      const method = init.method ?? 'GET'
      calls.push({ path: pathname, method })
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true }
    },
  }
  const invoker = createH5EngineInvoker({ http, sleep: () => Promise.resolve(), pollMs: 1 })
  let failure: (Error & { h5DeadlineExceeded?: boolean; h5ConnectError?: boolean; h5Started?: boolean }) | null = null
  try {
    await invoker({ prompt: 'fixture', cwd, timeoutMs: 5, log: () => {} })
  } catch (reason) {
    failure = reason as Error & { h5DeadlineExceeded?: boolean; h5ConnectError?: boolean; h5Started?: boolean }
  }
  expect(failure).toBeTruthy()
  expect(failure?.h5DeadlineExceeded).toBe(true)
  expect(failure?.h5ConnectError).not.toBe(true)
  expect(failure?.h5Started).not.toBe(true)
  expect(calls.length).toBe(1)
  expect(calls[0]).toEqual({ path: '/api/session/local', method: 'POST' })
})

it('H5 离线：running 且有 approval interaction 时报告 needs_attention 且不新建第二个任务', async () => {
  const { createH5EngineInvoker } = await import('../scripts/self-host.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const nodePath = (await import('node:path')).default
  const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pulse-h5-attention-'))
  const calls: Array<{ path: string; method: string }> = []
  const http = {
    request: async (target: string, init: { method?: string; body?: unknown; timeout?: number } = {}) => {
      const pathname = String(target).split('?')[0]
      const method = init.method ?? 'GET'
      calls.push({ path: pathname, method })
      if (pathname === '/api/session/local' && method === 'POST') return { ok: true }
      if (pathname === '/api/projects' && method === 'GET') return [{ id: 'proj-1', name: 'fixture', cwd, pinned: false }]
      if (pathname === '/api/conversations' && method === 'POST') return { id: 'conv-1' }
      if (pathname === '/api/conversations/conv-1' && method === 'PATCH') return { ok: true }
      if (pathname === '/api/conversations/conv-1/messages' && method === 'POST') return { runId: 'run-1' }
      if (pathname === '/api/runs/run-1/state') {
        return { state: 'running', interactions: [{ type: 'approval', status: 'pending' }] }
      }
      throw new Error(`假适配器未覆盖 ${method} ${pathname}`)
    },
  }
  const invoker = createH5EngineInvoker({ http, waitForHuman: false, sleep: () => Promise.resolve(), pollMs: 1 })
  const result = await invoker({ prompt: 'fixture', cwd, timeoutMs: 60_000, log: () => {} })
  expect(result.needsAttention).toBe('approval')
  expect(result.waiting).toBe(true)
  expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/conversations').length).toBe(1)
  expect(calls.filter((call) => call.path === '/api/runs/run-1/state').length).toBe(1)
})
