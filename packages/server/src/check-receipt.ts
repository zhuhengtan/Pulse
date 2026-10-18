import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'

export interface CheckReceipt {
  schemaVersion: 1
  command: string
  args: string[]
  cwd: string
  files: Record<string, string>
  definitions: Record<string, string>
  environment: { platform: string; node: string }
  stable: boolean
  definitionChanged: boolean
}
export const isCheck = (command: string, args: string[]) => /(?:--(?:test|check)|(?:test|check|verify|lint|typecheck|pytest|vitest|jest)(?:[.\s/\\-]|$))/i.test([command, ...args].join(' '))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export function testAdditionsRequested(intent: string): boolean {
  // Regression assertions are explicit test additions too. Keep the same
  // subject vocabulary for grants and prohibitions; runtime assertions alone
  // do not authorize extending frozen tests.
  const subject = String.raw`(?:测试|回归断言|\btests?\b|\bregression\s+assertions?\b)`
  if (new RegExp(String.raw`(?:不要|禁止|不得|(?<!分)别)[^。\n]{0,40}(?:补充|新增|添加|扩展|编写|修改|改动|改|动|实现|完善|完成)[^。\n]{0,60}${subject}|(?:不要|禁止|不得|(?<!分)别)[^。\n]{0,40}${subject}[^。\n]{0,60}(?:实现|完善|完成|修改|改动|改|动)|\b(?:do not|don't|never)\s+(?:add|extend|write|change|modify|edit|touch|implement|complete)[^.!\n]{0,60}${subject}`, 'i').test(intent)) return false
  return new RegExp(String.raw`(?:补充|新增|添加|扩展|编写|实现|完善)[^。\n，,；;]{0,120}${subject}|(?:把|将)[^。\n，,；;]{0,80}${subject}[^。\n，,；;]{0,80}(?:实现|完善|完成)|\b(?:add|extend|write|implement|complete)[^.!\n,;]{0,120}${subject}`, 'i').test(intent)
}
export function candidateTestChangesAllowed(intent: string): boolean {
  // Preserving existing tests does not forbid iterating on new candidate tests.
  // Explicit restrictions on creating tests or changing any tests still apply.
  return !/(?:不要|禁止|不得|(?<!分)别)[^。\n，,；;]{0,40}(?:新增|添加|创建|编写|补充|实现|完善|完成)[^。\n，,；;]{0,60}(?:测试|回归断言)|(?:不要|禁止|不得|(?<!分)别)(?:修改|改动|编辑|改|动)(?:任何|所有)?测试|\b(?:do not|don't|never)\s+(?:add|create|write|extend|implement|complete)[^.!\n,;]{0,60}\btests?\b|\b(?:do not|don't|never)\s+(?:modify|change|edit|touch)\s+(?:(?:any|all)\s+)?tests?\b/i.test(intent)
}
const testFile = (path: string) => /(?:^|[/\\])(?:tests?|__tests__)(?:[/\\])|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)

function preservesTestBaseline(_root: string, _path: string, original: string, current: string): boolean {
  // The original file must stay a byte-for-byte prefix. Imports are hoisted and
  // top-level statements run before node:test assertions, so only additional
  // test()/it() registrations may follow that prefix.
  return current.startsWith(original) && appendedTestRegistrations(current.slice(original.length))
}

/** True when the suffix only registers more test cases and cannot run first. */
function appendedTestRegistrations(suffix: string): boolean {
  let i = 0
  const n = suffix.length
  const identChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c)
  const skipTrivia = (): void => {
    for (;;) {
      while (i < n && /[\s;,]/.test(suffix[i]!)) i++
      if (suffix.startsWith('//', i)) {
        const nl = suffix.indexOf('\n', i)
        i = nl < 0 ? n : nl + 1
        continue
      }
      if (suffix.startsWith('/*', i)) {
        const end = suffix.indexOf('*/', i + 2)
        if (end < 0) { i = n; return }
        i = end + 2
        continue
      }
      return
    }
  }
  const skipQuoted = (quote: "'" | '"' | '`'): boolean => {
    i++
    while (i < n) {
      const c = suffix[i]!
      if (c === '\\') { i += 2; continue }
      if (quote === '`' && c === '$' && suffix[i + 1] === '{') {
        i += 2
        if (!skipCode('}')) return false
        continue
      }
      i++
      if (c === quote) return true
    }
    return false
  }
  const skipRegex = (): boolean => {
    i++
    let inClass = false
    while (i < n) {
      const c = suffix[i]!
      if (c === '\\') { i += 2; continue }
      if (c === '[' && !inClass) { inClass = true; i++; continue }
      if (c === ']' && inClass) { inClass = false; i++; continue }
      if (c === '\n') return false
      i++
      if (c === '/' && !inClass) {
        while (i < n && /[a-z]/i.test(suffix[i]!)) i++
        return true
      }
    }
    return false
  }
  const skipCode = (terminator: string): boolean => {
    let depth = 0
    let expression = true
    while (i < n) {
      const c = suffix[i]!
      if (c === "'" || c === '"' || c === '`') {
        if (!skipQuoted(c)) return false
        expression = false
        continue
      }
      if (c === '/' && suffix[i + 1] === '/') {
        const nl = suffix.indexOf('\n', i)
        i = nl < 0 ? n : nl + 1
        continue
      }
      if (c === '/' && suffix[i + 1] === '*') {
        const end = suffix.indexOf('*/', i + 2)
        if (end < 0) return false
        i = end + 2
        continue
      }
      if (c === '/' && expression) {
        if (!skipRegex()) return false
        expression = false
        continue
      }
      if (depth === 0 && c === terminator) { i++; return true }
      if (c === '(' || c === '{' || c === '[') { depth++; expression = true; i++; continue }
      if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) return false
        depth--
        expression = false
        i++
        continue
      }
      if (!/\s/.test(c)) expression = /[+\-*/%=<>!&|^~?:;,({[]/.test(c)
      i++
    }
    return false
  }
  while (i < n) {
    skipTrivia()
    if (i >= n) return true
    const start = i
    while (identChar(suffix[i])) i++
    const name = suffix.slice(start, i)
    if (name !== 'test' && name !== 'it') return false
    skipTrivia()
    if (suffix[i] === '.') {
      i++
      skipTrivia()
      const modifierStart = i
      while (identChar(suffix[i])) i++
      if (!['only', 'skip', 'todo'].includes(suffix.slice(modifierStart, i))) return false
      skipTrivia()
    }
    if (suffix[i] !== '(') return false
    i++
    if (!skipCode(')')) return false
  }
  return true
}

/** Reject a destructive test patch before it can corrupt caller-owned checks. */
export async function assertCheckEdit(root: string, store: string, path: string, proposed: string): Promise<void> {
  const key = relative(resolve(root), resolve(root, path))
  if (!testFile(key) || key === '..' || key.startsWith(`..${sep}`)) return
  let original: Record<string, string>
  try { original = JSON.parse(await fs.readFile(join(store, 'original.json'), 'utf8')) }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error }
  if (original[key] === undefined || hash(proposed) === original[key]) return
  let sources: Record<string, string> = {}
  try { sources = JSON.parse(await fs.readFile(join(store, 'test-sources.json'), 'utf8')) }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
  if (sources[key] !== undefined && preservesTestBaseline(root, key, sources[key]!, proposed)) return
  throw Object.assign(new Error('FROZEN_TEST_CHANGE: no file written. Preserve every original import and the complete original test body, including placeholder assertions. If test additions are authorized, append new cases after that body; otherwise create a separate candidate test. Do not replace or remove the baseline.'), { code: 'FROZEN_TEST_CHANGE', details: { path: key, additionsAllowed: sources[key] !== undefined, suggestedRead: { path: key }, nextTools: ['fs.read', 'fs.apply_patch'] } })
}

/** Named checks include their local import closure. Project scripts use a conservative source tree. */
export async function captureCheck(root: string, cwd: string, command: string, args: string[], allDefinitions = false): Promise<CheckReceipt> {
  root = await fs.realpath(root)
  cwd = await fs.realpath(cwd)
  const files = new FilesystemTool(root), versions: Record<string, string> = {}, definitions: Record<string, string> = {}
  const pending = args.filter(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]sx?|py|sh)$/.test(arg)).map(arg => resolve(cwd, arg))
  const named = pending.length > 0
  if (!named) {
    // Include tracked checks even if ignored later, but exclude ignored generated
    // run data. A broad filesystem walk otherwise freezes old Runtime snapshots.
    let inventory: string | undefined
    try {
      inventory = (await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout
    } catch (error) {
      if ((error as { code?: string | number }).code !== 'ENOENT' && !/not a git repository/i.test(String((error as { stderr?: string }).stderr ?? ''))) throw error
    }
    if (inventory !== undefined) {
      for (const path of inventory.split('\0')) {
        if (!path || path.split(/[/\\]/).some(part => /^(?:\.|node_modules$|dist$|build$|coverage$|data$|logs$)/.test(part))) continue
        if (/\.(?:[cm]?[jt]sx?|py|sh|json|toml|yaml|yml)$/.test(path)) pending.push(resolve(cwd, path))
      }
      if (pending.length > 20_000) throw Object.assign(new Error('Check scope exceeds bounded manifest; use a named check.'), { code: 'CHECK_SCOPE_TOO_LARGE' })
    } else {
    const visit = async (dir: string): Promise<void> => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (/^(?:\.|node_modules$|dist$|build$|coverage$|data$|logs$)/.test(item.name)) continue
        const path = join(dir, item.name)
        if (item.isDirectory()) await visit(path)
        else if (item.isFile() && /\.(?:[cm]?[jt]sx?|py|sh|json|toml|yaml|yml)$/.test(item.name)) pending.push(path)
        if (pending.length > 20_000) throw Object.assign(new Error('Check scope exceeds bounded manifest; use a named check.'), { code: 'CHECK_SCOPE_TOO_LARGE' })
      }
    }
    await visit(cwd)
    }
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'tsconfig.json']) pending.push(join(cwd, name))
  let bytes = 0
  while (pending.length) {
    const path = pending.pop()!, key = relative(root, path)
    if (key.startsWith(`..${sep}`) || key === '..' || versions[key]) continue
    let text: string
    try { const read = await files.readLimited(path, 1_000_000); if (read.truncated) throw Object.assign(new Error('Check input exceeds per-file manifest bound.'), { code: 'CHECK_SCOPE_TOO_LARGE' }); text = read.content } catch (e) { if ((e as { code?: string }).code === 'ENOENT') continue; throw e }
    bytes += Buffer.byteLength(text)
    if (bytes > 64 * 1024 * 1024) throw Object.assign(new Error('Check manifest exceeds byte budget.'), { code: 'CHECK_SCOPE_TOO_LARGE' })
    versions[key] = hash(text)
    if (/(?:test|spec|check|verify|lint)/i.test(key)) definitions[key] = versions[key]!
    if (/(?:^|[/\\])package\.json$/.test(key)) {
      const body = JSON.parse(text) as { scripts?: Record<string, string> }
      const script = args.filter(arg => !arg.startsWith('-')); const selected = script[0] === 'run' ? script[1] : script[0]
      for (const [name, scriptCommand] of Object.entries(body.scripts ?? {})) if (allDefinitions || /^(?:npm|pnpm|yarn|bun)$/.test(command) && name === selected) definitions[`${key}#scripts:${name}`] = hash(scriptCommand)
    }
    if (named) for (const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[1]!)
      for (const candidate of [base, base.replace(/\.js$/, '.ts'), ...['.ts', '.js', '.mjs', '.tsx', '/index.ts', '/index.js'].map(ext => base + ext)]) {
        if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) { pending.push(candidate); break }
      }
    }
  }
  return { schemaVersion: 1, command, args, cwd: relative(root, cwd) || '.', files: versions, definitions, environment: { platform: process.platform, node: process.version }, stable: true, definitionChanged: false }
}

/** First observed check definition is frozen in Host data, never in the agent workspace. */
export async function finishCheck(root: string, before: CheckReceipt, store?: string): Promise<CheckReceipt> {
  const after = await captureCheck(root, resolve(root, before.cwd), before.command, before.args)
  before.stable = JSON.stringify(before.files) === JSON.stringify(after.files)
  if (store) {
    await fs.mkdir(store, { recursive: true })
    const path = join(store, `${hash(JSON.stringify([before.command, before.args, before.cwd]))}.json`)
    let initial: Record<string, string>
    try { await fs.writeFile(path, JSON.stringify(before.definitions), { flag: 'wx', mode: 0o600 }); initial = before.definitions }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; initial = JSON.parse(await fs.readFile(path, 'utf8')) }
    // Only explicit test-addition tasks can extend caller-owned frozen tests.
    // The baseline stays a byte-for-byte prefix, and only extra test()/it()
    // registrations may follow it. Imports, hooks and other top-level code
    // still invalidate the receipt. Host-owned assertions are never rebased.
    let sources: Record<string, string> = {}
    let additionsAllowed = false
    try { sources = JSON.parse(await fs.readFile(join(store, 'test-sources.json'), 'utf8')); additionsAllowed = true }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    let originalDefinitions: Record<string, string> = {}
    let originalSnapshot = false
    try { originalDefinitions = JSON.parse(await fs.readFile(join(store, 'original.json'), 'utf8')); originalSnapshot = true }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    let candidatePolicy: boolean | undefined
    try { candidatePolicy = JSON.parse(await fs.readFile(join(store, 'candidate-test-policy.json'), 'utf8')).mutable === true }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    const changed = async (path: string, expected: string): Promise<boolean> => {
      const candidate = originalSnapshot && /\.(?:[cm]?[jt]sx?|py|sh)$/.test(path) && before.definitions[path] !== undefined && originalDefinitions[path] === undefined
      if (candidate && candidatePolicy === false) return true
      if (before.definitions[path] === expected) return false
      // New candidate verification files have no caller-owned baseline, even when the task
      // requests a refactor rather than explicit test additions. Require a
      // trusted run-start snapshot/policy and a fresh execution after any edit.
      // Legacy runs retain their previous explicit-additions behavior.
      if (candidate && (candidatePolicy === true || candidatePolicy === undefined && additionsAllowed)) return false
      const original = sources[path]
      if (original === undefined || !testFile(path) || before.definitions[path] === undefined) return true
      const current = await new FilesystemTool(root).readLimited(path, 1_000_000)
      return current.truncated || !preservesTestBaseline(root, path, original, current.content) || hash(current.content) !== before.definitions[path]
    }
    before.definitionChanged = (await Promise.all(Object.entries(initial).map(([path, value]) => changed(path, value)))).some(Boolean)
    try {
      for (const [path, hash] of Object.entries(originalDefinitions)) if (before.definitions[path] !== undefined && await changed(path, hash)) before.definitionChanged = true
    } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
  }
  return before
}

export async function freezeCheckDefinitions(root: string, store: string, allowTestAdditions = false, allowCandidateChanges = true): Promise<void> {
  try { await fs.access(join(store, 'original.json')); return } catch { /* New run. */ }
  const receipt = await captureCheck(root, root, 'node', ['--test'], true)
  await fs.mkdir(store, { recursive: true })
  await fs.writeFile(join(store, 'candidate-test-policy.json'), JSON.stringify({ mutable: allowCandidateChanges }), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (allowTestAdditions) {
    const files = new FilesystemTool(root), sources: Record<string, string> = {}
    for (const path of Object.keys(receipt.definitions).filter(testFile)) {
      const read = await files.readLimited(path, 1_000_000)
      if (!read.truncated) sources[path] = read.content
    }
    await fs.writeFile(join(store, 'test-sources.json'), JSON.stringify(sources), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  await fs.writeFile(join(store, 'original.json'), JSON.stringify(receipt.definitions), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
}
