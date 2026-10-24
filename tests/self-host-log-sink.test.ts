// execStream 日志 sink 的独立回归：只用自己的临时 fixture 与假写入故障。
// 不联网、不读写真实 Pulse 任务数据，也不修改既有的 self-host 测试。
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { execStream, runChecks } from '../scripts/self-host.mjs'

const NODE = process.execPath
const original = { openSync: fs.openSync, writeSync: fs.writeSync }
/** 只接管本测试临时目录下 fd 的写入/打开，其它 fd 一律走真实实现。 */
const mutableFs = fs as unknown as {
  openSync: typeof fs.openSync
  writeSync: typeof fs.writeSync
}

const PAYLOAD = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
const PARTIAL_SCRIPT = `process.stdout.write(Buffer.from(${JSON.stringify([...PAYLOAD])}))`
const SINGLE_SCRIPT =
  "process.stdout.write('x'.repeat(1024));process.exitCode=0"
/** 80 次小写入：对应 oracle 里 80 次 EIO -> 80 条记录的无界增长场景。 */
const BURST_SCRIPT =
  "let n=0;const t=setInterval(()=>{process.stdout.write('x'.repeat(256));if(++n===80)clearInterval(t)},4)"

let root = ''
let owned = new Set<number>()
let mode: 'pass' | 'partial' | 'zero' | 'error' = 'pass'
let sinkCalls = 0

const installFakeSink = () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-log-sink-'))
  owned = new Set()
  mode = 'pass'
  sinkCalls = 0
  mutableFs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = (original.openSync as (...a: unknown[]) => number)(target, ...args)
    if (typeof target === 'string' && target.startsWith(root + path.sep)) owned.add(fd)
    return fd
  }) as unknown as typeof fs.openSync
  mutableFs.writeSync = ((
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset?: number,
    length?: number,
    position?: number | null,
  ) => {
    if (!owned.has(fd)) {
      return (original.writeSync as (...a: unknown[]) => number)(fd, buffer, offset, length, position)
    }
    sinkCalls += 1
    if (mode === 'error') throw Object.assign(new Error('OWN_FIXTURE_EIO'), { code: 'EIO' })
    if (mode === 'zero') return 0
    const from = typeof offset === 'number' ? offset : 0
    const size = typeof length === 'number' ? length : buffer.byteLength - from
    const step = mode === 'partial' ? Math.min(7, size) : size
    return (original.writeSync as (...a: unknown[]) => number)(fd, buffer, from, step, position ?? null)
  }) as unknown as typeof fs.writeSync
  syncBuiltinESMExports()
}

beforeEach(() => {
  installFakeSink()
})

afterEach(async () => {
  mutableFs.openSync = original.openSync
  mutableFs.writeSync = original.writeSync
  syncBuiltinESMExports()
  await fsp.rm(root, { recursive: true, force: true })
})

describe('execStream 日志 sink（假写入故障回归）', () => {
  it('部分写入循环补齐原始 Buffer：4096 字节全部落盘', async () => {
    mode = 'partial'
    const file = path.join(root, 'partial.bin')
    const proc = await execStream(NODE, ['-e', PARTIAL_SCRIPT], {
      cwd: root,
      stdoutPath: file,
      timeoutMs: 5000,
      graceMs: 200,
    })
    expect(proc.code).toBe(0)
    expect(proc.streamErrors).toEqual([])
    const actual = await fsp.readFile(file)
    expect(actual.length).toBe(PAYLOAD.length)
    expect(actual.equals(PAYLOAD)).toBe(true)
    // 每次最多 7 字节 -> 必然多次部分写入，证明走的是补齐循环而不是单次调用。
    expect(sinkCalls).toBeGreaterThan(1)
  })

  it('0 字节写入记为明确错误且不空转挂死', async () => {
    mode = 'zero'
    const file = path.join(root, 'zero.bin')
    const guardTimer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('0 写入下 execStream 疑似死循环/挂死')), 4000)
    })
    const proc = await Promise.race([
      execStream(NODE, ['-e', SINGLE_SCRIPT], {
        cwd: root,
        stdoutPath: file,
        timeoutMs: 5000,
        graceMs: 200,
      }),
      guardTimer,
    ])
    expect(proc.streamErrors.length).toBeGreaterThan(0)
    expect(proc.streamErrors.join(' | ')).toMatch(/无进展/)
    // 一个 chunk 只记一次错误，绝不因空转产生海量记录。
    expect(proc.streamErrors.length).toBeLessThanOrEqual(8)
    const actual = await fsp.readFile(file)
    expect(actual.length).toBe(0)
  })

  it('重复 EIO 的错误记录有常量上限且保留错误事实', async () => {
    mode = 'error'
    const file = path.join(root, 'eio.bin')
    const proc = await execStream(NODE, ['-e', BURST_SCRIPT], {
      cwd: root,
      stdoutPath: file,
      timeoutMs: 5000,
      graceMs: 200,
    })
    expect(proc.code).toBe(0)
    expect(sinkCalls).toBeGreaterThan(1)
    // 上限：不得每 chunk 一条无限增长。
    expect(proc.streamErrors.length).toBeGreaterThan(0)
    expect(proc.streamErrors.length).toBeLessThanOrEqual(8)
    // 事实保留：末位汇总记录出真实失败次数（等于本测试的写入尝试次数）。
    expect(proc.streamErrors[proc.streamErrors.length - 1]).toContain(`共 ${sinkCalls} 次`)
  })

  it('runChecks 遇到 streamErrors 不得 passed', async () => {
    mode = 'error'
    const proc = await execStream(NODE, ['-e', SINGLE_SCRIPT], {
      cwd: root,
      stdoutPath: path.join(root, 'runchecks.bin'),
      timeoutMs: 5000,
      graceMs: 200,
    })
    expect(proc.streamErrors.length).toBeGreaterThan(0)
    const checks = await runChecks({
      checks: [[NODE, '-e', 'process.exit(0)']],
      cwd: root,
      exec: async () => proc,
    })
    expect(checks).toHaveLength(1)
    expect(checks[0].passed).toBe(false)
  })

  it('无 streamErrors 的正常写入仍然 passed', async () => {
    const proc = await execStream(NODE, ['-e', "process.stdout.write('ok')"], {
      cwd: root,
      stdoutPath: path.join(root, 'ok.bin'),
      timeoutMs: 5000,
      graceMs: 200,
    })
    expect(proc.streamErrors).toEqual([])
    const checks = await runChecks({
      checks: [[NODE, '-e', 'process.exit(0)']],
      cwd: root,
      exec: async () => proc,
    })
    expect(checks[0].passed).toBe(true)
  })
})
