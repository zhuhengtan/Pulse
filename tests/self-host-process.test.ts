// scripts/self-host.mjs 的进程级回归：不联网、不读写真实 Pulse 任务数据。
// 只验证两件事：
//   1) installSignalHandlers 返回的清理函数只回收自己注册的监听器与定时器，
//      调用者自己注册的同名监听器必须保留；
//   2) 真实启动脚本，在固定检查期间收到 SIGINT/SIGTERM 时绝不报告成功。
// 所有 fixture 都建在自己的 mkdtemp 临时目录里。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { installSignalHandlers } from '../scripts/self-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF_HOST = path.resolve(HERE, '..', 'scripts', 'self-host.mjs')
const NODE = process.execPath

const write = (file, content) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

const newRoot = (tag) => mkdtempSync(path.join(tmpdir(), `pulse-selfhost-signal-${tag}-`))

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const waitForFile = async (file, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

describe('installSignalHandlers 清理只回收自身注册的资源', () => {
  it('清理函数保留调用者监听器，只移除自己注册的信号监听', () => {
    const signals = ['SIGINT', 'SIGTERM']
    const caller = () => {}
    for (const signal of signals) process.on(signal, caller)
    const before = signals.map((signal) => process.listenerCount(signal))

    const cleanup = installSignalHandlers({ signals, graceMs: 5, hardExitMs: 50 })
    const during = signals.map((signal) => process.listenerCount(signal))
    cleanup()
    const after = signals.map((signal) => process.listenerCount(signal))
    const callerAlive = signals.map((signal) => process.listeners(signal).includes(caller))

    for (const signal of signals) process.removeListener(signal, caller)

    // 安装时每条信号恰好 +1，清理后必须精确回到安装前的计数。
    expect(during).toEqual(before.map((count) => count + 1))
    expect(after).toEqual(before)
    expect(callerAlive).toEqual([true, true])
  })

  it('触发中断后再清理：自身监听器移除、定时器清除（否则硬退出兜底会杀掉进程）', () => {
    const root = newRoot('cleanup')
    // 独立子进程执行：模块级 interruptSignal 无法重置，同进程重复触发会互相污染。
    const probe = write(
      path.join(root, 'probe.mjs'),
      [
        `import { installSignalHandlers, interruptState } from ${JSON.stringify(SELF_HOST)}`,
        'const caller = () => {}',
        "process.on('SIGINT', caller)",
        "const before = process.listenerCount('SIGINT')",
        "const cleanup = installSignalHandlers({ signals: ['SIGINT'], graceMs: 20, hardExitMs: 200 })",
        "const during = process.listenerCount('SIGINT')",
        "const listeners = process.listeners('SIGINT')",
        '// 直接触发自身注册的那一个监听器：记录中断并排上 grace/hard 两个定时器。',
        'listeners[listeners.length - 1]()',
        'const signaled = interruptState()',
        'cleanup()',
        "const after = process.listenerCount('SIGINT')",
        "const callerAlive = process.listeners('SIGINT').includes(caller)",
        "process.stdout.write(JSON.stringify({ before, during, after, callerAlive, signaled }) + '\\n')",
        '// 活过硬退出兜底时限：定时器没被清理时这里根本走不到。',
        "setTimeout(() => { process.stdout.write('SURVIVED\\n') }, 400)",
        '',
      ].join('\n'),
    )

    const res = spawnSync(NODE, [probe], { encoding: 'utf8', timeout: 20000 })
    const lines = String(res.stdout || '').trim().split('\n')
    const info = JSON.parse(lines[0])

    expect(res.status).toBe(0)
    expect(info.signaled).toBe('SIGINT')
    expect(info.during).toBe(info.before + 1)
    expect(info.after).toBe(info.before)
    expect(info.callerAlive).toBe(true)
    expect(String(res.stdout)).toContain('SURVIVED')
  })
})

/**
 * 真实脚本 fixture：基线检查立刻失败，本轮检查在窗口内通过。
 * 信号只在「本轮固定检查已经开始」之后发送，因此一定落在固定检查期间。
 */
const signalFixture = (tag) => {
  const root = newRoot(tag)
  const cwd = path.join(root, 'workspace')
  const dataDir = path.join(root, 'data')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const outDir = path.join(root, 'out')
  const taskFile = write(path.join(root, 'task.txt'), '修复 fixture 里的缺陷\n')
  const checksFile = path.join(root, 'checks.json')
  const marker = path.join(root, 'check-started')
  const counter = path.join(root, 'check-count')
  const check = write(
    path.join(root, 'checks', 'slow-pass.mjs'),
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      `const counter = ${JSON.stringify(counter)}`,
      'let round = 0',
      "if (existsSync(counter)) round = Number(readFileSync(counter, 'utf8')) || 0",
      'round += 1',
      'writeFileSync(counter, String(round))',
      '// 第 1 次是基线检查：立刻失败，把信号窗口留给本轮真实检查。',
      'if (round === 1) process.exit(1)',
      '// 本轮检查：忽略监督进程的宽限 SIGTERM，在 SIGKILL 之前正常通过。',
      "process.on('SIGTERM', () => {})",
      `writeFileSync(${JSON.stringify(marker)}, 'started\\n')`,
      'setTimeout(() => process.exit(0), 400)',
      '',
    ].join('\n'),
  )
  writeFileSync(checksFile, JSON.stringify([[NODE, check]]), 'utf8')
  const engineEntry = write(
    path.join(root, 'engine', 'fake-engine.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      "import { fileURLToPath } from 'node:url'",
      "import path from 'node:path'",
      'const here = path.dirname(fileURLToPath(import.meta.url))',
      "writeFileSync(path.join(here, 'ready'), 'ready\\n')",
      'process.stdout.write(JSON.stringify({',
      "  type: 'result',",
      "  status: 'succeeded',",
      "  conversationId: 'fixture-conv',",
      "  taskOutcome: { status: 'accepted' },",
      "}) + '\\n')",
      '',
    ].join('\n'),
  )
  return { root, cwd, dataDir, outDir, taskFile, checksFile, marker, engineEntry }
}

const runUntilCheckWindowThenSignal = async (fixture, signal) => {
  const argv = [
    '--task-file', fixture.taskFile,
    '--checks-file', fixture.checksFile,
    '--cwd', fixture.cwd,
    '--data-dir', fixture.dataDir,
    '--output', fixture.outDir,
    '--cli-entry', fixture.engineEntry,
    '--max-attempts', '1',
  ]
  const child = spawn(NODE, [SELF_HOST, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const closed = new Promise((resolve) => {
    child.on('close', (code, sig) => resolve({ code, sig }))
  })

  const started = await waitForFile(fixture.marker, 20000)
  if (!started) {
    child.kill('SIGKILL')
    const info = await closed
    throw new Error(`固定检查窗口未出现（code=${info.code}, signal=${info.sig}）：${stdout}${stderr}`)
  }
  child.kill(signal)
  const info = await closed
  const reportFile = path.join(fixture.outDir, 'report.json')
  return {
    code: info.code,
    sig: info.sig,
    stdout,
    stderr,
    report: existsSync(reportFile) ? readJson(reportFile) : null,
  }
}

describe('真实启动脚本：固定检查期间收到中断不得报告成功', () => {
  it('SIGINT：退出码非 0，report.ok=false 且 status 不是 success', async () => {
    const fixture = signalFixture('sigint')
    const run = await runUntilCheckWindowThenSignal(fixture, 'SIGINT')

    expect(run.report).not.toBeNull()
    expect(run.code).not.toBe(0)
    expect(run.report.ok).toBe(false)
    expect(run.report.status).not.toBe('success')
    expect(run.report.exitCode).toBe(run.code)
    // 本轮真实检查本身是通过的，所以非成功只能来自中断，而不是检查失败。
    const attempts = Array.isArray(run.report.attempts) ? run.report.attempts : []
    expect(attempts.length).toBe(1)
    expect(attempts[0].checks.every((item) => item.passed === true)).toBe(true)
  }, 40000)

  it('SIGTERM：退出码非 0，report.ok=false 且 status 不是 success', async () => {
    const fixture = signalFixture('sigterm')
    const run = await runUntilCheckWindowThenSignal(fixture, 'SIGTERM')

    expect(run.report).not.toBeNull()
    expect(run.code).not.toBe(0)
    expect(run.report.ok).toBe(false)
    expect(run.report.status).not.toBe('success')
    expect(run.report.exitCode).toBe(run.code)
    const attempts = Array.isArray(run.report.attempts) ? run.report.attempts : []
    expect(attempts.length).toBe(1)
    expect(attempts[0].checks.every((item) => item.passed === true)).toBe(true)
  }, 40000)
})
