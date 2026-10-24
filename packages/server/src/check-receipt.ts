import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { candidateScriptCoverage, type CandidateScriptCoverage } from './task-controller/candidate-script-coverage.js'

export interface CheckReceipt {
  schemaVersion: 1 | 2 | 3
  scope?: { mode: 'explicit' | 'project'; inputs: string[]; coverage: 'declared-inputs' | 'unknown-dynamic' | 'conservative' }
  command: string
  args: string[]
  cwd: string
  files: Record<string, string>
  definitions: Record<string, string>
  environment: { platform: string; node: string }
  stable: boolean
  definitionChanged: boolean
  candidateScriptCoverage?: CandidateScriptCoverage[]
}
const baseName = (token: string) => token.replace(/^.*[/\\]/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
const RUNNING_SCRIPT = /^(?:test|tests|check|checks|verify|validate|lint|typecheck)(?:[.\-_:][^/\\]*)?$/i
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const RUNNERS = new Set(['vitest', 'jest', 'pytest', 'eslint', 'xmllint'])
const WRAPPERS = new Set(['env', 'time', 'sudo', 'command', 'exec', 'cross-env', 'npx', 'pnpx', 'bunx', 'nice', 'nohup'])
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const VALUE_FLAGS = new Set(['-c', '-p', '-u', '-F', '--prefix', '--cwd', '--dir', '--workspace', '--config', '--filter', '--reporter'])
const NODE_VALUE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--loader', '--experimental-loader', '--import', '--input-type', '--env-file', '--conditions', '--experimental-config-file'])
// `python -m pytest` names a module to run, so `-m` takes a value and the module
// name is not the script position.
const INTERPRETER_VALUE_FLAGS = new Set([...NODE_VALUE_FLAGS, '-m'])
// Inline code flags: the words after them are that code's argv, never a script.
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const stripFlags = (argv: string[]): string[] => {
  while (argv.length > 0 && argv[0]!.startsWith('-') && argv[0] !== '--') {
    const flag = argv[0]!
    argv = argv.slice(1)
    if (VALUE_FLAGS.has(flag)) argv = argv.slice(1)
  }
  return argv
}
/** Index of the first positional argument, skipping flags and their values. */
const positionalIndex = (argv: string[], valueFlags: Set<string>): number => {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--') return index + 1
    if (!arg.startsWith('-')) return index
    if (!arg.includes('=') && valueFlags.has(arg)) index++
  }
  return -1
}
const firstPositional = (argv: string[], valueFlags: Set<string>): string | undefined => {
  const index = positionalIndex(argv, valueFlags)
  return index < 0 ? undefined : argv[index]
}
const runsNamedScript = (token: string | undefined): boolean => token !== undefined && RUNNING_SCRIPT.test(baseName(token))
/**
 * Split an inline shell command line into simple commands, honouring single and
 * double quotes. Returns undefined for shapes this parser deliberately does not
 * interpret (unquoted expansions, subshells, redirections, background jobs,
 * unbalanced quotes) so an unsupported shape is never guessed into a check.
 */
const parseInlineCommand = (text: string): string[][] | undefined => {
  const segments: string[][] = []
  let tokens: string[] = []
  let token = ''
  let inToken = false
  let quote: '"' | "'" | undefined
  const endToken = (): void => {
    if (inToken) { tokens.push(token); token = ''; inToken = false }
  }
  const endSegment = (): void => {
    endToken()
    if (tokens.length > 0) segments.push(tokens)
    tokens = []
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === quote) { quote = undefined; continue }
      // Expansions and escapes inside double quotes change the words in ways we
      // do not model, so abstain instead of reading them as a command.
      if (quote === '"' && (char === '$' || char === '`' || char === '\\')) return undefined
      token += char
      continue
    }
    if (char === "'" || char === '"') { quote = char; inToken = true; continue }
    if (char === ' ' || char === '\t') { endToken(); continue }
    if (char === '\n' || char === ';') { endSegment(); continue }
    if (char === '|') { endSegment(); if (text[index + 1] === '|') index++; continue }
    if (char === '&') {
      if (text[index + 1] !== '&') return undefined
      endSegment()
      index++
      continue
    }
    // Unquoted characters that can restructure the command line.
    if (char === '$' || char === '`' || char === '(' || char === ')' || char === '<' || char === '>' || char === '\\') return undefined
    token += char
    inToken = true
  }
  if (quote !== undefined) return undefined
  endSegment()
  return segments
}
export function isCheck(command: string, args: string[]): boolean {
  // Judge by the executable actually invoked and by where the runner or script
  // sits in argv. Reading a file named *.test.ts with shasum/git/cat/grep/rg is
  // data inspection, not a check; only a real runner or verification script is.
  let argv = [command, ...args]
  for (;;) {
    while (argv.length > 0 && ENV_ASSIGNMENT.test(argv[0]!)) argv = argv.slice(1)
    if (argv.length === 0) return false
    const program = baseName(argv[0]!)
    if (WRAPPERS.has(program)) { argv = stripFlags(argv.slice(1)); continue }
    if (PACKAGE_MANAGERS.has(program)) {
      argv = stripFlags(argv.slice(1))
      const verb = (argv[0] ?? '').toLowerCase()
      if (verb === 'exec' || verb === 'dlx' || verb === 'x' || verb === 'create') { argv = stripFlags(argv.slice(1)); continue }
      if (verb === 'run' || verb === 'run-script') return runsNamedScript(argv[1])
      return ['test', 't', 'check', 'lint', 'typecheck'].includes(verb) || (argv.length > 0 && RUNNERS.has(baseName(argv[0]!)))
    }
    if (SHELLS.has(program)) {
      const rest = argv.slice(1)
      // `sh -c "cmd"` and `bash -lc "cmd"` carry a command line, not data.
      const inlineIndex = rest.findIndex((arg) => /^-[a-z]*c$/i.test(arg))
      if (inlineIndex >= 0) {
        // Locate each simple command by its own executable, honouring quotes:
        // `sh -c 'echo "prefix; vitest run"'` only prints text and runs no
        // runner. Text inside quotes never splits a command.
        const inlineCommand = rest[inlineIndex + 1] ?? ''
        const segments = parseInlineCommand(inlineCommand)
        return segments !== undefined && segments.some((tokens) => isCheck(tokens[0]!, tokens.slice(1)))
      }
      return runsNamedScript(firstPositional(rest, new Set()))
    }
    if (program === 'node' || program === 'nodejs' || program === 'deno' || program.startsWith('python') || program === 'py') {
      const rest = argv.slice(1)
      // Only interpreter options before the script position count. Anything
      // after the script name is that script's own data, even when it reads
      // `--test`, `--check` or a *.test.ts style path.
      const scriptIndex = positionalIndex(rest, INTERPRETER_VALUE_FLAGS)
      const options = scriptIndex < 0 ? rest : rest.slice(0, scriptIndex)
      if (options.some((arg) => arg === '--test' || arg === '--check')) return true
      const modules = options.indexOf('-m')
      if (modules >= 0 && RUNNERS.has(baseName(options[modules + 1] ?? ''))) return true
      // `node -e "code" tests/verify.mjs` runs inline code: the remaining words
      // are that code's argv, so no script position exists to classify.
      if (options.some((arg) => EVAL_FLAGS.has(arg))) return false
      const script = scriptIndex < 0 ? undefined : rest[scriptIndex]
      return runsNamedScript(script) || (script !== undefined && TEST_FILE.test(baseName(script)))
    }
    return RUNNERS.has(program) || runsNamedScript(program)
  }
}
const portableKeys = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key.replaceAll('\\', '/'), value]))
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
  const key = relative(resolve(root), resolve(root, path)).replaceAll('\\', '/')
  if (!testFile(key) || key === '..' || key.startsWith('../')) return
  let original: Record<string, string>
  try { original = portableKeys(JSON.parse(await fs.readFile(join(store, 'original.json'), 'utf8'))) }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error }
  if (original[key] === undefined || hash(proposed) === original[key]) return
  let sources: Record<string, string> = {}
  try { sources = portableKeys(JSON.parse(await fs.readFile(join(store, 'test-sources.json'), 'utf8'))) }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
  if (sources[key] !== undefined && preservesTestBaseline(root, key, sources[key]!, proposed)) return
  const appendConstraint = 'Append only top-level test(...) or it(...) registrations. Extra top-level imports, variable/function declarations and module side effects are not accepted. Put per-test imports, setup and helpers inside the appended test callback, or use a separate authorized candidate test file.'
  throw Object.assign(new Error('FROZEN_TEST_CHANGE: no file written. Preserve every original import and the complete original test body, including placeholder assertions. If test additions are authorized, append new cases after that body; otherwise create a separate candidate test. Do not replace or remove the baseline. ' + appendConstraint), { code: 'FROZEN_TEST_CHANGE', details: { path: key, additionsAllowed: sources[key] !== undefined, constraints: appendConstraint, suggestedRead: { path: key }, nextTools: ['fs.read', 'fs.apply_patch'] } })
}

/** Named checks include their local import closure. Project scripts use a conservative source tree. */
export async function captureCheck(root: string, cwd: string, command: string, args: string[], allDefinitions = false, version: 1 | 2 | 3 = 2, savedScope?: CheckReceipt['scope']): Promise<CheckReceipt> {
  root = await fs.realpath(root)
  cwd = await fs.realpath(cwd)
  const files = new FilesystemTool(root), versions: Record<string, string> = {}, definitions: Record<string, string> = {}
  const legacyInputs = args.filter(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]sx?|py|sh)$/.test(arg)).map(arg => resolve(cwd, arg))
  const directInputs: string[] = []
  if (version >= 2 && !savedScope && /(?:^|[/\\])(?:node|python3?|ruby|perl|xmllint|jq)$/.test(command)) {
    for (const arg of args) {
      if (arg.startsWith('-') || arg.includes('\n') || /^[a-z]+:\/\//i.test(arg) || !/\.[a-z0-9]{1,12}$/i.test(arg)) continue
      const path = resolve(cwd, arg)
      if ((await fs.stat(path).catch(() => undefined))?.isFile()) directInputs.push(path)
    }
  }
  // unittest accepts dotted module selectors rather than file operands.
  // Resolve only whole local modules; method selectors/flags remain conservative.
  if (version === 3 && !savedScope && /(?:^|[/\\])python3?$/.test(command) && args[0] === '-m' && args[1] === 'unittest') {
    for (const arg of args.slice(2)) if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(arg)) {
      const path = resolve(cwd, arg.replaceAll('.', '/') + '.py')
      if ((await fs.stat(path).catch(() => undefined))?.isFile()) directInputs.push(path)
    }
  }
  const seeds = version === 1 ? legacyInputs : savedScope ? savedScope.inputs.map(p => resolve(root, p)) : [...new Set([...legacyInputs, ...directInputs])]
  const pending = [...seeds]
  const named = savedScope ? savedScope.mode === 'explicit' : pending.length > 0
  const scope: NonNullable<CheckReceipt['scope']> = { mode: named ? 'explicit' : 'project', inputs: seeds.map(p => relative(root, p).replaceAll('\\', '/')), coverage: named ? /(?:^|[/\\])(?:xmllint|jq)$/.test(command) ? 'declared-inputs' : 'unknown-dynamic' : 'conservative' }

  if (!named) {
    // Include tracked checks even if ignored later, but exclude ignored generated
    // run data. A broad filesystem walk otherwise freezes old Runtime snapshots.
    let inventory: string | undefined
    try {
      if (version === 3) {
        const top = (await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 10_000 })).stdout.trim()
        if (relative(root, top).startsWith('..')) throw Object.assign(new Error('parent repository is not a git repository for this workspace'), { stderr: 'not a git repository' })
      }
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
    const path = pending.pop()!, key = relative(root, path).replaceAll('\\', '/')
    if (key.startsWith('../') || key === '..' || versions[key]) continue
    if (version >= 2 && !/\.(?:[cm]?[jt]sx?|py|sh|json|toml|yaml|yml)$/.test(path)) {
      try { versions[key] = await files.hash(path) } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
      continue
    }
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
    if (version === 3 && path.endsWith('.py')) for (const match of text.matchAll(/^\s*(?:from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import|import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))/gm)) {
      const module = (match[1] ?? match[2]!).replaceAll('.', '/')
      for (const candidate of [resolve(cwd, module + '.py'), resolve(root, module + '.py'), resolve(cwd, module, '__init__.py')]) {
        if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) { pending.push(candidate); break }
      }
    }
    if (named) for (const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[1]!)
      for (const candidate of [base, base.replace(/\.js$/, '.ts'), ...['.ts', '.js', '.mjs', '.tsx', '/index.ts', '/index.js'].map(ext => base + ext)]) {
        if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) { pending.push(candidate); break }
      }
    }
  }
  return { schemaVersion: version, ...(version >= 2 ? { scope } : {}), command, args, cwd: relative(root, cwd) || '.', files: versions, definitions, environment: { platform: process.platform, node: process.version }, stable: true, definitionChanged: false }
}

/** First observed check definition is frozen in Host data, never in the agent workspace. */
export async function finishCheck(root: string, before: CheckReceipt, store?: string, allowCandidateScripts = false): Promise<CheckReceipt> {
  before.files = portableKeys(before.files); before.definitions = portableKeys(before.definitions)
  const after = await captureCheck(root, resolve(root, before.cwd), before.command, before.args, false, before.schemaVersion, before.scope)
  before.stable = JSON.stringify(before.files) === JSON.stringify(after.files)
  if (store) {
    await fs.mkdir(store, { recursive: true })
    const path = join(store, `${hash(JSON.stringify([before.command, before.args, before.cwd]))}.json`)
    let initial: Record<string, string>
    try { await fs.writeFile(path, JSON.stringify(before.definitions), { flag: 'wx', mode: 0o600 }); initial = before.definitions }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; initial = portableKeys(JSON.parse(await fs.readFile(path, 'utf8'))) }
    // Only explicit test-addition tasks can extend caller-owned frozen tests.
    // The baseline stays a byte-for-byte prefix, and only extra test()/it()
    // registrations may follow it. Imports, hooks and other top-level code
    // still invalidate the receipt. Host-owned assertions are never rebased.
    let sources: Record<string, string> = {}
    let additionsAllowed = false
    try { sources = portableKeys(JSON.parse(await fs.readFile(join(store, 'test-sources.json'), 'utf8'))); additionsAllowed = true }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    let originalDefinitions: Record<string, string> = {}
    let originalSnapshot = false
    try { originalDefinitions = portableKeys(JSON.parse(await fs.readFile(join(store, 'original.json'), 'utf8'))); originalSnapshot = true }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    let candidatePolicy: boolean | undefined
    try { candidatePolicy = JSON.parse(await fs.readFile(join(store, 'candidate-test-policy.json'), 'utf8')).mutable === true }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    const changed = async (path: string, expected: string): Promise<boolean> => {
      const candidate = originalSnapshot && /\.(?:[cm]?[jt]sx?|py|sh)$/.test(path) && before.definitions[path] !== undefined && originalDefinitions[path] === undefined
      if (candidate && candidatePolicy === false) return true
      if (before.definitions[path] === expected) return false
      if (allowCandidateScripts && before.stable && originalSnapshot && candidatePolicy === true && originalDefinitions[path] === undefined) {
        const coverage = await candidateScriptCoverage(root, before, path)
        if (coverage && coverage.scriptHash === before.definitions[path]) {
          before.candidateScriptCoverage = [...(before.candidateScriptCoverage ?? []), coverage]
          return false
        }
      }
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

export async function freezeCheckDefinitions(root: string, store: string, allowTestAdditions = false, allowCandidateChanges = true, version: 2 | 3 = 2): Promise<void> {
  try { await fs.access(join(store, 'original.json')); return } catch { /* New run. */ }
  const receipt = await captureCheck(root, root, 'node', ['--test'], true, version)
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
