#!/usr/bin/env node
/**
 * self-host.mjs — 用 --cwd 之外的稳定 Pulse 引擎修复工作区，再由外部「原始检查命令」验收。
 *
 * 编排边界：
 *  - 只编排：调用稳定引擎、原样执行外部检查 argv、把真实退出码与日志当作数据送回同一任务。
 *  - 冻结身份：task / checks / 额外 freeze-file 在开始即固定「路径身份 + 内容哈希」；
 *    每轮引擎进程与每条检查结束后都复核，成功返回前再复核一次。
 *  - 成功门槛：引擎报告的真实任务验收为 accepted **且** 全部固定检查退出码为 0，缺一不可。
 *  - 历史失败只追加不擦除；不自动回答 ask / 审批；不安装、不发布、不启停任何既有服务。
 *  - 不读取也不写入任何配置文件内容（--config 只原样透传给引擎）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, realpathSync, statSync, writeSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 开发版 H5 API 与 UI 的默认基址，可用 --api-base / --ui-base 分别覆盖。 */
export const DEFAULT_API_BASE = 'http://127.0.0.1:7333'
export const DEFAULT_UI_BASE = 'http://127.0.0.1:5174'

/** 内存里每条输出流保留的尾部字符上限；完整内容一律流式落盘。 */
export const TAIL_LIMIT = 64 * 1024

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  freeze: 3,
  engine: 4,
  timeout: 5,
  notAccepted: 6,
  checks: 7,
  waiting: 8,
  baseline: 9,
}

export const STATUS = {
  success: 'success',
  baseline: 'baseline',
  freeze: 'freeze_tampered',
  timeout: 'timeout',
  engine: 'engine_failed',
  checks: 'checks_failed',
  notAccepted: 'not_accepted',
  waiting: 'needs_attention',
  usage: 'usage_error',
  internal: 'internal_error',
}

const USAGE = `self-host.mjs — 用 cwd 之外的稳定 Pulse 引擎修复工作区，外部原始检查命令做验收

用法:
  node scripts/self-host.mjs --task-file <file> --checks-file <file> --cwd <dir> \\
    --cli-entry <file> --data-dir <dir> --output <dir> [选项]

必需:
  --task-file <file>      任务文本（只读，开始即冻结）
  --checks-file <file>    非空 JSON 二维数组，每项一条验收命令 argv，如 [["pnpm","test"]]
  --cwd <dir>             被修复的工作区
  --cli-entry <file>      稳定 Pulse 引擎入口真实路径，必须位于 --cwd 之外
  --data-dir <dir>        调用者已存在的 Pulse 数据目录；本脚本绝不新建第二份
  --output <dir>          report.json / baseline.json 与日志目录

选项:
  --config <file>         原样透传给引擎的 --config 路径（本脚本不读取内容）
  --max-attempts <n>      最多修复轮数，默认 3
  --timeout-ms <n>        单次引擎调用 / 单条检查的超时毫秒，默认 900000
  --freeze-file <file>    额外冻结文件，可重复
  --baseline-only         只跑一次固定检查并记录基线，不调用模型
  --auto-approve          显式开启引擎自动审批；默认关闭（保持人工审批策略）
  --overwrite             允许覆盖 --output 内已有 report.json / baseline.json；默认拒绝覆盖
  --transport <cli|h5>    传输方式；默认 cli。h5 仅在「连接失败且明确未创建任务」时回退 CLI
  --wait-for-human        H5 传输遇到 ask/审批时，在总超时内等待人工处理并继续同一 run
  --api-base <url>        开发版 API 基址，默认 ${DEFAULT_API_BASE}
  --ui-base <url>         开发版 UI 基址，默认 ${DEFAULT_UI_BASE}
  --project-id <id>       指定 Pulse 项目；缺省时按 --cwd 匹配
  --help                  打印本帮助

成功条件: 引擎报告 taskOutcome=accepted 且全部固定检查真实退出码为 0，且冻结身份未被改动。
退出码: 0 成功 | 1 内部错误 | 2 参数错误 | 3 冻结被篡改 | 4 引擎失败
        5 超时 | 6 任务未被 accepted | 7 检查未通过 | 8 需人工处理 | 9 仅基线
`

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export class FreezeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FreezeError'
  }
}

export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 冻结身份必须落在原始字节上：先解 UTF-8 再哈希会把不同的无效字节当成同一内容。 */
export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 有界尾部缓冲：只保留最后 limit 个字符，但完整字节数照实累计。
 * 这是修复「clip 取开头导致最终 result 丢失」的关键——尾部才是最终结论所在。
 */
export function createTailBuffer(limit = TAIL_LIMIT) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TAIL_LIMIT
  let text = ''
  let bytes = 0
  let dropped = 0
  return {
    push(chunk) {
      const value = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      if (!value) return
      bytes += Buffer.byteLength(value, 'utf8')
      text += value
      if (text.length > cap) {
        dropped += text.length - cap
        text = text.slice(text.length - cap)
      }
    },
    get text() {
      return text
    },
    get bytes() {
      return bytes
    },
    get droppedChars() {
      return dropped
    },
  }
}

/** 只截取尾部；用于报告与失败反馈，绝不再从开头截。 */
export function tailClip(text, limit = 4000) {
  const value = typeof text === 'string' ? text : ''
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4000
  if (value.length <= cap) return value
  return `...（前 ${value.length - cap} 字符已省略）\n${value.slice(value.length - cap)}`
}

/**
 * 真实 CLI 的 result.taskOutcome 是对象 { status: 'accepted', ... }（见
 * packages/cli/src/commands/run.ts）。只认字符串会永远验收不到，这里两种形状都读。
 */
export function readTaskOutcome(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    for (const key of ['status', 'outcome']) {
      const item = value[key]
      if (typeof item === 'string' && item.trim()) return item.trim()
    }
  }
  return null
}

/**
 * 组装稳定引擎参数。默认**不加** --auto-approve：
 * 审批策略由调用者显式决定，脚本绝不替人放行。
 */
export function buildEngineArgs({
  mode = 'run',
  prompt = '',
  conversationId = null,
  cwd,
  dataDir,
  configPath = null,
  autoApprove = false,
} = {}) {
  if (!cwd) throw new UsageError('buildEngineArgs 需要 cwd')
  if (!dataDir) throw new UsageError('buildEngineArgs 需要 dataDir')
  const args = [mode]
  if (mode === 'resume') {
    if (!conversationId) throw new UsageError('resume 需要 conversationId')
    args.push(String(conversationId))
  }
  // 调用者的配置与审批策略保持原意：不注入 --no-jarvis，也不替调用者放行审批。
  args.push(prompt, '--cwd', cwd, '--data-dir', dataDir, '--format', 'jsonl')
  if (autoApprove) args.push('--auto-approve')
  if (configPath) args.push('--config', configPath)
  return args
}

/**
 * 一轮是否达标：真实任务验收 accepted **且**全部固定检查真实退出码为 0。
 * 引擎 status=succeeded 但任务未 accepted，一律不算成功。
 */
export function evaluateRound({ engine = null, checks = [] } = {}) {
  const accepted = readTaskOutcome(engine && engine.taskOutcome) === 'accepted'
  const list = Array.isArray(checks) ? checks : []
  const checksOk = list.length > 0 && list.every((item) => item && item.code === 0 && item.timedOut !== true && !item.error)
  return {
    accepted,
    checksOk,
    ok: accepted && checksOk,
    engineStatus: engine && engine.status ? engine.status : null,
    taskOutcome: readTaskOutcome(engine && engine.taskOutcome),
  }
}

/** CLI 传输：stdout 增量喂扫描器（内存常量级），完整字节仍落盘。 */
export function createCliEngineInvoker({ cliEntry, nodePath = process.execPath, exec = execStream } = {}) {
  if (!cliEntry) throw new UsageError('createCliEngineInvoker 需要 cliEntry')
  return async function invokeEngine(request = {}) {
    const scanner = createEventScanner()
    const args = buildEngineArgs(request)
    const proc = await exec(nodePath, [cliEntry, ...args], {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      stdoutPath: request.stdoutPath ?? null,
      stderrPath: request.stderrPath ?? null,
      onStdout: (text) => scanner.push(text),
    })
    const events = scanner.flush()
    return {
      ...proc,
      argv: [nodePath, cliEntry, ...args],
      conversationId: events.conversationId ?? null,
      status: events.status ?? null,
      taskOutcome: readTaskOutcome(events.taskOutcome),
      waiting: events.waiting === true,
      waitingKind: events.waitingKind ?? null,
      events,
    }
  }
}

/**
 * 逐条执行固定检查：原始 argv 原样执行（不改写、不重排、不拼 shell），
 * 记录真实退出码；失败只是数据，绝不为了让检查变绿而改检查。
 */
export async function runChecks({
  checks = [],
  cwd,
  timeoutMs = 900_000,
  outputDir = null,
  labelPrefix = 'check',
  exec = execStream,
} = {}) {
  const list = Array.isArray(checks) ? checks : []
  const results = []
  for (let index = 0; index < list.length; index += 1) {
    const argv = [...list[index]]
    const label = `${labelPrefix}-${index + 1}`
    const proc = await exec(argv[0], argv.slice(1), {
      cwd,
      timeoutMs,
      stdoutPath: outputDir ? path.join(outputDir, `${label}.stdout.log`) : null,
      stderrPath: outputDir ? path.join(outputDir, `${label}.stderr.log`) : null,
    })
    results.push({
      index,
      argv,
      command: argv[0],
      args: argv.slice(1),
      code: proc.code,
      signal: proc.signal ?? null,
      timedOut: proc.timedOut === true,
      error: proc.error ? String(proc.error.message ?? proc.error) : null,
      closeReason: proc.closeReason ?? null,
      stdoutPath: proc.stdoutPath ?? null,
      stderrPath: proc.stderrPath ?? null,
      stdoutTail: tailClip(proc.stdout ?? '', 4000),
      stderrTail: tailClip(proc.stderr ?? '', 4000),
      stdoutBytes: proc.stdoutBytes ?? null,
      stderrBytes: proc.stderrBytes ?? null,
      streamErrors: Array.isArray(proc.streamErrors) ? proc.streamErrors : [],
      // 超时、spawn 错误、被信号终止、日志写盘失败一律不算通过。
      passed:
        proc.code === 0 &&
        proc.timedOut !== true &&
        !proc.error &&
        !proc.signal &&
        proc.closeReason !== 'spawn-error' &&
        (Array.isArray(proc.streamErrors) ? proc.streamErrors : []).length === 0,
    })
  }
  return results
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 规范化基址：必须是 http(s)，去掉尾部斜杠。 */
export function normalizeBase(value, fallback) {
  const raw = String(value ?? fallback ?? '').trim()
  if (!raw) throw new UsageError('URL 基址不能为空')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new UsageError(`URL 无效: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError(`URL 必须是 http(s): ${raw}`)
  return raw.replace(/\/+$/, '')
}

/**
 * 可点击任务地址。API 基址与 UI 基址是两套东西：API 用于创建/跟踪，
 * 链接必须用 UI 基址拼，单独给 --ui-base 时也只影响这里。
 */
export function formatTaskUrl({ uiBase = DEFAULT_UI_BASE, projectId = null, conversationId = null } = {}) {
  if (!conversationId) return null
  const base = normalizeBase(uiBase, DEFAULT_UI_BASE)
  // 前端路由只认路径（packages/web/src/routing.ts 会过滤掉 /?conversation=<id>），
  // 所以任务链接必须是 /work/<encodeURIComponent(id)>，否则点开是空对话。
  const url = new URL(`${base}/work/${encodeURIComponent(String(conversationId))}`)
  if (projectId) url.searchParams.set('project', String(projectId))
  return url.toString()
}
/* ------------------------------------------------------------------ *
 * 参数层：只做解析与校验，不做任何 I/O
 * ------------------------------------------------------------------ */

const BOOLEAN_FLAGS = new Set(['help', 'baseline-only', 'auto-approve', 'overwrite', 'wait-for-human'])

export const VALUED_FLAGS = Object.freeze([
  'task-file', 'checks-file', 'cwd', 'cli-entry', 'config', 'data-dir', 'output',
  'max-attempts', 'timeout-ms', 'freeze-file', 'transport', 'api-base', 'ui-base', 'project-id',
])

export function parseArgs(argv) {
  const valued = new Set(VALUED_FLAGS)
  const opts = { 'freeze-file': [] }
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (typeof raw !== 'string' || !raw.startsWith('--')) throw new UsageError(`无法识别的参数: ${raw}`)
    let key = raw.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    if (BOOLEAN_FLAGS.has(key)) {
      if (value !== undefined) throw new UsageError(`--${key} 是开关，不接受取值`)
      opts[key] = true
      continue
    }
    if (!valued.has(key)) throw new UsageError(`未知选项: --${key}`)
    if (value === undefined) {
      i += 1
      if (i >= argv.length) throw new UsageError(`--${key} 缺少取值`)
      value = argv[i]
    }
    if (key === 'freeze-file') opts[key].push(value)
    else opts[key] = value
  }
  return opts
}

export function intOption(opts, key, fallback) {
  const raw = opts[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new UsageError(`--${key} 必须是正整数，当前: ${raw}`)
  return value
}

/** checks 原样保存：脚本只按原 argv 执行，不解释、不改写、不重排、不"修好"。 */
export function parseChecks(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new UsageError(`--checks-file 不是合法 JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new UsageError('--checks-file 必须是非空 JSON 二维数组')
  return parsed.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length === 0 || !entry.every((item) => typeof item === 'string' && item !== '')) {
      throw new UsageError(`checks[${index}] 必须是非空的字符串 argv 数组`)
    }
    return [...entry]
  })
}

/** 稳定引擎入口：真实路径且必须在被修复 cwd 之外。 */
export async function resolveCliEntry(entry, cwdReal) {
  let real
  try {
    real = realpathSync(path.resolve(entry))
  } catch {
    throw new UsageError(`--cli-entry 不存在或无法解析: ${entry}`)
  }
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new UsageError(`--cli-entry 不是文件: ${real}`)
  if (isInside(real, cwdReal)) {
    throw new UsageError(`--cli-entry 必须位于 --cwd 之外（实际解析为 ${real}）。请使用稳定安装的 Pulse，而不是候选目录里的 dist。`)
  }
  return real
}

export async function requireDir(target, flag) {
  let real
  try {
    real = realpathSync(path.resolve(target))
  } catch {
    throw new UsageError(`${flag} 目录不存在: ${target}`)
  }
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new UsageError(`${flag} 不是目录: ${real}`)
  return real
}

/* ------------------------------------------------------------------ *
 * 冻结身份：路径身份 + 内容身份
 * ------------------------------------------------------------------ */

export async function freezeMany(files) {
  const frozen = []
  const seen = new Set()
  for (const file of files) {
    const abs = path.resolve(file)
    if (seen.has(abs)) continue
    seen.add(abs)
    let bytes
    try {
      bytes = await fs.readFile(abs)
    } catch (error) {
      throw new UsageError(`无法读取冻结文件 ${abs}: ${error.message}`)
    }
    let real
    try {
      real = realpathSync(abs)
    } catch (error) {
      throw new UsageError(`无法解析冻结文件路径 ${abs}: ${error.message}`)
    }
    frozen.push({ path: abs, realPath: real, hash: hashBuffer(bytes), bytes: bytes.byteLength })
  }
  return frozen
}

/**
 * 内容、路径身份、字节数三项都必须一致。
 * 调用点：每轮开始前、引擎进程结束后、每条检查结束后、成功返回前。
 */
export async function verifyFrozen(frozen, phase) {
  for (const entry of frozen) {
    let bytes
    try {
      bytes = await fs.readFile(entry.path)
    } catch (error) {
      throw new FreezeError(`${phase}：冻结文件不可读 ${entry.path}: ${error.message}`)
    }
    if (hashBuffer(bytes) !== entry.hash) throw new FreezeError(`${phase}：冻结内容被改写 ${entry.path}`)
    if (bytes.byteLength !== entry.bytes) throw new FreezeError(`${phase}：冻结文件字节数变化 ${entry.path}`)
    let real
    try {
      real = realpathSync(entry.path)
    } catch (error) {
      throw new FreezeError(`${phase}：冻结路径无法解析 ${entry.path}: ${error.message}`)
    }
    if (real !== entry.realPath) throw new FreezeError(`${phase}：冻结路径身份被替换 ${entry.path} -> ${real}`)
  }
}
/* ------------------------------------------------------------------
 * 执行层：完整内容流式落盘，内存只保留有界尾部
 * ------------------------------------------------------------------ */

/**
 * 增量事件扫描器：逐块喂入 stdout，只解析完整行，内存常量级。
 * 这样即便输出远超内存上限，末尾的 type=result 依然拿得到——
 * 这正是修复「4MB 截断 + clip 取开头」丢失最终结论的关键。
 */
export function createEventScanner() {
  let pending = ''
  const pendingLimit = 64 * 1024
  const summary = {
    conversationId: null,
    result: null,
    status: null,
    taskOutcome: null,
    waiting: false,
    waitingKind: null,
    runs: [],
    parsedLines: 0,
    unparsedLines: 0,
    oversizedLines: 0,
    droppedChars: 0,
  }

  const ingest = (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      summary.unparsedLines += 1
      return
    }
    if (!event || typeof event !== 'object') {
      summary.unparsedLines += 1
      return
    }
    summary.parsedLines += 1
    if (typeof event.conversationId === 'string' && event.conversationId) summary.conversationId = event.conversationId
    if (typeof event.runId === 'string' && event.runId && !summary.runs.includes(event.runId)) summary.runs.push(event.runId)
    if (event.type === 'result') {
      summary.result = event
      if (typeof event.status === 'string') summary.status = event.status
      // 真实 CLI 的 result.taskOutcome 是对象 { status: 'accepted', ... }，
      // 只接受字符串会永远拿不到验收结论。
      const outcome = readTaskOutcome(event.taskOutcome)
      if (outcome) summary.taskOutcome = outcome
    }
    if (event.type === 'waiting' || event.status === 'waiting' || event.status === 'needs_attention') {
      summary.waiting = true
      summary.waitingKind = typeof event.type === 'string' ? event.type : 'status'
    }
  }

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      if (!text) return
      pending += text
      let index = pending.indexOf('\n')
      while (index >= 0) {
        ingest(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
      // 没有换行的超大输出不能让 pending 无限增长。
      // 超限即整段丢弃，等下一个换行后继续按行解析，末尾的最终 result 依然拿得到。
      if (pending.length > pendingLimit) {
        summary.droppedChars += pending.length
        summary.oversizedLines += 1
        pending = ''
      }
    },
    /** 收尾：把没有换行符的最后一行也当作事件尝试一次。 */
    flush() {
      if (pending) {
        ingest(pending)
        pending = ''
      }
      return summary
    },
    get summary() {
      return summary
    },
  }
}

/**
 * 只清理本次创建的进程组：POSIX 下以 detached 启动的子进程自成一组，
 * kill(-pid) 不会波及调用者或既有服务；Windows 只能退化为直接子进程。
 */
export function killProcessGroup(child, signal) {
  if (!child || typeof child.pid !== 'number') return false
  if (process.platform === 'win32') {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
  try {
    process.kill(-child.pid, signal)
    return true
  } catch {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}

/* ------------------------------------------------------------------
 * 监督进程级信号清理：只回收本进程本次创建的子进程组
 * ------------------------------------------------------------------ */

/** 本次由 execStream 真实 spawn 的子进程；POSIX 下每个子进程自成一个进程组。 */
const ACTIVE_CHILDREN = new Set()
let interruptSignal = null

export function listActiveChildren() {
  return [...ACTIVE_CHILDREN]
}

export function interruptState() {
  return interruptSignal
}

/** detached 子进程自成一组：kill(-pid) 只波及本次创建的进程组。 */
export function killOwnedChildGroups(signal) {
  let count = 0
  for (const child of [...ACTIVE_CHILDREN]) {
    if (killProcessGroup(child, signal)) count += 1
  }
  return count
}

/**
 * 安装 SIGINT/SIGTERM：先记录中断，再在有界宽限内对**本次创建的**进程组
 * SIGTERM → SIGKILL（含忽略 SIGTERM 的孙进程），让 main 自己写完运行报告后以非成功码退出。
 * 只对本进程创建的进程组发信号，绝不波及调用者进程组或既有开发/生产服务。
 */
export function installSignalHandlers({ signals = ['SIGINT', 'SIGTERM'], graceMs = 1_000, hardExitMs = 12_000 } = {}) {
  const registered = []
  const ownedTimers = []
  const handle = (signal) => {
    if (interruptSignal) return
    interruptSignal = signal
    killOwnedChildGroups('SIGTERM')
    const grace = setTimeout(() => killOwnedChildGroups('SIGKILL'), graceMs)
    if (grace && typeof grace.unref === 'function') grace.unref()
    const hard = setTimeout(() => {
      // 兜底：main 未在有界时间内收尾时，仍然只影响本次创建的进程。
      killOwnedChildGroups('SIGKILL')
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
    }, hardExitMs)
    if (hard && typeof hard.unref === 'function') hard.unref()
    ownedTimers.push(grace, hard)
  }
  for (const signal of signals) {
    const listener = () => handle(signal)
    registered.push([signal, listener])
    process.on(signal, listener)
  }
  // 清理函数只注销本次注册的监听器与定时器，调用者自己挂的监听器必须保留。
  return () => {
    for (const [signal, listener] of registered) process.removeListener(signal, listener)
    registered.length = 0
    for (const timer of ownedTimers) clearTimeout(timer)
    ownedTimers.length = 0
  }
}

/**
 * 执行一条命令（引擎或外部检查）：
 *  - stdout/stderr 每个 chunk 立刻写入日志文件（完整），内存只留尾部；
 *  - 超时只对本进程组 SIGTERM → 宽限 SIGKILL，最后有界强制收尾；
 *  - 子进程退出后若孙进程仍持有管道，宽限窗到点即销毁管道，不会永久挂住。
 */
export function execStream(command, args, options = {}) {
  const {
    cwd,
    timeoutMs = 900_000,
    graceMs = 5_000,
    tailLimit = TAIL_LIMIT,
    stdoutPath = null,
    stderrPath = null,
    env = process.env,
    onStdout = null,
    onStderr = null,
  } = options

  return new Promise((resolve) => {
    const stdoutTail = createTailBuffer(tailLimit)
    const stderrTail = createTailBuffer(tailLimit)
    const timers = []
    const groupTimers = []
    const writeFailures = []
    /** 重复写入错误记录的硬上限：记录条目不随 chunk 数无限增长，但错误事实必须保留。 */
    const WRITE_FAILURE_LIMIT = 8
    let writeFailureTotal = 0
    const recordWriteFailure = (detail) => {
      writeFailureTotal += 1
      if (writeFailures.length < WRITE_FAILURE_LIMIT - 1) {
        writeFailures.push(detail)
        return
      }
      // 到达上限后不再逐条追加：末位固定保留一条汇总，streamErrors 仍非空。
      const summary = `日志写盘失败共 ${writeFailureTotal} 次（明细上限 ${WRITE_FAILURE_LIMIT} 条，后续已省略）`
      if (writeFailures.length === WRITE_FAILURE_LIMIT - 1) writeFailures.push(summary)
      else writeFailures[WRITE_FAILURE_LIMIT - 1] = summary
    }
    /** 日志打不开也算失败：绝不静默宣称日志完整。 */
    const openLog = (target) => {
      if (!target) return null
      try {
        return openSync(target, 'a')
      } catch (error) {
        writeFailures.push(`${target}: ${error && error.message ? error.message : error}`)
        return null
      }
    }
    const outFd = openLog(stdoutPath)
    const errFd = openLog(stderrPath)
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let pipesDestroyed = false
    let child = null
    let settled = false
    let timedOut = false
    let forcedKill = false
    let exitInfo = null
    let closeReason = null

    const addTimer = (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timers.push(timer)
      return timer
    }
    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer)
      timers.length = 0
    }
    /** 进程组清理的定时器单独管理：收尾（settle）不得取消已经排好的 SIGKILL，
     *  否则忽略 SIGTERM 的孙进程会在父 close 之后继续存活。 */
    const addGroupTimer = (fn, ms) => {
      const timer = setTimeout(fn, ms)
      groupTimers.push(timer)
      return timer
    }
    const clearGroupTimers = () => {
      for (const timer of groupTimers) clearTimeout(timer)
      groupTimers.length = 0
    }
    const destroyPipes = () => {
      if (pipesDestroyed || !child) return
      pipesDestroyed = true
      try {
        child.stdout.destroy()
      } catch {
        /* 已销毁 */
      }
      try {
        child.stderr.destroy()
      } catch {
        /* 已销毁 */
      }
    }
    /** 只吐解码器里剩下的半个多字节字符，保证尾部与落盘内容一致。 */
    const flushDecoders = () => {
      const outTail = stdoutDecoder.end()
      if (outTail) {
        stdoutTail.push(outTail)
        if (typeof onStdout === 'function') onStdout(outTail)
      }
      const errTail = stderrDecoder.end()
      if (errTail) {
        stderrTail.push(errTail)
        if (typeof onStderr === 'function') onStderr(errTail)
      }
    }
    const closeFds = () => {
      for (const fd of [outFd, errFd]) {
        if (fd === null) continue
        try {
          closeSync(fd)
        } catch {
          /* 已关闭 */
        }
      }
    }
    const settle = (extra = {}) => {
      if (settled) return
      settled = true
      if (child) ACTIVE_CHILDREN.delete(child)
      clearTimers()
      clearGroupTimers()
      flushDecoders()
      closeFds()
      resolve({
        command,
        args: [...args],
        cwd: cwd ?? null,
        code: exitInfo ? exitInfo.code : null,
        signal: exitInfo ? exitInfo.signal : null,
        timedOut,
        forcedKill,
        closeReason,
        stdout: stdoutTail.text,
        stderr: stderrTail.text,
        stdoutBytes: stdoutTail.bytes,
        stderrBytes: stderrTail.bytes,
        stdoutTruncatedChars: stdoutTail.droppedChars,
        stderrTruncatedChars: stderrTail.droppedChars,
        stdoutPath: stdoutPath ?? null,
        stderrPath: stderrPath ?? null,
        // 落盘失败必须显式暴露：不能静默宣称日志完整。
        streamErrors: [...writeFailures],
        error: null,
        ...extra,
      })
    }
    /** 原始字节直接落盘：不解码再编码，跨 chunk 的无效/多字节序列也不会被改写。 */
    const writeSink = (fd, chunk) => {
      if (fd === null) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
      if (buffer.length === 0) return
      // writeSync 可能只写一部分：必须在同一原始 Buffer 上按偏移循环补齐剩余字节。
      let offset = 0
      while (offset < buffer.length) {
        let wrote = 0
        try {
          wrote = writeSync(fd, buffer, offset, buffer.length - offset)
        } catch (error) {
          recordWriteFailure(String(error && error.message ? error.message : error))
          return
        }
        // 0 或非法返回值不是“稍后继续”：明确记为错误并停止，绝不空转死循环。
        if (!Number.isInteger(wrote) || wrote <= 0) {
          recordWriteFailure(
            `日志写盘无进展：剩余 ${buffer.length - offset} 字节，writeSync 返回 ${String(wrote)}`,
          )
          return
        }
        offset += wrote
      }
    }

    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      clearTimers()
      closeFds()
      settle({ closeReason: 'spawn-error', error })
      return
    }

    // 只登记本进程创建的子进程组：信号清理不会波及调用者或既有服务。
    ACTIVE_CHILDREN.add(child)
    child.stdout.on('data', (chunk) => {
      writeSink(outFd, chunk)
      const text = stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8'))
      if (!text) return
      stdoutTail.push(text)
      if (typeof onStdout === 'function') onStdout(text)
    })
    child.stderr.on('data', (chunk) => {
      writeSink(errFd, chunk)
      const text = stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8'))
      if (!text) return
      stderrTail.push(text)
      if (typeof onStderr === 'function') onStderr(text)
    })
    child.on('error', (error) => {
      closeReason = closeReason ?? 'spawn-error'
      settle({ error })
    })
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      // 父进程先退出但孙进程可能仍握着管道：有界排水窗到点即销毁管道，
      // 并对**本次创建的进程组**下 SIGKILL，然后收尾，绝不让父流程永久挂住。
      addTimer(() => {
        closeReason = closeReason ?? 'pipe-drain-timeout'
        destroyPipes()
        killProcessGroup(child, 'SIGKILL')
        settle()
      }, graceMs)
    })
    child.on('close', (code, signal) => {
      exitInfo = exitInfo ?? { code, signal }
      closeReason = closeReason ?? (timedOut ? 'timeout' : 'exit')
      // 只清理本次创建的进程组。忽略 SIGTERM 的孙进程必须在这里被 SIGKILL；
      // 旧实现在超时 close 时 clearTimers 反而取消了后续 SIGKILL，让它带着管道存活。
      killProcessGroup(child, 'SIGKILL')
      clearGroupTimers()
      settle()
    })

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      addTimer(() => {
        timedOut = true
        closeReason = 'timeout'
        killProcessGroup(child, 'SIGTERM')
        addGroupTimer(() => {
          forcedKill = true
          killProcessGroup(child, 'SIGKILL')
        }, graceMs)
        addGroupTimer(() => {
          closeReason = 'timeout-hard'
          destroyPipes()
        }, graceMs * 2)
        addGroupTimer(() => {
          settle()
        }, graceMs * 3)
      }, timeoutMs)
    }
  })
}

/* ------------------------------------------------------------------ *
 * H5 传输底座：注入式 fetch 适配器（离线回归用假实现，绝不需要真实网络）
 * ------------------------------------------------------------------ */

export function createHttpClient({ fetchImpl = globalThis.fetch, apiBase = DEFAULT_API_BASE, timeoutMs = 30_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new UsageError('运行环境缺少 fetch，无法使用 H5 传输；请改用 --transport cli')
  const base = normalizeBase(apiBase, DEFAULT_API_BASE)
  // 本地会话认证 Cookie 仅保存在这个闭包的内存里：不写盘、不写报告、不外传。
  const origin = new URL(base).origin
  let authCookie = null
  const captureCookie = (response) => {
    const headers = response && response.headers
    if (!headers) return
    const raw = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get && headers.get('set-cookie')].filter(Boolean)
    for (const item of raw) {
      const pair = String(item).split(';')[0].trim()
      if (pair && pair.includes('=')) authCookie = pair
    }
  }
  const request = async (pathAndQuery, { method = 'GET', body = null, timeout = timeoutMs } = {}) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    // 总截止时间由调用者用剩余预算传入；这里只兜底，绝不放大成固定 30 秒。
    const budget = Math.max(1, Number(timeout) || timeoutMs)
    const timer = controller ? setTimeout(() => controller.abort(), budget) : null
    try {
      const headers = { origin }
      if (body !== null) headers['content-type'] = 'application/json'
      if (authCookie) headers.cookie = authCookie
      const response = await fetchImpl(`${base}${pathAndQuery}`, {
        method,
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        ...(controller ? { signal: controller.signal } : {}),
      })
      captureCookie(response)
      const text = typeof response.text === 'function' ? await response.text() : ''
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (response.ok !== true) {
        const detail = payload && typeof payload.error === 'string' ? payload.error : String(text).slice(0, 300)
        const error = new Error(`H5 ${method} ${pathAndQuery} 失败 ${response.status}: ${detail}`)
        error.httpStatus = response.status
        throw error
      }
      return payload
    } catch (error) {
      // 连接层失败（根本没拿到响应）单独标记：上层据此判断能否回退 CLI。
      if (error && typeof error === 'object' && error.httpStatus === undefined) error.h5ConnectError = true
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return { base, request }
}

/** cwd 身份归一：优先真实路径，无法解析时退回绝对路径。 */
function samePath(value) {
  if (typeof value !== 'string' || !value) return null
  const abs = path.resolve(value)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** 按 id 找项目；找不到返回 null。 */
function matchProjectById(projects, id) {
  const wanted = String(id)
  const list = Array.isArray(projects) ? projects : []
  return list.find((item) => item && item.id != null && String(item.id) === wanted) ?? null
}

/**
 * 按 cwd 严格匹配调用者现有项目：项目 cwd 必须与目标 cwd 指向同一目录。
 * 不再退化为「父目录包含」——那会把任务落到别的项目里。
 */
export function matchProjectByCwd(projects, cwdReal) {
  const target = samePath(cwdReal)
  if (!target) return null
  const list = Array.isArray(projects)
    ? projects.filter((item) => item && typeof item.cwd === 'string' && item.cwd.length > 0)
    : []
  return list.find((item) => samePath(item.cwd) === target) ?? null
}

/**
 * 从**稳定引擎自己的安装**里加载 H5WorkspaceManager，绝不 import 被修复 cwd 内的模块。
 * 加载失败就明确报错并退化为在原目录检查，绝不假装已经合入。
 */
export async function loadWorkspaceManager(cliEntry, { importModule = (specifier) => import(specifier) } = {}) {
  const root = path.dirname(cliEntry)
  const candidates = [
    path.resolve(root, '../node_modules/@hunterzhu/pulse-server/dist/h5/workspaces.js'),
    path.resolve(root, 'node_modules/@hunterzhu/pulse-server/dist/h5/workspaces.js'),
    path.resolve(root, '../@hunterzhu/pulse-server/dist/h5/workspaces.js'),
  ]
  const failures = []
  for (const candidate of candidates) {
    let mod
    try {
      mod = await importModule(pathToFileURL(candidate).href)
    } catch (error) {
      failures.push(`${candidate}: ${error && error.message ? error.message : error}`)
      continue
    }
    if (mod && typeof mod.H5WorkspaceManager === 'function') {
      return { H5WorkspaceManager: mod.H5WorkspaceManager, modulePath: candidate }
    }
    failures.push(`${candidate}: 未导出 H5WorkspaceManager`)
  }
  throw new UsageError(`无法从稳定引擎加载 H5WorkspaceManager（${failures.join(' | ')}）`)
}
/* ------------------------------------------------------------------
 * H5 传输：在调用者已有的 Pulse 项目里创建并置顶真实任务，按 run 状态跟踪
 * ------------------------------------------------------------------ */

const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'error', 'aborted'])

export function runStateOf(payload) {
  if (!payload || typeof payload !== 'object') return null
  for (const key of ['state', 'status']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 需要人工的信号：只识别真实 ask / 审批等待，脚本绝不替人回答。 */
export function detectNeedsAttention(payload) {
  if (!payload || typeof payload !== 'object') return null
  const state = runStateOf(payload)
  if (state === 'needs_attention' || state === 'waiting' || state === 'awaiting_human' || state === 'paused') return state
  for (const key of ['pendingRequest', 'pendingAsk', 'ask', 'approval']) {
    const value = payload[key]
    if (value && typeof value === 'object') {
      return typeof value.type === 'string' && value.type ? value.type : key
    }
  }
  // running 状态下真实待办以 interactions 数组下发（approval / ask）：只识别，绝不自动回答。
  const interactions = Array.isArray(payload.interactions) ? payload.interactions : []
  for (const item of interactions) {
    if (!item || typeof item !== 'object') continue
    if (item.resolved === true || item.status === 'resolved' || item.status === 'answered') continue
    const kind = typeof item.type === 'string' && item.type ? item.type : typeof item.kind === 'string' ? item.kind : null
    if (kind === 'approval' || kind === 'ask' || kind === 'question') return kind
  }
  if (payload.awaitingHuman === true) return 'awaiting_human'
  return null
}

export function createH5EngineInvoker({
  http,
  uiBase = DEFAULT_UI_BASE,
  projectId = null,
  waitForHuman = false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 1000,
} = {}) {
  if (!http || typeof http.request !== 'function') throw new UsageError('createH5EngineInvoker 需要注入 http 客户端（离线回归用假适配器）')
  const request = http.request
  return async function invokeH5Engine({
    prompt = '',
    cwd,
    conversationId = null,
    timeoutMs = 900_000,
    round = 1,
    requestId = null,
    onEvent = null,
    log = () => {},
  } = {}) {
    if (!cwd) throw new UsageError('H5 传输需要 cwd')
    // 总截止时间从**第一次请求之前**起算：认证、匹配项目、建会话、启动、轮询共用一份预算。
    const budget = Math.max(1, Number(timeoutMs) || 900_000)
    const deadline = Date.now() + budget
    // 剩余预算只用于单次请求超时；能不能继续发请求，一律由下面的检查决定：
    // 到期后立即停止，绝不把过期预算夹成 1ms 继续创建/启动任务。
    const remaining = () => deadline - Date.now()
    const expired = () => Date.now() >= deadline
    const assertAlive = (stage) => {
      if (!expired()) return
      const stalled = new UsageError(`H5 传输：总预算（${budget}ms）在${stage}前已耗尽，停止后续请求，不再创建或启动任务`)
      stalled.h5DeadlineExceeded = true
      throw stalled
    }
    // 每次请求前都先检查总截止时间，再沿用同一份剩余预算作为本次请求的超时。
    const call = async (stage, pathAndQuery, options = {}) => {
      assertAlive(stage)
      try {
        return await request(pathAndQuery, { ...options, timeout: remaining() })
      } catch (error) {
        if (error && typeof error === 'object' && expired()) error.h5DeadlineExceeded = true
        throw error
      }
    }
    const cwdId = samePath(cwd)
    let convId = conversationId
    let pin
    // 这一段还没有创建任何任务：只有连接层失败才允许上层回退 CLI。
    try {
      // 认证必须排在所有业务请求之前：Cookie 由 createHttpClient 的内存闭包保存，
      // 后续请求自动带上 Origin 与这份 Cookie（不写盘、不进报告）。
      await call('本地会话认证', '/api/session/local', { method: 'POST' })
      const projects = await call('读取项目列表', '/api/projects')
      if (projectId) {
        const found = matchProjectById(projects, projectId)
        if (!found) throw new UsageError(`H5 传输：--project-id ${projectId} 不存在`)
        if (!cwdId || samePath(found.cwd) !== cwdId) {
          throw new UsageError(`H5 传输：项目 ${projectId} 的 cwd（${found.cwd ?? '(缺失)'}）与 --cwd（${cwd}）不一致，拒绝在别的项目里运行`)
        }
        pin = { id: String(found.id), pinned: found.pinned === true }
      } else {
        const matched = matchProjectByCwd(projects, cwd)
        if (!matched) throw new UsageError(`H5 传输：没有与 --cwd 完全匹配的现有项目（${cwd}），请用 --project-id 指定`)
        pin = { id: matched.id, pinned: matched.pinned === true }
      }
      // 项目属性保持原样：这里不再 PATCH /api/projects，置顶只作用于本次新建的 conversation。
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      // 预算耗尽不是连接失败：绝不因此回退 CLI 再起一个任务。
      if (failure.h5ConnectError === true && failure.h5DeadlineExceeded !== true) failure.h5NotStarted = true
      throw failure
    }
    // 从这里开始会创建任务：结果不确定时绝不回退 CLI，避免并发两个任务。
    let createdConversation = false
    if (!convId) {
      createdConversation = true
      let created = null
      try {
        created = await call('创建会话', '/api/conversations', {
          method: 'POST',
          body: { title: `self-host 修复任务（第 ${round} 轮）`, projectId: pin.id },
        })
      } catch (error) {
        const failure = new Error(`H5 传输：创建会话失败（${error && error.message ? error.message : error}）`)
        failure.h5Started = true
        failure.h5SubmitUncertain = true
        throw failure
      }
      convId = created && (created.id ?? created.conversationId ?? null)
      if (!convId) {
        const missing = new UsageError('H5 传输：创建会话未返回 id')
        missing.h5Started = true
        missing.h5SubmitUncertain = true
        throw missing
      }
    }
    if (createdConversation) {
      // 只置顶本次新建的 conversation：不 PATCH 项目，保持项目自身的 pinned 等属性不变。
      try {
        await call('置顶会话', `/api/conversations/${encodeURIComponent(convId)}`, { method: 'PATCH', body: { pinned: true } })
      } catch (error) {
        const failure = new Error(`H5 传输：置顶会话失败（${error && error.message ? error.message : error}）`)
        failure.h5Started = true
        failure.h5ConversationId = convId
        throw failure
      }
    }
    const taskUrl = formatTaskUrl({ uiBase, projectId: pin.id, conversationId: convId })
    // 会话创建后立刻输出真实链接：之后任何失败都能被人工接手。
    log(`H5 任务已创建：${taskUrl}（conversation ${convId}）`)
    let sent = null
    try {
      // /messages 需要先准备隔离目录，可能超过 30 秒：用剩余总预算，不用固定 30 秒。
      sent = await call('发送任务', `/api/conversations/${encodeURIComponent(convId)}/messages`, {
        method: 'POST',
        body: { text: prompt, ...(requestId ? { requestId } : {}) },
      })
    } catch (error) {
      const wrapped = new Error(`H5 传输：发送任务失败（${error && error.message ? error.message : error}）`)
      wrapped.h5Started = true
      wrapped.h5SubmitUncertain = true
      wrapped.h5ConversationId = convId
      wrapped.h5TaskUrl = taskUrl
      throw wrapped
    }
    const runId = sent && (sent.runId ?? sent.id ?? null)
    if (!runId) {
      const missing = new UsageError('H5 传输：发送任务未返回 runId')
      missing.h5Started = true
      missing.h5SubmitUncertain = true
      missing.h5ConversationId = convId
      missing.h5TaskUrl = taskUrl
      throw missing
    }
    let snapshot = null
    let needsAttention = null
    let waitedForHuman = false
    let timedOut = false
    try {
      for (;;) {
        // 轮询前同样先检查总截止时间：到期立刻收尾，不再产生任何请求。
        if (expired()) {
          timedOut = true
          break
        }
        snapshot = await call('跟踪 run', `/api/runs/${encodeURIComponent(runId)}/state`)
        if (typeof onEvent === 'function') onEvent({ round, runId, snapshot })
        // Terminal state wins over stale interaction entries retained by the API.
        if (TERMINAL_RUN_STATES.has(runStateOf(snapshot))) { needsAttention = null; break }
        needsAttention = detectNeedsAttention(snapshot)
        // 默认：需要人工就立刻上报、绝不替人回答。
        if (needsAttention && !waitForHuman) break
        if (!needsAttention) {
          const current = runStateOf(snapshot)
          if (current && TERMINAL_RUN_STATES.has(current)) break
        } else if (!waitedForHuman) {
          waitedForHuman = true
          log(`H5 需要人工处理（${needsAttention}），按 --wait-for-human 在总超时内等待同一 run：${taskUrl}`)
        }
        if (Date.now() >= deadline) {
          timedOut = true
          break
        }
        // 始终复用同一个 runId：等待人工期间绝不新建会话或新 run。
        await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())))
      }
    } catch (error) {
      // run 已启动：不再另开任务，保留 run/link 让调用者如实报告。
      const wrapped = new Error(`H5 传输：跟踪 run 失败（${error && error.message ? error.message : error}）`)
      wrapped.h5Started = true
      wrapped.h5ConversationId = convId
      wrapped.h5RunId = runId
      wrapped.h5TaskUrl = taskUrl
      throw wrapped
    }
    const state = runStateOf(snapshot)
    log(`H5 任务：${taskUrl}（run ${runId}，state ${state ?? 'unknown'}）`)
    return {
      transport: 'h5',
      projectId: pin.id,
      conversationId: convId,
      runId,
      taskUrl,
      state,
      status: state,
      taskOutcome: readTaskOutcome(snapshot && (snapshot.taskOutcome ?? snapshot.outcome)),
      needsAttention,
      waiting: Boolean(needsAttention),
      waitedForHuman,
      timedOut,
      endedAt: new Date().toISOString(),
      snapshot,
    }
  }
}

/** 失败反馈只是数据：真实退出码 + 日志尾部，绝不改写检查让它变绿。 */
export function failureBrief(attempt) {
  if (!attempt) return ''
  const lines = [
    '## 上一轮验收失败记录（由 self-host.mjs 外部执行，未经模型转述）',
    '',
    `- 轮次: ${attempt.round}`,
    `- 引擎状态: ${attempt.engineStatus ?? '(缺失)'}`,
    `- 任务验收: ${attempt.taskOutcome ?? '(缺失)'}`,
    `- 引擎退出码: ${attempt.engineCode}`,
  ]
  for (const check of attempt.checks ?? []) {
    if (check.passed) continue
    lines.push('', `### 失败检查 ${check.argv.join(' ')}`, `退出码: ${check.code}`, `超时: ${check.timedOut}`)
    if (check.stdoutTail) lines.push('stdout 尾部:', '```', check.stdoutTail, '```')
    if (check.stderrTail) lines.push('stderr 尾部:', '```', check.stderrTail, '```')
  }
  lines.push('', '要求: 只在 --cwd 内做最小必要修复，不要改动检查命令或验收文件；修复后外部会以完全相同的命令重新验收。')
  return lines.join('\n')
}
/* ------------------------------------------------------------------ *
 * 主流程：基线 / 修复轮次 / 报告
 * ------------------------------------------------------------------ */

export async function writeJsonFile(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function engineExitCode(engine) {
  if (!engine) return null
  if (typeof engine.code === 'number') return engine.code
  if (typeof engine.exitCode === 'number') return engine.exitCode
  return null
}

/** 报告必须区分 timeout / 检查失败 / 引擎失败 / 冻结篡改 / 人工等待。 */
export function classifyFailure({ engine = null, checks = [], frozenTampered = false, waiting = false } = {}) {
  if (frozenTampered) return { status: STATUS.freeze, exitCode: EXIT.freeze }
  if (waiting) return { status: STATUS.waiting, exitCode: EXIT.waiting }
  const list = Array.isArray(checks) ? checks : []
  if (engine && engine.timedOut === true) return { status: STATUS.timeout, exitCode: EXIT.timeout }
  if (list.some((item) => item && item.timedOut === true)) return { status: STATUS.timeout, exitCode: EXIT.timeout }
  const code = engineExitCode(engine)
  if (engine && (engine.error || (typeof code === 'number' && code !== 0))) return { status: STATUS.engine, exitCode: EXIT.engine }
  if (list.some((item) => !item || item.passed !== true)) return { status: STATUS.checks, exitCode: EXIT.checks }
  if (!engine || readTaskOutcome(engine.taskOutcome) !== 'accepted') return { status: STATUS.notAccepted, exitCode: EXIT.notAccepted }
  return { status: STATUS.success, exitCode: EXIT.ok }
}

/* ------------------------------------------------------------------ *
 * 报告写入、历史记录与传输选择
 * ------------------------------------------------------------------ */

export async function writeTextFile(file, text) {
  await fs.writeFile(file, text, 'utf8')
}

/** 历史失败只追加不擦除：attempts 永远保留每一轮的真实记录。 */
export function appendAttempt(report, record) {
  if (!Array.isArray(report.attempts)) report.attempts = []
  report.attempts.push(record)
  return record
}

/** 目录归一：只做 resolve，不跟随符号链接，也不因目录不存在而静默通过。 */
function normalizeDirCwd(value) {
  if (typeof value !== 'string' || !value) return null
  return path.resolve(value)
}

/** candidate 是否落在 root 之内（含 root 本身）。 */
function isInsideCwd(root, candidate) {
  if (!root || !candidate) return false
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/**
 * 目录的 canonical 形态：必须真实存在，返回 realpath（跟随符号链接）。
 * 符号链接逃逸只能在这一步被发现，纯词法包含看不见 worktree/app -> 外部目录。
 */
function canonicalDirCwd(value) {
  const abs = normalizeDirCwd(value)
  if (!abs) return null
  try {
    if (!statSync(abs).isDirectory()) return null
    return realpathSync(abs)
  } catch {
    return null
  }
}

/**
 * 只用 workspace record 自己的字段推导本次会话的候选目录：不读盘、不猜、不回退。
 * pending/running/conflict 用真实 worktreeRoot + projectSubdirectory；
 * merged/noop/shared 用已核对过的原始 projectRoot + projectSubdirectory。
 * conversationId 不匹配、项目目录不匹配、子目录越界、状态未知一律返回 error，
 * 由调用者失败，绝不把原目录当成候选。
 */
export function resolveRecordCwd(record, { conversationId = null, cwd = null } = {}) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'WORKSPACE_RECORD_MISSING' }
  if (!conversationId) return { ok: false, error: 'WORKSPACE_CONVERSATION_ID_MISSING' }
  if (record.conversationId !== conversationId) return { ok: false, error: 'WORKSPACE_CONVERSATION_MISMATCH' }
  const projectRoot = normalizeDirCwd(record.projectRoot)
  if (!projectRoot) return { ok: false, error: 'WORKSPACE_PROJECT_ROOT_MISSING' }
  const subdirectory = typeof record.projectSubdirectory === 'string' ? record.projectSubdirectory : ''
  const expected = normalizeDirCwd(cwd)
  if (!expected) return { ok: false, error: 'WORKSPACE_EXPECTED_CWD_MISSING' }
  // projectRoot + 子目录必须正好是调用者要求修复的原目录，否则就是在别的项目里跑。
  const recordedTarget = path.resolve(projectRoot, subdirectory)
  if (!isInsideCwd(projectRoot, recordedTarget)) return { ok: false, error: 'WORKSPACE_SUBDIRECTORY_ESCAPES_PROJECT' }
  if (samePath(recordedTarget) !== samePath(expected)) return { ok: false, error: 'WORKSPACE_PROJECT_MISMATCH' }
  const status = typeof record.status === 'string' ? record.status : ''
  if (status === 'running' || status === 'pending' || status === 'conflict') {
    const worktreeRoot = normalizeDirCwd(record.worktreeRoot)
    if (!worktreeRoot) return { ok: false, error: 'WORKSPACE_WORKTREE_ROOT_MISSING' }
    // worktreeRoot 与候选目录都必须真实存在，且 canonical realpath 仍落在
    // canonical worktreeRoot 之内：拒绝符号链接把候选指向 worktree 外的目录。
    const canonicalWorktree = canonicalDirCwd(worktreeRoot)
    if (!canonicalWorktree) return { ok: false, error: 'WORKSPACE_WORKTREE_UNAVAILABLE' }
    const candidate = path.resolve(worktreeRoot, subdirectory)
    const canonicalCandidate = canonicalDirCwd(candidate)
    if (!canonicalCandidate) return { ok: false, error: 'WORKSPACE_CANDIDATE_UNAVAILABLE' }
    if (!isInsideCwd(canonicalWorktree, canonicalCandidate)) return { ok: false, error: 'WORKSPACE_CANDIDATE_ESCAPES_WORKTREE' }
    // 子目录不得越出 worktreeRoot，也不能指回原目录冒充候选目录（按 canonical 形态比较）。
    if (!isInsideCwd(worktreeRoot, candidate)) return { ok: false, error: 'WORKSPACE_SUBDIRECTORY_ESCAPES_WORKTREE' }
    const canonicalExpected = canonicalDirCwd(expected) ?? samePath(expected)
    if (canonicalCandidate === canonicalExpected || samePath(candidate) === samePath(expected)) {
      return { ok: false, error: 'WORKSPACE_CANDIDATE_IS_ORIGINAL' }
    }
    return { ok: true, cwd: canonicalCandidate, projectRoot, worktreeRoot, subdirectory, status, isolated: true }
  }
  if (status === 'merged' || status === 'noop' || status === 'shared') {
    // 已合入/无需合入/共享目录：候选就是核对过的原目录本身。
    return {
      ok: true,
      cwd: recordedTarget,
      projectRoot,
      worktreeRoot: normalizeDirCwd(record.worktreeRoot),
      subdirectory,
      status,
      isolated: false,
    }
  }
  return { ok: false, error: `WORKSPACE_STATUS_UNKNOWN:${status || '(缺失)'}` }
}

/**
 * 用**稳定引擎自己的** H5WorkspaceManager 读取本次 conversation 的精确记录并推导候选目录。
 * 无论成败都必须 close()：不把句柄/共享锁留给原目录复检。
 */
export async function locateWorkspace({ cliEntry, dataDir, conversationId = null, cwd = null, importModule = null } = {}) {
  if (!conversationId || !dataDir) return { ok: false, error: 'WORKSPACE_PRECONDITION_MISSING' }
  const loaded = await loadWorkspaceManager(cliEntry, importModule ? { importModule } : {})
  const manager = new loaded.H5WorkspaceManager(dataDir)
  try {
    const record = typeof manager.get === 'function' ? await manager.get(conversationId) : undefined
    const resolved = resolveRecordCwd(record, { conversationId, cwd })
    return { ...resolved, modulePath: loaded.modulePath ?? null, record: record ?? null }
  } finally {
    if (manager && typeof manager.close === 'function') await manager.close()
  }
}

/** 仅在连接失败且确定尚未创建 H5 任务时允许回退 CLI。 */
export function selectInvoker({
  transport = 'cli',
  cliEntry,
  apiBase,
  uiBase,
  projectId = null,
  http = null,
  importModule = null,
  log = () => {},
} = {}) {
  if (transport !== 'cli' && transport !== 'h5') throw new UsageError(`--transport 只支持 cli 或 h5，当前: ${transport}`)
  const cliInvoker = createCliEngineInvoker({ cliEntry })
  if (transport === 'cli') {
    return async (request = {}) => ({ ...(await cliInvoker(request)), transport: 'cli' })
  }
  let client = http
  async function invokeH5Only(request = {}) {
    client = client ?? createHttpClient({ fetchImpl: request.fetchImpl, apiBase })
    const h5Invoker = createH5EngineInvoker({ http: client, uiBase, projectId, waitForHuman: request.waitForHuman === true })
    let knownResult = null
    try {
      const result = await h5Invoker({ ...request, log })
      knownResult = result
      if (result && result.runId) {
        // 候选目录只能来自 manager.get(conversationId) 的精确记录。定位失败时
        // workspace 保持 null，让 main 直接失败，绝不回落到原目录跑检查。
        const located = await locateWorkspace({
          cliEntry,
          dataDir: request.dataDir ?? null,
          conversationId: result.conversationId ?? request.conversationId ?? null,
          cwd: request.cwd ?? null,
          importModule,
        })
        return {
          ...result,
          transport: 'h5',
          workspace: located.ok ? located.cwd : null,
          workspaceStatus: located.ok ? located.status : null,
          workspaceIsolated: located.ok ? located.isolated === true : false,
          workspaceError: located.ok ? null : located.error,
          workspaceModule: located.modulePath ?? null,
        }
      }
      throw new UsageError('H5 传输未返回可用 runId')
    } catch (error) {
      // 任务可能已经创建/启动，或提交结果不确定；此时绝不能再开 CLI，
      // 否则会出现两个并发修复任务。保留真实 run/link 并如实上报。
      const reason = String(error && error.message ? error.message : error)
      const started = Boolean(knownResult?.runId || error && (error.h5Started === true || error.h5RunId || error.h5ConversationId))
      // 唯一允许降级的场景：连接层失败，且此刻确实一个任务都没创建。
      const mayFallback = started === false && Boolean(error) && error.h5NotStarted === true && error.h5ConnectError === true
      if (mayFallback) {
        log(`H5 传输连接失败且明确未创建任务，回退 CLI：${reason}`)
        const result = await cliInvoker({ ...request, log })
        return { ...result, transport: 'cli', h5Fallback: { reason } }
      }
      log(`H5 传输失败（${started ? '任务已启动，不再回退 CLI' : '结果不确定，也不回退 CLI'}）：${reason}`)
      const failure = new UsageError(`H5 传输失败，未回退 CLI：${reason}`)
      failure.h5Error = reason
      failure.h5Started = started
      failure.h5RunId = knownResult?.runId ?? error?.h5RunId ?? null
      failure.h5ConversationId = knownResult?.conversationId ?? error?.h5ConversationId ?? null
      failure.h5TaskUrl = knownResult?.taskUrl ?? error?.h5TaskUrl ?? null
      throw failure
    }
  }
  // 只有主流程拿到真实 accepted 之后才会调用：用稳定引擎自己的
  // H5WorkspaceManager 收尾，绝不伪造验收文件。
  invokeH5Only.finalize = async ({ conversationId = null, dataDir = null, cwd = null, workspace = null } = {}) => {
    if (!conversationId || !dataDir) return { merged: false, error: 'FINALIZE_PRECONDITION_MISSING' }
    const loaded = await loadWorkspaceManager(cliEntry, importModule ? { importModule } : {})
    const manager = new loaded.H5WorkspaceManager(dataDir)
    try {
      // 合入前重新核对本次会话的记录：conversationId 一致、项目目录一致、
      // 候选目录必须就是刚才通过检查的那个目录。任何不一致都不合入。
      const record = typeof manager.get === 'function' ? await manager.get(conversationId) : undefined
      const resolved = resolveRecordCwd(record, { conversationId, cwd })
      if (!resolved.ok) return { merged: false, status: null, error: resolved.error, modulePath: loaded.modulePath }
      if (workspace && samePath(workspace) !== samePath(resolved.cwd)) {
        return { merged: false, status: null, error: 'WORKSPACE_CANDIDATE_MISMATCH', modulePath: loaded.modulePath }
      }
      const result = await manager.finish(conversationId, true)
      const status = result && typeof result.status === 'string' ? result.status : null
      return {
        merged: status === 'merged' || status === 'noop',
        status,
        conflictPaths: result && result.conflictPaths ? result.conflictPaths : undefined,
        modulePath: loaded.modulePath,
      }
    } finally {
      // 无论成败都必须关闭：不能把 manager 的句柄/锁留给原目录复检。
      if (manager && typeof manager.close === 'function') await manager.close()
    }
  }
  return invokeH5Only
}

/* ------------------------------------------------------------------ *
 * 主流程：基线 / 修复轮次 / 收尾 / 报告
 * ------------------------------------------------------------------ */

const REQUIRED_OPTS = ['checks-file', 'cwd', 'data-dir', 'output']

function logLine(message) {
  process.stdout.write(`${message}\n`)
}

/**
 * 只读调用者现有 dataDir 中本次 conversation/run 的 task-outcome.json。
 * 真实 /state 里没有 taskOutcome，验收结论只存在于这份真实文件里；
 * 因此**只读**它、校验 runId 一致，绝不写入、绝不伪造。
 */
export async function readTaskOutcomeFile({ dataDir, conversationId, runId } = {}) {
  if (!dataDir || !conversationId || !runId) return null
  // 只认本次 conversation + run 的准确路径。真实 task-outcome.json 没有 runId 字段，
  // 也绝不允许退回会话级或其他 run 的旧验收结论。
  const file = path.join(dataDir, 'conversations', conversationId, 'runs', runId, 'task-outcome.json')
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.runId === 'string' && payload.runId && payload.runId !== runId) return null
  const outcome = readTaskOutcome(payload)
  if (!outcome) return null
  return { path: file, outcome, runId: payload.runId ?? null, raw: payload }
}

export async function main(argv, { http = null, fetchImpl = null, importModule = null, log = logLine } = {}) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(USAGE)
    return EXIT.ok
  }
  for (const key of REQUIRED_OPTS) {
    if (!opts[key]) throw new UsageError(`缺少必需参数 --${key}`)
  }
  const cwdReal = await requireDir(opts.cwd, '--cwd')
  const dataDir = await requireDir(opts['data-dir'], '--data-dir')
  const outputDir = path.resolve(opts.output)
  const reportPath = path.join(outputDir, 'report.json')
  // 默认拒绝覆盖历史结果：已有报告必须显式 --overwrite，绝不静默抹去过往结论。
  if (opts.overwrite !== true) {
    for (const name of ['report.json', 'baseline.json']) {
      const existing = path.join(outputDir, name)
      if (existsSync(existing)) {
        throw new UsageError(`--output 中已有历史报告 ${existing}；默认拒绝覆盖，确需丢弃历史请显式加 --overwrite`)
      }
    }
  }
  await fs.mkdir(outputDir, { recursive: true })

  const checksFile = path.resolve(opts['checks-file'])
  const taskFile = opts['task-file'] ? path.resolve(opts['task-file']) : null
  const extra = Array.isArray(opts['freeze-file']) ? opts['freeze-file'].map((file) => path.resolve(file)) : []
  const checks = parseChecks(await fs.readFile(checksFile, 'utf8'))
  const taskText = taskFile ? await fs.readFile(taskFile, 'utf8') : ''
  const frozen = await freezeMany([...(taskFile ? [taskFile] : []), checksFile, ...extra])

  const transport = opts.transport === undefined ? 'cli' : String(opts.transport).toLowerCase()
  const autoApprove = opts['auto-approve'] === true
  // --wait-for-human 只影响 H5 传输：需要人工时不立即上报，而是在总超时内等同一个 run。
  const waitForHuman = opts['wait-for-human'] === true
  const maxAttempts = intOption(opts, 'max-attempts', 3)
  const timeoutMs = intOption(opts, 'timeout-ms', 900_000)
  const apiBase = normalizeBase(opts['api-base'], DEFAULT_API_BASE)
  const uiBase = normalizeBase(opts['ui-base'], DEFAULT_UI_BASE)
  const projectId = opts['project-id'] ? String(opts['project-id']) : null

  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    status: null,
    exitCode: null,
    message: null,
    transport,
    autoApprove,
    waitForHuman,
    apiBase,
    uiBase,
    projectId,
    cwd: cwdReal,
    dataDir,
    output: outputDir,
    taskFile,
    checksFile,
    checks,
    frozen,
    cliEntry: null,
    conversationId: null,
    runId: null,
    taskUrl: null,
    workspace: null,
    baseline: null,
    attempts: [],
  }

  const finish = async (exitCode, status, message) => {
    // 收尾前再确认一次中断状态：只要已经收到 SIGINT/SIGTERM，就绝不报告成功。
    // 固定检查可能在信号到达后仍然通过（例如检查进程被杀前已写完结果），
    // 因此必须以中断为准降级为非成功，避免把被中断的一轮误报成成功。
    let finalExitCode = exitCode
    let finalStatus = status
    let finalMessage = message
    if (interruptSignal) {
      report.interruptedBy = interruptSignal
      if (status === STATUS.success) {
        finalExitCode = EXIT.timeout
        finalStatus = STATUS.timeout
        finalMessage = `收到 ${interruptSignal}，本轮被中断，按非成功报告（原结论：${message}）`
      }
    }
    report.exitCode = finalExitCode
    report.status = finalStatus
    report.message = finalMessage
    report.ok = finalStatus === STATUS.success
    report.finishedAt = new Date().toISOString()
    await writeJsonFile(reportPath, report)
    log(`${finalStatus}: ${finalMessage}`)
    return finalExitCode
  }

  try {
    // 基线：只跑固定检查，绝不调用模型；不需要模型时也能给出准确结论。
    const baseline = await runRoundChecks({ checks, cwd: cwdReal, timeoutMs, outputDir, frozen, labelPrefix: 'baseline' })
    const baselineOk = baseline.length === checks.length && baseline.every((item) => item.passed === true)
    report.baseline = { at: new Date().toISOString(), allPassed: baselineOk, checks: baseline }
    await writeJsonFile(path.join(outputDir, 'baseline.json'), report.baseline)
    await verifyFrozen(frozen, '基线检查结束后')
    if (opts['baseline-only'] === true) {
      return await finish(
        baselineOk ? EXIT.baseline : EXIT.checks,
        baselineOk ? STATUS.baseline : STATUS.checks,
        baselineOk ? '基线检查全部通过（未调用模型，未做任何修复）' : '基线检查未通过（未调用模型，未做任何修复）',
      )
    }

    if (!opts['cli-entry']) throw new UsageError('缺少必需参数 --cli-entry')
    if (!taskFile) throw new UsageError('修复轮次需要 --task-file')
    const cliEntry = await resolveCliEntry(opts['cli-entry'], cwdReal)
    report.cliEntry = cliEntry
    const invoke = selectInvoker({
      transport,
      cliEntry,
      apiBase,
      uiBase,
      projectId,
      http: http ?? (fetchImpl ? createHttpClient({ fetchImpl, apiBase }) : null),
      importModule,
      log,
    })

    let conversationId = null
    let lastFailure = null

    for (let round = 1; round <= maxAttempts; round += 1) {
      // 每轮开始前先校验冻结身份：修复进程还没启动就已经被改过，直接判定篡改。
      await verifyFrozen(frozen, `第 ${round} 轮开始前`)
      const prompt = round === 1 ? taskText : `${taskText}\n\n${failureBrief(lastFailure)}`
      const engine = await invoke({
        mode: round === 1 || !conversationId ? 'run' : 'resume',
        prompt,
        conversationId,
        cwd: cwdReal,
        dataDir,
        configPath: opts.config ? path.resolve(opts.config) : null,
        autoApprove,
        waitForHuman,
        timeoutMs,
        round,
        log,
        stdoutPath: path.join(outputDir, `round-${round}.engine.stdout.log`),
        stderrPath: path.join(outputDir, `round-${round}.engine.stderr.log`),
      })
      const engineStreamErrors = engine && Array.isArray(engine.streamErrors) ? engine.streamErrors : []
      if (engineStreamErrors.length > 0) {
        throw Object.assign(new Error(`第 ${round} 轮引擎日志写盘失败：${engineStreamErrors.join(' | ')}`), { kind: 'log' })
      }
      if (interruptSignal) {
        throw Object.assign(new Error(`收到 ${interruptSignal}，已按有界宽限清理本次创建的进程组，停止后续轮次`), {
          kind: 'timeout',
          timedOut: true,
        })
      }
      if (engine && engine.conversationId) conversationId = engine.conversationId
      if (engine && engine.runId) report.runId = engine.runId
      if (engine && engine.taskUrl) report.taskUrl = engine.taskUrl
      if (engine && engine.workspace) report.workspace = engine.workspace
      report.conversationId = conversationId

      // H5 传输的 /state 里没有可信 taskOutcome：验收结论只能来自调用者 dataDir 内
      // 本次 conversation+run 的真实 task-outcome.json。缺失/读不到就清空 accepted，
      // 绝不采信 /state 里可能残留的 accepted；绝不写入、绝不伪造。
      let accepted = readTaskOutcome(engine && engine.taskOutcome)
      if (engine && engine.transport === 'h5') {
        accepted = null
        if (conversationId && engine.runId) {
          const outcomeFile = await readTaskOutcomeFile({ dataDir, conversationId, runId: engine.runId })
          if (outcomeFile) {
            accepted = outcomeFile.outcome
            report.taskOutcomeFile = outcomeFile.path
          } else {
            report.taskOutcomeFile = null
            log(`H5 验收：未找到本次 run 的精确 task-outcome 文件（conversation=${conversationId} run=${engine.runId}），按未验收处理`)
          }
        } else {
          log('H5 验收：缺少 conversationId 或 runId，无法读取本次 run 的 task-outcome，按未验收处理')
        }
      }

      // 引擎进程结束后立刻校验：修复进程本身不得改动 task / checks / freeze-file。
      await verifyFrozen(frozen, `第 ${round} 轮引擎进程结束后`)

      const needsAttention = engine && engine.needsAttention != null ? engine.needsAttention : null
      if (engine && (engine.waiting === true || needsAttention !== null)) {
        // 需人工时：不自动回答 ask 或审批，写真实 needs_attention 报告并保留任务。
        appendAttempt(report, {
          round,
          at: new Date().toISOString(),
          transport: engine.transport ? engine.transport : transport,
          engineStatus: engine.status ? engine.status : null,
          taskOutcome: accepted,
          engineCode: engineExitCode(engine),
          waiting: true,
          needsAttention,
          conversationId,
          runId: engine.runId ? engine.runId : null,
          taskUrl: engine.taskUrl ? engine.taskUrl : null,
          checks: [],
        })
        return await finish(
          EXIT.waiting,
          STATUS.waiting,
          `第 ${round} 轮进入人工等待（${needsAttention ?? 'needs_attention'}），任务已保留：${engine.taskUrl ?? '(无任务链接)'}`,
        )
      }

      // 引擎结束时已 verifyFrozen；H5 只在 manager.get 定位到的真实候选目录检查，
      // 定位不到（记录缺失/错项目/状态未知）就直接失败，绝不回落到原目录。
      const isH5Engine = Boolean(engine && engine.transport === 'h5')
      if (isH5Engine && !(typeof engine.workspace === 'string' && engine.workspace)) {
        lastFailure = `第 ${round} 轮无法定位本次会话的候选目录（${engine.workspaceError ?? 'WORKSPACE_UNRESOLVED'}），拒绝在原目录判定成功`
        log(lastFailure)
        return await finish(exitCodeFor('checks', 3), statusFor('checks', STATUS.checks, 'workspace'), lastFailure)
      }
      const candidateDir = isH5Engine ? engine.workspace : cwdReal
      const roundChecks = await runRoundChecks({ checks, cwd: candidateDir, timeoutMs, outputDir, frozen, labelPrefix: `round-${round}` })
      const checksOk = roundChecks.length === checks.length && roundChecks.every((item) => item.passed === true)
      appendAttempt(report, {
        round,
        at: new Date().toISOString(),
        transport: engine && engine.transport ? engine.transport : transport,
        engineStatus: engine && engine.status ? engine.status : null,
        taskOutcome: accepted,
        engineCode: engineExitCode(engine),
        waiting: false,
        needsAttention: null,
        timedOut: Boolean(engine && engine.timedOut === true),
        signaled: engine && engine.signal ? String(engine.signal) : null,
        checkDir: candidateDir,
        conversationId,
        runId: engine && engine.runId ? engine.runId : null,
        taskUrl: engine && engine.taskUrl ? engine.taskUrl : null,
        checks: roundChecks,
      })
      log(`第 ${round} 轮 accepted=${accepted} 检查 ${roundChecks.filter((item) => item.passed === true).length}/${checks.length} @ ${candidateDir}`)

      // 只有严格 accepted、引擎正常退出、固定检查全过，才允许进入成功分支。
      const strictlyAccepted = accepted === 'accepted'
      const engineCode = engineExitCode(engine)
      if (engine && (engine.timedOut === true || engine.signal)) {
        throw Object.assign(new Error(`第 ${round} 轮引擎超时或被信号中断（${engine.signal ? String(engine.signal) : 'timeout'}）`), {
          kind: 'timeout',
          timedOut: true,
        })
      }
      if (Number.isInteger(engineCode) && engineCode !== 0) {
        lastFailure = `第 ${round} 轮引擎退出码 ${engineCode}，不允许判定成功`
        log(lastFailure)
        return await finish(exitCodeFor('engine', 4), statusFor('engine', STATUS.engine, 'engine'), lastFailure)
      }
      if (engine && typeof engine.status === 'string' && !['succeeded', 'success', 'ok', 'accepted'].includes(engine.status)) {
        lastFailure = `第 ${round} 轮引擎状态为 ${engine.status}，不允许判定成功`
        log(lastFailure)
        return await finish(exitCodeFor('engine', 4), statusFor('engine', STATUS.engine, 'engine'), lastFailure)
      }
      if (checksOk && !strictlyAccepted) {
        // 检查全绿但任务未被验收：这是「未验收」，不是「检查失败」。
        lastFailure = `第 ${round} 轮任务未被 accepted（taskOutcome=${accepted ?? '(缺失)'}），固定检查全部通过；此为未验收，不是检查失败`
        log(lastFailure)
        return await finish(exitCodeFor('notAccepted', 6), statusFor('notAccepted', STATUS.notAccepted, 'not_accepted'), lastFailure)
      }
      if (strictlyAccepted && checksOk) {
        // 只有真实 accepted 才允许引擎自己的 H5WorkspaceManager 合入，合入后用同一批 checks 复检原目录。
        if (engine && engine.transport === 'h5' && typeof invoke.finalize === 'function') {
          const finalized = await invoke.finalize({ conversationId, runId: engine.runId ?? null, workspace: candidateDir, cwd: cwdReal, dataDir, log })
          report.finalize = finalized && typeof finalized === 'object' ? finalized : { merged: false, error: 'FINALIZE_NOT_CONFIRMED' }
          await verifyFrozen(frozen, `第 ${round} 轮合入后`)
          if (!(finalized && finalized.merged === true)) {
            lastFailure = `第 ${round} 轮 accepted 但候选目录未合入原目录，需人工确认后重跑`
            return await finish(exitCodeFor('waiting', 5), statusFor('waiting', STATUS.waiting, 'waiting'), lastFailure)
          }
          const mergedChecks = await runRoundChecks({ checks, cwd: cwdReal, timeoutMs, outputDir, frozen, labelPrefix: `round-${round}-merged` })
          report.mergedChecks = mergedChecks
          if (!(mergedChecks.length === checks.length && mergedChecks.every((item) => item.passed === true))) {
            lastFailure = `第 ${round} 轮已合入但原目录固定检查未全部通过`
            return await finish(exitCodeFor('checks', 3), statusFor('checks', STATUS.checks, 'checks'), lastFailure)
          }
        }
        await verifyFrozen(frozen, '最终成功前')
        return await finish(exitCodeFor('success', 0), STATUS.success, `第 ${round} 轮本次真实任务 accepted 且全部固定检查通过`)
      }

      lastFailure = `第 ${round} 轮未通过：accepted=${accepted}；失败检查：${roundChecks.filter((item) => item.passed !== true).map((item) => checkLabel(item)).join('、') || '(无)'}`
      log(lastFailure)
    }

    await verifyFrozen(frozen, '轮次用尽前')
    return await finish(exitCodeFor('checks', 3), statusFor('checks', STATUS.checks, 'checks'), `已用满 ${maxAttempts} 轮仍未同时满足本次真实任务 accepted 与全部固定检查通过`)
  } catch (error) {
    const kind = classifySelfHostFailure(error)
    const message = error && error.message ? String(error.message) : String(error)
    if (error?.h5ConversationId) report.conversationId = error.h5ConversationId
    if (error?.h5RunId) report.runId = error.h5RunId
    if (error?.h5TaskUrl) report.taskUrl = error.h5TaskUrl
    report.error = { kind, name: error && error.name ? String(error.name) : null, message }
    let code = exitCodeFor('engine', 5)
    let status = statusFor('engine', STATUS.engine, 'engine')
    let text = `主流程失败（${kind}）：${message}`
    if (kind === 'frozen') {
      code = exitCodeFor('freeze', 3)
      status = statusFor('tampered', STATUS.freeze, STATUS.freeze)
      text = `检测到冻文件被改动，已立即停止：${message}`
    } else if (kind === 'usage') {
      code = exitCodeFor('usage', 2)
      status = statusFor('usage', STATUS.usage, 'usage')
      text = message
    } else if (kind === 'log') {
      code = exitCodeFor('log', 4)
      status = statusFor('log', STATUS.log, 'log')
      text = `报告或日志写盘失败：${message}`
    } else if (kind === 'timeout') {
      code = exitCodeFor('timeout', 5)
      status = statusFor('timeout', STATUS.timeout, STATUS.timeout)
      text = `超时或被信号中断：${message}`
    }
    try {
      return await finish(code, status, text)
    } catch (writeError) {
      log(`${text}（报告写盘失败：${writeError && writeError.message ? writeError.message : String(writeError)}）`)
      return code
    }
  }
}

/* ------------------------------------------------------------------ *
 * 主流程辅助：退出码/状态映射、检查标签、失败归类
 * ------------------------------------------------------------------ */

export function exitCodeFor(kind, fallback = null) {
  const table = EXIT && typeof EXIT === 'object' ? EXIT : {}
  const value = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : null
  if (Number.isInteger(value)) return value
  if (Number.isInteger(fallback)) return fallback
  const engine = Number.isInteger(table.engine) ? table.engine : 5
  return engine
}

export function statusFor(kind, fallback = null) {
  const table = STATUS && typeof STATUS === 'object' ? STATUS : {}
  const value = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : null
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof fallback === 'string' && fallback.length > 0) return fallback
  return typeof kind === 'string' && kind.length > 0 ? kind : 'unknown'
}

export function checkLabel(check) {
  if (!check || typeof check !== 'object') return '(未知检查)'
  const argv = Array.isArray(check.argv) ? check.argv : []
  if (argv.length > 0) return argv.join(' ')
  if (typeof check.label === 'string' && check.label.length > 0) return check.label
  return '(未知检查)'
}

/** 失败归类：冻文件改动 / 用法 / 日志写盘 / 超时或信号，其余算引擎失败。 */
export function classifySelfHostFailure(error) {
  if (!error) return 'engine'
  const name = typeof error.name === 'string' ? error.name : ''
  const code = typeof error.code === 'string' ? error.code : ''
  const kind = typeof error.kind === 'string' ? error.kind : ''
  const message = typeof error.message === 'string' ? error.message : String(error)
  if (
    name === 'FrozenError' ||
    name === 'FreezeError' ||
    error.frozen === true ||
    kind === 'frozen' ||
    code === 'FROZEN_TAMPERED' ||
    code === 'FREEZE_TAMPERED' ||
    message.includes('FROZEN_TAMPERED') ||
    message.includes('FREEZE_TAMPERED') ||
    message.includes('冻文件') ||
    message.includes('冻结')
  ) {
    return 'frozen'
  }
  if (error instanceof UsageError || name === 'UsageError' || kind === 'usage') return 'usage'
  if (name === 'LogError' || kind === 'log' || code === 'LOG_WRITE_FAILED') return 'log'
  if (error.timedOut === true || error.aborted === true || name === 'AbortError' || kind === 'timeout' || kind === 'signal') return 'timeout'
  return 'engine'
}

/* ------------------------------------------------------------------ *
 * 逐条检查：每条检查结束立刻核冻，绝不等到整批跑完才复查
 * ------------------------------------------------------------------ */

export async function runRoundChecks({ checks, cwd, timeoutMs, outputDir, frozen = null, labelPrefix = 'round' } = {}) {
  const list = Array.isArray(checks) ? checks : []
  const collected = []
  for (let index = 0; index < list.length; index += 1) {
    const label = `${labelPrefix}-${index + 1}`
    const single = await runChecks({ checks: [list[index]], cwd, timeoutMs, outputDir, labelPrefix: label })
    const record = Array.isArray(single) && single.length > 0 ? single[0] : null
    if (record) collected.push(record)
    if (frozen) await verifyFrozen(frozen, `${label} 结束后`)
  }
  return collected
}

/* ------------------------------------------------------------------ *
 * CLI 入口：作为模块被 import 时不执行 main；只有直接运行时才跑。
 * ------------------------------------------------------------------ */

export function moduleFilePathFromUrl(metaUrl) {
  if (typeof metaUrl !== 'string' || metaUrl.length === 0) return null
  if (!metaUrl.startsWith('file://')) return null
  try {
    return fileURLToPath(metaUrl)
  } catch {
    return null
  }
}

export function isDirectCliInvocation(argv = typeof process === 'object' && process ? process.argv : []) {
  const entry = Array.isArray(argv) ? argv[1] : null
  if (typeof entry !== 'string' || entry.length === 0) return false
  const selfPath = moduleFilePathFromUrl(import.meta.url)
  if (!selfPath) return false
  const canonical = (target) => {
    try {
      return typeof fs.realpathSync === 'function' ? fs.realpathSync(target) : path.resolve(target)
    } catch {
      return path.resolve(target)
    }
  }
  return canonical(entry) === canonical(selfPath)
}

if (isDirectCliInvocation()) {
  installSignalHandlers()
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = Number.isInteger(code) ? code : 0
    },
    (error) => {
      const message = error && error.message ? String(error.message) : String(error)
      try {
        process.stderr.write(`${message}\n`)
      } catch {
        /* 输出失败也不能让入口崩溃 */
      }
      // 未知参数等用法错误必须退出 2；其余仍按引擎/内部错误码。
      process.exitCode = classifySelfHostFailure(error) === 'usage' ? exitCodeFor('usage', 2) : exitCodeFor('engine', 5)
    },
  )
}
