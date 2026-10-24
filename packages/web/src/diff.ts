export interface DiffLine { kind: 'context' | 'add' | 'delete' | 'meta'; text: string; oldLine?: number; newLine?: number }
export interface SplitLine { kind: 'pair' | 'meta'; left?: DiffLine; right?: DiffLine; text?: string }

export interface DiffHunk {
  header: string
  original: string
  modified: string
  oldStart: number
  newStart: number
}
export interface DiffFile { path: string; metadata: string[]; hunks: DiffHunk[] }

/** Keep disjoint hunks separate: omitted source must never become fabricated code. */
export function diffFiles(text: string, fallbackPath = '变更文件'): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined, hunk: DiffHunk | undefined
  let previous: DiffLine['kind'] | undefined
  for (const line of parseDiff(text)) {
    if (!file || (line.kind === 'meta' && line.text.startsWith('diff --git '))) {
      file = { path: fallbackPath, metadata: [], hunks: [] }
      files.push(file); hunk = undefined
    }
    if (line.kind === 'meta') {
      const match = line.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        hunk = { header: line.text, original: '', modified: '', oldStart: Number(match[1]), newStart: Number(match[2]) }
        file.hunks.push(hunk)
      } else if (line.text.startsWith('\\ No newline') && hunk) {
        if (previous === 'delete' || previous === 'context') hunk.original = hunk.original.replace(/\n$/, '')
        if (previous === 'add' || previous === 'context') hunk.modified = hunk.modified.replace(/\n$/, '')
      } else {
        file.metadata.push(line.text)
        const headerPath = line.text.match(/^(?:\+\+\+ |--- )(.+)$/)?.[1]
        if (headerPath && headerPath !== '/dev/null') {
          let path = headerPath.replace(/\t.*$/, '')
          if (path.startsWith('"')) { try { path = JSON.parse(path) as string } catch { /* Keep Git's escaped name. */ } }
          file.path = path.replace(/^[ab]\//, '')
        } else if (line.text.startsWith('rename to ')) file.path = line.text.slice(10)
        else if (line.text.startsWith('diff --git ')) file.path = line.text.match(/ b\/(.+)$/)?.[1] ?? fallbackPath
      }
    } else if (hunk) {
      if (line.kind !== 'add') hunk.original += line.text + '\n'
      if (line.kind !== 'delete') hunk.modified += line.text + '\n'
    }
    previous = line.kind
  }
  return files
}

/** Hunk counts, not +/- prefixes alone, distinguish file headers from source lines. */
export function parseDiff(text: string): DiffLine[] {
  const source = text.split('\n'); if (source.at(-1) === '') source.pop()
  const lines: DiffLine[] = []
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0
  for (const raw of source) {
    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1)
      lines.push({ kind: 'meta', text: raw }); continue
    }
    const inHunk = oldRemaining > 0 || newRemaining > 0
    if (inHunk && raw.startsWith('-') && oldRemaining > 0) { lines.push({ kind: 'delete', text: raw.slice(1), oldLine: oldLine++ }); oldRemaining-- }
    else if (inHunk && raw.startsWith('+') && newRemaining > 0) { lines.push({ kind: 'add', text: raw.slice(1), newLine: newLine++ }); newRemaining-- }
    else if (inHunk && raw.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) { lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ }); oldRemaining--; newRemaining-- }
    else lines.push({ kind: 'meta', text: raw })
  }
  return lines
}

export function splitDiff(lines: DiffLine[]): SplitLine[] {
  const rows: SplitLine[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (line.kind === 'meta') { rows.push({ kind: 'meta', text: line.text }); index++; continue }
    if (line.kind === 'context') { rows.push({ kind: 'pair', left: line, right: line }); index++; continue }
    const left: DiffLine[] = [], right: DiffLine[] = []
    while (index < lines.length && (lines[index]!.kind === 'delete' || lines[index]!.kind === 'add')) {
      const change = lines[index++]!; (change.kind === 'delete' ? left : right).push(change)
    }
    for (let i = 0; i < Math.max(left.length, right.length); i++) rows.push({ kind: 'pair', ...(left[i] ? { left: left[i]! } : {}), ...(right[i] ? { right: right[i]! } : {}) })
  }
  return rows
}
