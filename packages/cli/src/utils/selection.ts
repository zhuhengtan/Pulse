import { stripTerminalControls } from './ansi.js'
import chalk from 'chalk'

export interface TextPoint { line: number; column: number }
export interface TextSelection { start: TextPoint; end: TextPoint }

function pointOrder(a: TextPoint, b: TextPoint): number {
  return a.line - b.line || a.column - b.column
}

export function orderedSelection(selection: TextSelection): TextSelection {
  return pointOrder(selection.start, selection.end) <= 0
    ? selection
    : { start: selection.end, end: selection.start }
}

function isCombining(character: string): boolean {
  return /[\p{Mark}\u200D\uFE0E\uFE0F]/u.test(character)
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function width(character: string): number {
  if (isCombining(character)) return 0
  const codePoint = character.codePointAt(0) ?? 0
  return isWide(codePoint) ? 2 : 1
}

function indexAtColumn(text: string, column: number): number {
  let cells = 0
  let index = 0
  for (const character of text) {
    const next = cells + width(character)
    if (column < next) return index
    cells = next
    index += character.length
  }
  return text.length
}

function indexAfterCellAtColumn(text: string, column: number): number {
  let cells = 0
  let index = 0
  for (const character of text) {
    const next = cells + width(character)
    if (column < next) return index + character.length
    cells = next
    index += character.length
  }
  return text.length
}

function rawOffsetAtVisibleIndex(raw: string, target: number): number {
  const control = /^(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\)|[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001B[@-_])/u
  let offset = 0
  let visible = 0
  while (offset < raw.length) {
    if (visible >= target) return offset
    const remaining = raw.slice(offset)
    const escape = control.exec(remaining)
    if (escape) { offset += escape[0].length; continue }
    const codePoint = raw.codePointAt(offset)!
    const character = String.fromCodePoint(codePoint)
    if (!/[\u0000-\u001f\u007f-\u009f]/u.test(character)) visible += character.length
    offset += character.length
  }
  return raw.length
}

/** Returns the visible text rows in selection order, with terminal styling removed. */
export function selectedText(lines: readonly string[], selection: TextSelection): string {
  const ordered = orderedSelection(selection)
  const firstLine = Math.max(0, Math.min(lines.length - 1, ordered.start.line))
  const lastLine = Math.max(firstLine, Math.min(lines.length - 1, ordered.end.line))
  const result: string[] = []
  for (let line = firstLine; line <= lastLine; line++) {
    const plain = stripTerminalControls(lines[line] ?? '')
    const from = line === firstLine ? ordered.start.column : 0
    const start = indexAtColumn(plain, from)
    const end = line === lastLine ? indexAfterCellAtColumn(plain, ordered.end.column) : plain.length
    result.push(plain.slice(Math.min(start, end), Math.max(start, end)))
  }
  return result.join('\n')
}

/** Adds a calm, high-contrast selection without terminal reverse-video. */
export function selectedLine(line: string, lineIndex: number, selection?: TextSelection): string {
  if (!selection) return line
  const plain = stripTerminalControls(line)
  const ordered = orderedSelection(selection)
  if (lineIndex < ordered.start.line || lineIndex > ordered.end.line) return line
  const from = lineIndex === ordered.start.line ? ordered.start.column : 0
  const start = indexAtColumn(plain, from)
  const end = lineIndex === ordered.end.line ? indexAfterCellAtColumn(plain, ordered.end.column) : plain.length
  const mark = chalk.bgHex('#DDF4F1').hex('#173B3A')
  const rawStart = rawOffsetAtVisibleIndex(line, start)
  const rawEnd = rawOffsetAtVisibleIndex(line, end)
  return `${line.slice(0, rawStart)}${mark(plain.slice(start, end))}${line.slice(rawEnd)}`
}
