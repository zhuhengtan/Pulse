import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import type { JsonValue } from '@hunterzhu/pulse-runtime'
import { within } from './security.js'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'

const codingRequest = /修复|实现|开发|修改|优化|重构|调试|测试|检查|验证|验收|执行.*计划|\b(?:fix|implement|develop|refactor|debug|test|check|verify|code)\b/i
// Pulse also implements data/file tasks. Require an explicit script/program
// action; merely discussing analysis or mentioning a script is not execution intent.
const scriptRequest = /(?:编写|创建|生成|运行|执行)[^\n。！？]{0,80}(?:脚本|程序)|\b(?:write|create|generate|build|run|execute)\b[^\n.!?]{0,80}\b(?:scripts?|programs?)\b/i
const continuation = /继续|接着|按.*计划|执行|continue|proceed/i
const disallowed = /(?:不要|不必|无需|禁止|不允许)[^\n。！？]{0,40}(?:执行|运行|测试|修改)|不(?:再)?(?:执行|运行|测试|修改)|(?:只(?:需|要|做|能)?|仅(?:需|要)?)[^\n。！？]{0,40}(?:分析|阅读|解释)|\b(?:explain|describe|why|how to|do not run|do not execute|do not test|don['’]t run|don['’]t execute|don['’]t test|analysis only|only analy[sz]e)\b/i
const actionable = (request: string): boolean => !disallowed.test(request) && (codingRequest.test(request) || scriptRequest.test(request))

function authorized(intent: string): boolean {
  try {
    const context = JSON.parse(intent)
    if (typeof context.currentRequest === 'string') {
      if (disallowed.test(context.currentRequest)) return false
      if (actionable(context.currentRequest)) return true
      return continuation.test(context.currentRequest) && Array.isArray(context.recentConversation) && context.recentConversation.some((m: { role?: string; content?: string }) => m.role === 'user' && actionable(m.content ?? ''))
    }
  } catch { /* Direct task goals are plain text. */ }
  return actionable(intent)
}

const unsafeToken = /[\r\n\0;&|<>`$]/
const sensitive = /(^|[\\/])(?:\.git|\.ssh|\.pulse|\.codex|\.env(?:\.[^\\/]*)?)(?:[\\/]|$)/i

/** Read-only evidence for local approval, never an authorization or auto-pass. */
export async function approvalScriptContext(root: string, input: Record<string, JsonValue>): Promise<{ path: string; content: string; truncated: boolean } | undefined> {
  if (input.command !== 'node' || !Array.isArray(input.args) || input.args.length !== 1 || typeof input.args[0] !== 'string' || input.args[0].startsWith('-') || !/\.[cm]?js$/.test(input.args[0])) return undefined
  try {
    const canonicalRoot = await within(root, '.')
    const cwd = await within(root, typeof input.cwd === 'string' ? input.cwd : '.')
    const path = await within(canonicalRoot, resolve(cwd, input.args[0]))
    const name = relative(canonicalRoot, path)
    if (sensitive.test(name) || !(await stat(path)).isFile()) return undefined
    // Match the bounded fs.write artifact size so a normally generated script
    // includes its entry point and output operations, not just its declarations.
    const source = await new FilesystemTool(canonicalRoot).readLimited(path, 16_384)
    return { path: name.split(sep).join('/'), content: source.content, truncated: source.truncated }
  } catch { return undefined }
}

/** A narrow task-authorized bypass; all other commands retain ordinary review. */
export async function isNecessaryVerification(root: string, input: Record<string, JsonValue>, intent: string): Promise<boolean> {
  if (!authorized(intent) || typeof input.command !== 'string' || !['node', 'pnpm', 'npm', 'grep', 'rg', 'git', 'wc', 'cat'].includes(input.command)) return false
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(v => typeof v !== 'string'))) return false
  if (input.cwd !== undefined && typeof input.cwd !== 'string') return false
  const args = (input.args ?? []) as string[]
  if (args.some(arg => unsafeToken.test(arg))) return false
  try {
    const canonicalRoot = await within(root, '.')
    const cwd = await within(root, typeof input.cwd === 'string' ? input.cwd : '.')
    if (sensitive.test(relative(canonicalRoot, cwd))) return false
    if (input.command === 'wc' || input.command === 'cat') {
      // Only explicit ordinary workspace files. No stdin,
      // options that load filenames, globs, directories or special devices.
      if (input.command === 'wc' && args[0] !== '-l') return false
      const names = input.command === 'wc' || args[0] === '-n' ? args.slice(1) : args
      if (names.length < 1 || names.length > 32) return false
      const sizes = await Promise.all(names.map(async name => {
        if (!name || name.startsWith('-') || /[*?\[\]{}]/.test(name)) return undefined
        const lexical = resolve(root, typeof input.cwd === 'string' ? input.cwd : '.', name)
        const target = await within(root, lexical)
        if (sensitive.test(relative(canonicalRoot, lexical)) || sensitive.test(relative(canonicalRoot, target))) return undefined
        const info = await stat(target)
        return info.isFile() ? info.size : undefined
      }))
      // Large reads use paged filesystem tools; do not implicitly authorize an
      // unbounded transcript dump simply because cat is read-only.
      return sizes.every(size => size !== undefined) && (input.command === 'wc' || (sizes as number[]).reduce((total, size) => total + size, 0) <= 65_536)
    }
    if (['node', 'pnpm', 'npm'].includes(input.command) && args.length === 1 && ['--version', '-v'].includes(args[0]!)) return true
    if (input.command === 'git') return args.join(' ') === 'status --short' || args.join(' ') === 'status --short --branch' || args.join(' ') === 'status --branch --short'
    if (input.command === 'grep' || input.command === 'rg') {
      let pattern = false, ended = false
      const files: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (!ended && arg === '--') { ended = true; continue }
        if (!ended && ['-n', '--line-number', '-F', '--fixed-strings', '-i'].includes(arg)) continue
        if (!ended && (arg === '-e' || arg === '--regexp')) { if (!args[++i] || args[i]!.length > 500) return false; pattern = true; continue }
        if (!ended && arg.startsWith('-')) return false
        if (!pattern) { if (arg.length > 500) return false; pattern = true } else files.push(arg)
      }
      return pattern && files.length > 0 && (await Promise.all(files.map(async file => { const target = await within(canonicalRoot, resolve(cwd, file)); return !sensitive.test(relative(canonicalRoot, target)) && (await stat(target)).isFile() }))).every(Boolean)
    }
    const file = async (name: string, test: boolean): Promise<boolean> => {
      if (name.startsWith('-') || !/\.(?:[cm]?js|tsx?)$/.test(name)) return false
      if (test && !/(?:^|[./])(?:tests?|__tests__)(?:[./])|\.(?:test|spec)\./.test(name)) return false
      const target = await within(canonicalRoot, resolve(cwd, name))
      return !sensitive.test(relative(canonicalRoot, target)) && (await stat(target)).isFile()
    }
    const nodeTestScript = async (script: unknown): Promise<boolean> => {
      if (typeof script !== 'string' || unsafeToken.test(script) || script.length > 1024) return false
      const parts = script.split(' ')
      return parts[0] === 'node' && parts[1] === '--test' && (await Promise.all(parts.slice(2).map(async name => {
        if (!name.includes('*')) return file(name, true)
        // Recognize only a single filename wildcard in a declared test script.
        // Inspect every match; recursive globs and unmatched patterns remain
        // reviewed, as do symlinks, sensitive paths and non-test files.
        const pattern = basename(name), directory = dirname(name)
        if (!/^[\w.-]*\*[\w.-]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(pattern) || /[*?\[\]{}]/.test(directory)) return false
        const lexical = resolve(cwd, directory), target = await within(canonicalRoot, lexical)
        if (sensitive.test(relative(canonicalRoot, lexical)) || sensitive.test(relative(canonicalRoot, target))) return false
        const [prefix, suffix] = pattern.split('*') as [string, string]
        const entries = await readdir(target, { withFileTypes: true })
        if (entries.length > 2000) return false
        const matches = entries.filter(entry => (!entry.name.startsWith('.') || prefix.startsWith('.')) && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
        return matches.length > 0 && matches.length <= 256 && (await Promise.all(matches.map(async entry => entry.isFile() && await file(resolve(target, entry.name), true)))).every(Boolean)
      }))).every(Boolean)
    }
    if (input.command === 'node') {
      if (args.length === 2 && args[0] === '--check') return /\.[cm]?js$/.test(args[1]!) && await file(args[1]!, false)
      if (args.length === 1 && args[0] === '--test') {
        // The exact package test entry already admits Node's default discovery
        // through npm/pnpm below. Recognize its direct invocation consistently.
        const packagePath = await within(canonicalRoot, resolve(cwd, 'package.json'))
        if ((await stat(packagePath)).size > 256_000) return false
        const scripts = JSON.parse(await readFile(packagePath, 'utf8')).scripts
        return !!scripts && !scripts.pretest && !scripts.posttest && await nodeTestScript(scripts.test)
      }
      if (args[0] !== '--test') return false
      const paths: string[] = [], options = new Set<string>()
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!
        if (!arg.startsWith('-')) { paths.push(arg); continue }
        // Built-in formatting and bounded test selection do not load code.
        // Selection stays in the receipt and cannot prove a full-suite check.
        if (paths.length) return false
        const split = arg.indexOf('=')
        const option = split < 0 ? arg : arg.slice(0, split)
        if (options.has(option) || !['--test-name-pattern', '--test-reporter'].includes(option)) return false
        options.add(option)
        const value = split < 0 ? args[++i] : arg.slice(split + 1)
        if (!value || value.startsWith('-') || value.length > 500) return false
        if (option === '--test-reporter' && !['tap', 'spec', 'dot'].includes(value)) return false
      }
      return paths.length > 0 && (await Promise.all(paths.map(name => file(name, true)))).every(Boolean)
    }
    if (input.command === 'pnpm' && args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'run') {
      return args.length > 3 && (await Promise.all(args.slice(3).map(name => file(name, true)))).every(Boolean)
    }
    if (input.command === 'pnpm' && args.join(' ') === 'exec tsc --noEmit') return true
    // Do not treat a script called "test" as intrinsically safe. Read the exact
    // workspace script and admit only a simple known check runner, no lifecycle hooks.
    const scriptName = args[0] === 'run' && args.length === 2 ? args[1] : args.length === 1 ? args[0] : undefined
    if (!scriptName || !['test', 'test:unit', 'typecheck'].includes(scriptName)) return false
    const packagePath = await within(canonicalRoot, resolve(cwd, 'package.json'))
    if ((await stat(packagePath)).size > 256_000) return false
    const scripts = JSON.parse(await readFile(packagePath, 'utf8')).scripts
    if (!scripts || scripts[`pre${scriptName}`] || scripts[`post${scriptName}`]) return false
    const script = scripts[scriptName]
    if (typeof script !== 'string' || unsafeToken.test(script) || script.length > 1024) return false
    // Options that load/execute arbitrary code or rewrite snapshots remain reviewed.
    if (await nodeTestScript(script)) return true
    return /^(?:vitest run(?: --exclude ['"]?tests\/[\w.*\/-]+['"]?)?|tsc --noEmit)$/.test(script)
  } catch { return false }
}
