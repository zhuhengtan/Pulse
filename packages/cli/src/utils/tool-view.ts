import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { theme } from '../theme.js'
import type { ToolCallDisplay, ToolCallPreview, Verbosity } from '../types.js'
import { stripAnsi, stripTerminalControls } from './ansi.js'

const verbs: Record<string, string> = {
  'fs.read': '读取',
  'fs.search': '搜索',
  'fs.list': '列出',
  'fs.write': '新建',
  'fs.apply_patch': '编辑',
  'fs.apply_patches': '编辑',
  'fs.stage': '写入',
  'fs.move': '移动',
  'shell.exec': '运行',
  'web.fetch': '获取',
  'web.search': '检索',
}

const lineCap = 24
const lineWidth = 160
const contextLines = 2

export interface ToolView {
  lines: string[]
  truncated: boolean
  totalChars: number
  shownChars: number
}

interface DiffOp { op: ' ' | '-' | '+'; text: string; line: number }

export function renderToolCalls(calls: ToolCallDisplay[], options: { verbosity?: Verbosity; width?: number } = {}): ToolView {
  const width = Math.max(8, options.width ?? 80)
  const views = calls.map((call) => renderToolCall(call, { ...options, width }))
  return {
    lines: views.flatMap((view) => view.lines),
    truncated: views.some((view) => view.truncated),
    totalChars: views.reduce((sum, view) => sum + view.totalChars, 0),
    shownChars: views.reduce((sum, view) => sum + view.shownChars, 0),
  }
}

export function toolCallFromObservation(data: unknown): ToolCallDisplay | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const obs = data as Record<string, unknown>
  if (typeof obs.tool !== 'string') return undefined
  const preview = parsePreview(obs.preview)
  return {
    id: String(obs.toolCallId ?? obs.tool),
    name: obs.tool,
    arguments: record(obs.args),
    status: toolStatus(obs.status),
    ...(obs.result === undefined ? {} : { result: obs.result }),
    ...(preview === undefined ? {} : { preview }),
  }
}

export function runningToolCalls(data: unknown): ToolCallDisplay[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const fact = data as Record<string, unknown>
  if (fact.type !== 'lane.snapshot' || !Array.isArray(fact.lanes)) return []
  const calls: ToolCallDisplay[] = []
  for (const lane of fact.lanes) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) continue
    const item = lane as Record<string, unknown>
    const activities = Array.isArray(item.activities) ? item.activities : [item]
    for (const activity of activities) {
      if (!activity || typeof activity !== 'object' || Array.isArray(activity)) continue
      const row = activity as Record<string, unknown>
      if (row.activityKind !== 'tool' || typeof row.activity !== 'string' || typeof row.activityToolCallId !== 'string') continue
      calls.push({
        id: row.activityToolCallId,
        name: row.activity,
        status: 'running',
        arguments: record(row.activityArguments),
      })
    }
  }
  return calls
}

export function consumeToolEvent(event: { type: string; data?: unknown }, printed: Set<string>, width: number): string[] {
  const calls = event.type === 'observation'
    ? [toolCallFromObservation(event.data)].filter((call): call is ToolCallDisplay => call !== undefined)
    : event.type === 'fact'
      ? runningToolCalls(event.data)
      : []
  const lines: string[] = []
  for (const call of calls) {
    const key = `${call.id}\0${call.status}\0${JSON.stringify(call.arguments ?? {})}\0${call.preview?.output ?? ''}`
    if (printed.has(key)) continue
    printed.add(key)
    lines.push(...renderToolCalls([call], { width }).lines)
  }
  return lines
}

function renderToolCall(call: ToolCallDisplay, options: { verbosity?: Verbosity; width: number }): ToolView {
  const args = call.arguments ?? {}
  const source = editableText(args)
  const width = options.width
  const header = fit(headerLine(call), width)
  const detail = detailLines(call, width)
  const extra = options.verbosity === 'verbose' && call.result !== undefined ? resultLines(call.result, width) : []
  const lines = [...header, ...detail.lines, ...extra]
  const truncated = detail.truncated
  return {
    lines,
    truncated: detail.shownChars < source.length || truncated,
    totalChars: source.length,
    shownChars: detail.shownChars,
  }
}

function headerLine(call: ToolCallDisplay): string {
  const glyph = call.status === 'running'
    ? chalk.yellow('◐')
    : call.status === 'failed'
      ? chalk.red('✗')
      : call.status === 'cancelled'
        ? chalk.dim('⊘')
        : chalk.green('●')
  const verb = chalk.hex(theme.tool)(verbs[call.name] ?? call.name)
  const target = targetText(call)
  const stat = diffStat(call)
  return `${glyph} ${verb}${target ? `  ${chalk.dim(target)}` : ''}${stat ? `  ${stat}` : ''}`
}

function targetText(call: ToolCallDisplay): string {
  const args = call.arguments ?? {}
  if (call.name === 'shell.exec') return shellCommand(args)
  if (call.name === 'fs.move') return joinPair(text(args, 'source'), text(args, 'destination'), ' → ')
  if (call.name === 'fs.stage') return stageTarget(args)
  if (call.name === 'web.fetch') return text(args, 'url')
  if (call.name === 'web.search' || call.name === 'fs.search') return text(args, 'query')
  return text(args, 'path')
}

function detailLines(call: ToolCallDisplay, width: number): { lines: string[]; shownChars: number; truncated: boolean } {
  const args = call.arguments ?? {}
  const failure = failureText(call)
  const failed = failure ? fit(`  └ ${failure}`, width) : []
  if (call.name === 'fs.apply_patch' || call.name === 'fs.apply_patches' || isContentWrite(call)) {
    const diff = editLines(call, width)
    return { lines: [...diff.lines, ...failed], shownChars: diff.shownChars, truncated: diff.truncated }
  }
  const lines: string[] = []
  if (call.name === 'shell.exec') {
    const cwd = text(args, 'cwd')
    if (cwd && cwd !== '.') lines.push(...fit(`  └ 目录 ${cwd}`, width))
    const output = call.preview?.output ? stripTerminalControls(call.preview.output) : ''
    if (output) lines.push(...prefixBlock(output, width))
    if (failed.length) lines.push(...failed)
    else if (call.status === 'succeeded' && !output) lines.push(...fit('  └ 已完成', width))
    if (call.preview?.truncated) lines.push(...fit(chalk.dim('  └ 输出已截断'), width))
    return { lines, shownChars: editableText(args).length, truncated: false }
  }
  if (failed.length) return { lines: failed, shownChars: editableText(args).length, truncated: false }
  const summary = summaryLine(call)
  if (summary) lines.push(...fit(`  └ ${summary}`, width))
  for (const location of call.preview?.locations ?? []) lines.push(...fit(chalk.dim(`    ${stripTerminalControls(location)}`), width))
  if (!lines.length && call.name !== 'fs.read' && call.name !== 'fs.search' && call.name !== 'fs.list' && call.name !== 'fs.stage' && call.name !== 'fs.move' && call.name !== 'web.fetch' && call.name !== 'web.search') {
    const dumped = dumpArgs(args)
    if (dumped.clipped) return { lines: fit(chalk.dim(dumped.text), width), shownChars: 0, truncated: true }
    if (dumped.text && dumped.text !== '{}') return { lines: fit(chalk.dim(dumped.text), width), shownChars: editableText(args).length, truncated: false }
  }
  return { lines, shownChars: editableText(args).length, truncated: false }
}

function isContentWrite(call: ToolCallDisplay): boolean {
  return call.name === 'fs.write' || call.name === 'fs.stage' && typeof call.arguments?.content === 'string'
}

function editLines(call: ToolCallDisplay, width: number): { lines: string[]; shownChars: number; truncated: boolean } {
  const args = call.arguments ?? {}
  const hunks = isContentWrite(call)
    ? [{ find: '', replace: text(args, 'content') }]
    : call.name === 'fs.apply_patches'
      ? patches(args)
      : [{ find: text(args, 'find'), replace: text(args, 'replace') }]
  const source = editableText(args)
  const rendered: string[] = []
  let hidden = 0
  let omittedChars = 0
  if (args.all === true) rendered.push(...fit(chalk.dim('  └ 全部匹配'), width))
  for (const [index, hunk] of hunks.entries()) {
    if (index > 0) rendered.push(chalk.dim('    @@'))
    const ops = hunk.find === '' && isContentWrite(call)
      ? hunk.replace.split('\n').map((line, lineIndex) => ({ op: '+' as const, text: line, line: lineIndex + 1 }))
      : diffLines(hunk.find, hunk.replace)
    const window = windowOps(ops)
    hidden += window.hidden
    for (const op of ops) if (!window.shown.includes(op)) omittedChars += op.text.length + 1
    for (const op of window.shown) {
      const visible = clipLine(stripTerminalControls(op.text))
      if (visible.clipped) omittedChars += Math.max(0, stripTerminalControls(op.text).length - lineWidth)
      const sign = op.op === ' ' ? ' ' : op.op
      const body = `${String(op.line).padStart(4)} │${sign} ${visible.text}`
      const colored = op.op === '+' ? chalk.green(body) : op.op === '-' ? chalk.red(body) : chalk.dim(body)
      rendered.push(...fit(`    ${colored}`, width))
    }
  }
  if (hidden > 0) rendered.push(...fit(chalk.dim(`    … 还有 ${hidden} 行`), width))
  return { lines: rendered, shownChars: Math.max(0, source.length - omittedChars), truncated: hidden > 0 || omittedChars > 0 }
}

function summaryLine(call: ToolCallDisplay): string {
  const preview = call.preview
  if (!preview) return call.status === 'succeeded' && call.name === 'fs.stage' ? '已完成' : ''
  if (call.name === 'fs.read' || call.name === 'web.fetch') {
    const size = typeof preview.bytes === 'number' ? formatBytes(preview.bytes) : ''
    const lines = typeof preview.lines === 'number' ? `${preview.lines} 行` : ''
    return [lines, size, preview.truncated ? '未读完' : ''].filter(Boolean).join(' · ')
  }
  if (call.name === 'fs.search' || call.name === 'web.search') return `${preview.matched ?? preview.locations?.length ?? 0} 处`
  if (call.name === 'fs.list') return `${preview.matched ?? preview.locations?.length ?? 0} 项`
  if (typeof preview.replacements === 'number' && preview.replacements > 1) return `${preview.replacements} 处`
  return ''
}

function failureText(call: ToolCallDisplay): string {
  if (call.status !== 'failed' && call.status !== 'cancelled') return ''
  const label = call.status === 'cancelled' ? '已取消' : '失败'
  const result = call.result
  if (typeof result === 'string' && result) return `${label} · ${stripTerminalControls(result)}`
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>
    const message = typeof record.message === 'string' ? record.message : undefined
    const code = typeof record.code === 'string' ? record.code : undefined
    const detail = message ?? code
    if (detail) return `${label} · ${stripTerminalControls(detail)}`
  }
  return label
}

function resultLines(result: unknown, width: number): string[] {
  const text = stripTerminalControls(typeof result === 'string' ? result : safeJson(result))
  const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text
  return fit(chalk.dim(clipped), width)
}

function diffStat(call: ToolCallDisplay): string {
  if (call.name !== 'fs.apply_patch' && call.name !== 'fs.apply_patches' && !isContentWrite(call)) return ''
  const counts = countEdits(call)
  if (counts.add === 0 && counts.del === 0) return ''
  return `${chalk.green(`+${counts.add}`)} ${chalk.red(`−${counts.del}`)}`
}

function countEdits(call: ToolCallDisplay): { add: number; del: number } {
  const args = call.arguments ?? {}
  const hunks = isContentWrite(call)
    ? [{ find: '', replace: text(args, 'content') }]
    : call.name === 'fs.apply_patches' ? patches(args) : [{ find: text(args, 'find'), replace: text(args, 'replace') }]
  return hunks.reduce((sum, hunk) => {
    if (isContentWrite(call)) return { add: sum.add + hunk.replace.split('\n').filter((line) => line.length > 0).length, del: sum.del }
    for (const op of diffLines(hunk.find, hunk.replace)) {
      if (op.op === '+') sum.add += 1
      if (op.op === '-') sum.del += 1
    }
    return sum
  }, { add: 0, del: 0 })
}

function diffLines(before: string, after: string): DiffOp[] {
  return diffLineArrays(before.split('\n'), after.split('\n'))
}

function diffLineArrays(left: string[], right: string[]): DiffOp[] {
  if (left.length * right.length > 20_000) {
    // Trim shared edges before the quadratic diff so a long fragment with one
    // tail edit still displays that edit, rather than an unrelated prefix.
    let prefix = 0
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
    let suffix = 0
    while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++
    if (prefix || suffix) return [
      ...left.slice(0, prefix).map((text, index) => ({ op: ' ' as const, text, line: index + 1 })),
      ...diffLineArrays(left.slice(prefix, left.length - suffix), right.slice(prefix, right.length - suffix)).map((op) => ({ ...op, line: op.line + prefix })),
      ...left.slice(left.length - suffix).map((text, index) => ({ op: ' ' as const, text, line: left.length - suffix + index + 1 })),
    ]
    // A linear fallback retains every operation; only the display window clips
    // them, so hidden lines and the approval truncation warning stay accurate.
    return [
      ...left.map((text, index) => ({ op: '-' as const, text, line: index + 1 })),
      ...right.map((text, index) => ({ op: '+' as const, text, line: index + 1 })),
    ]
  }
  const scores = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      scores[i]![j] = left[i] === right[j] ? scores[i + 1]![j + 1]! + 1 : Math.max(scores[i + 1]![j]!, scores[i]![j + 1]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ op: ' ', text: left[i]!, line: i + 1 })
      i += 1
      j += 1
    } else if (scores[i + 1]![j]! >= scores[i]![j + 1]!) {
      ops.push({ op: '-', text: left[i]!, line: i + 1 })
      i += 1
    } else {
      ops.push({ op: '+', text: right[j]!, line: j + 1 })
      j += 1
    }
  }
  while (i < left.length) { ops.push({ op: '-', text: left[i]!, line: i + 1 }); i += 1 }
  while (j < right.length) { ops.push({ op: '+', text: right[j]!, line: j + 1 }); j += 1 }
  return ops
}

function windowOps(ops: DiffOp[]): { shown: DiffOp[]; hidden: number } {
  const keep = new Set<number>()
  ops.forEach((op, index) => {
    if (op.op === ' ') return
    for (let cursor = index - contextLines; cursor <= index + contextLines; cursor += 1) if (cursor >= 0 && cursor < ops.length) keep.add(cursor)
  })
  const interesting = keep.size ? ops.filter((_, index) => keep.has(index)) : ops.slice(0, contextLines)
  if (interesting.length <= lineCap) return { shown: interesting, hidden: ops.length - interesting.length }
  return { shown: interesting.slice(0, lineCap), hidden: ops.length - lineCap }
}

function patches(args: Record<string, unknown>): Array<{ find: string; replace: string }> {
  if (!Array.isArray(args.patches)) return []
  return args.patches.flatMap((patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return []
    const row = patch as Record<string, unknown>
    return [{ find: text(row, 'find'), replace: text(row, 'replace') }]
  })
}

function shellCommand(args: Record<string, unknown>): string {
  const command = text(args, 'command')
  const values = Array.isArray(args.args) ? args.args.map((arg) => shellToken(stripTerminalControls(String(arg)))) : []
  return [command, ...values].filter(Boolean).join(' ')
}

function stageTarget(args: Record<string, unknown>): string {
  const operation = text(args, 'operation') || text(args, 'op')
  const path = text(args, 'path')
  const draft = text(args, 'draftId')
  if (operation && path) return `${operation} ${path}`
  if (operation) return draft ? `${operation} ${draft.slice(0, 8)}` : operation
  return path
}

function prefixBlock(output: string, width: number): string[] {
  const rows = output.split('\n')
  return rows.flatMap((row, index) => fit(`${index === 0 ? '  └ ' : '    '}${row}`, width))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  return kilobytes < 10 ? `${kilobytes.toFixed(1)} KB` : `${Math.round(kilobytes)} KB`
}

function editableText(args: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof args.content === 'string') parts.push(args.content)
  if (typeof args.find === 'string') parts.push(args.find)
  if (typeof args.replace === 'string') parts.push(args.replace)
  for (const hunk of patches(args)) parts.push(hunk.find, hunk.replace)
  return parts.join('')
}

function dumpArgs(args: Record<string, unknown>): { text: string; clipped: boolean } {
  const visible = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'expectedHash' && key !== 'hash'))
  const text = safeJson(visible)
  if (text.length <= 1_000) return { text, clipped: false }
  return { text: `${text.slice(0, 1_000)}\n…`, clipped: true }
}

function clipLine(value: string): { text: string; clipped: boolean } {
  if (value.length <= lineWidth) return { text: value, clipped: false }
  return { text: `${value.slice(0, lineWidth)}…`, clipped: true }
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? stripTerminalControls(value) : ''
}

function joinPair(left: string, right: string, separator: string): string {
  return [left, right].filter(Boolean).join(separator)
}

function shellToken(value: string): string {
  if (value.length === 0) return "''"
  if (/^[\w./:@%+=,~-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fit(line: string, width: number): string[] {
  if (stripAnsi(line).length <= width) return [line]
  return wrapAnsi(line, width, { hard: true, trim: false }).split('\n')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function toolStatus(value: unknown): ToolCallDisplay['status'] {
  if (value === 'succeeded' || value === 'failed' || value === 'running' || value === 'cancelled') return value
  return 'running'
}

function parsePreview(value: unknown): ToolCallPreview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const preview: ToolCallPreview = {}
  if (typeof row.bytes === 'number') preview.bytes = row.bytes
  if (typeof row.lines === 'number') preview.lines = row.lines
  if (row.truncated === true) preview.truncated = true
  if (typeof row.matched === 'number') preview.matched = row.matched
  if (Array.isArray(row.locations)) preview.locations = row.locations.filter((item): item is string => typeof item === 'string').slice(0, 5)
  if (typeof row.exitCode === 'number' || row.exitCode === null) preview.exitCode = row.exitCode
  if (typeof row.output === 'string') preview.output = row.output
  if (typeof row.replacements === 'number') preview.replacements = row.replacements
  return Object.keys(preview).length ? preview : undefined
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}
