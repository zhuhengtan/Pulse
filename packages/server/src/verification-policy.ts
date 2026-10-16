import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { JsonValue } from '@hunterzhu/pulse-runtime'
import { within } from './security.js'

const codingRequest = /修复|实现|开发|修改|优化|重构|调试|测试|检查|验证|验收|执行.*计划|\b(?:fix|implement|develop|refactor|debug|test|check|verify|code)\b/i
const continuation = /继续|接着|按.*计划|执行|continue|proceed/i

function authorized(intent: string): boolean {
  const disallowed = /不要.*(?:执行|运行|测试|修改)|只(?:需|要|做|能).*(?:分析|阅读|解释)|\b(?:explain|describe|why|how to|do not run|do not execute|do not test)\b/i
  try {
    const context = JSON.parse(intent)
    if (typeof context.currentRequest === 'string') {
      if (disallowed.test(context.currentRequest)) return false
      if (codingRequest.test(context.currentRequest)) return true
      return continuation.test(context.currentRequest) && Array.isArray(context.recentConversation) && context.recentConversation.some((m: { role?: string; content?: string }) => m.role === 'user' && codingRequest.test(m.content ?? ''))
    }
  } catch { /* Direct task goals are plain text. */ }
  return !disallowed.test(intent) && codingRequest.test(intent)
}

const unsafeToken = /[\r\n\0;&|<>`$]/
const sensitive = /(^|[\\/])(?:\.git|\.ssh|\.pulse|\.codex|\.env(?:\.[^\\/]*)?)(?:[\\/]|$)/i

/** A narrow task-authorized bypass; all other commands retain ordinary review. */
export async function isNecessaryVerification(root: string, input: Record<string, JsonValue>, intent: string): Promise<boolean> {
  if (!authorized(intent) || typeof input.command !== 'string' || !['node', 'pnpm', 'npm', 'grep', 'rg', 'git'].includes(input.command)) return false
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(v => typeof v !== 'string'))) return false
  if (input.cwd !== undefined && typeof input.cwd !== 'string') return false
  const args = (input.args ?? []) as string[]
  if (args.some(arg => unsafeToken.test(arg))) return false
  try {
    const canonicalRoot = await within(root, '.')
    const cwd = await within(root, typeof input.cwd === 'string' ? input.cwd : '.')
    if (sensitive.test(relative(canonicalRoot, cwd))) return false
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
    if (input.command === 'node') {
      if (args.length === 2 && args[0] === '--check') return /\.[cm]?js$/.test(args[1]!) && await file(args[1]!, false)
      return args[0] === '--test' && args.length > 1 && (await Promise.all(args.slice(1).map(name => file(name, true)))).every(Boolean)
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
    if (/^node --test(?: tests\/[\w.\/-]+\.[cm]?js)*$/.test(script)) return (await Promise.all(script.split(' ').slice(2).map(name => file(name, true)))).every(Boolean)
    return /^(?:vitest run(?: --exclude ['"]?tests\/[\w.*\/-]+['"]?)?|tsc --noEmit)$/.test(script)
  } catch { return false }
}
