import { z } from 'zod'
import { posix, win32 } from 'node:path'

const token = z.string().min(1).max(4096).refine(s => !s.includes('\0'))
const argv = z.array(token).min(1).max(128)
const absolute = (s: string) => posix.isAbsolute(s) || win32.isAbsolute(s)
export const execRuleSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  configSource: z.string().max(4096).optional(),
  pattern: z.tuple([token]).rest(z.union([token, z.array(token).min(1).max(32)])),
  decision: z.enum(['allow', 'prompt', 'forbidden']),
  justification: z.string().max(1000).optional(),
  match: z.array(argv).max(64).optional(), notMatch: z.array(argv).max(64).optional(),
  // Remembered rules are narrower than an administrator-authored prefix rule.
  binding: z.object({ fingerprint: token, cwd: token }).strict().optional(),
}).strict()
export const execPolicySchema = z.object({
  rules: z.array(execRuleSchema).max(256).optional(),
  restrictions: z.array(execRuleSchema.refine(r => r.decision !== 'allow')).max(256).optional(),
  hostExecutables: z.record(z.array(token.refine(absolute)).min(1).max(32)).optional(),
  hostExecutableSources: z.record(z.string().max(4096)).optional(),
}).strict()
export type ExecPrefixRule = z.infer<typeof execRuleSchema>
export type ExecPolicyConfig = z.infer<typeof execPolicySchema>
export interface ExecProgram { path: string; fingerprint: string }
export interface ExecPolicyResult {
  decision: 'none' | 'allow' | 'prompt' | 'forbidden'
  matchedRules: Array<{ id?: string; source: 'host' | 'workspace'; index: number; configSource?: string; decision: ExecPrefixRule['decision']; justification?: string }>
  reason: string
}
function fileName(path: string) { return path.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/, '') }
function samePath(a: string, b: string) { return win32.isAbsolute(a) && win32.isAbsolute(b) ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : a === b }
function matches(rule: ExecPrefixRule, input: string[]) {
  return rule.pattern.length <= input.length && rule.pattern.every((p, i) => Array.isArray(p) ? p.includes(input[i]!) : p === input[i])
}

/** Pure argv matching: strings are never parsed as a shell command. */
export function parseExecPolicy(value: unknown): ExecPolicyConfig {
  const parsed = execPolicySchema.safeParse(value ?? {})
  if (!parsed.success) throw new Error('EXEC_POLICY_INVALID')
  const config = parsed.data
  for (const rule of [...config.rules ?? [], ...config.restrictions ?? []]) {
    if (rule.pattern.length > 128) throw new Error('EXEC_POLICY_PATTERN_TOO_LONG')
    for (const example of rule.match ?? []) if (!matches(rule, example)) throw new Error('EXEC_POLICY_MATCH_EXAMPLE_FAILED')
    for (const example of rule.notMatch ?? []) if (matches(rule, example)) throw new Error('EXEC_POLICY_NOT_MATCH_EXAMPLE_HIT')
  }
  return config
}
/** Restrictions accumulate; no later layer (including an empty object) erases them. */
export function mergeExecPolicies(a: unknown, b: unknown): ExecPolicyConfig {
  const left = parseExecPolicy(a), right = parseExecPolicy(b)
  return parseExecPolicy({ rules: [...left.rules ?? [], ...right.rules ?? []], restrictions: [...left.restrictions ?? [], ...right.restrictions ?? []], hostExecutables: { ...left.hostExecutables, ...right.hostExecutables }, hostExecutableSources: { ...left.hostExecutableSources, ...right.hostExecutableSources } })
}
export function sourceExecPolicy(value: unknown, source: string): ExecPolicyConfig {
  const policy = parseExecPolicy(value)
  return { ...policy, rules: policy.rules?.map(r => ({ ...r, configSource: source })), restrictions: policy.restrictions?.map(r => ({ ...r, configSource: source })), hostExecutableSources: Object.fromEntries(Object.keys(policy.hostExecutables ?? {}).map(name => [name, source])) }
}
export function workspaceExecPolicy(value: unknown): ExecPolicyConfig {
  const config = parseExecPolicy(value)
  return { restrictions: [...config.restrictions ?? [], ...(config.rules ?? []).filter(r => r.decision !== 'allow')] }
}

// A deliberately small recommendation vocabulary. An administrator can create
// other rules, but a button must never silently turn an arbitrary script into
// a remembered grant. The returned argv is exact: remembering `git log -1`
// does not allow a later `git log`. Unbounded `git log` is not rememberable.
// Remembered rules recheck this at execution as well. shell.ts keeps the same
// git argv boundary when it neutralizes repository helpers.
export function safeCommandPrefix(input: string[]): string[] | undefined {
  const [command, ...args] = input
  if (!command || /[\\/]/.test(command) || args.length > 32) return undefined
  if (['node', 'pnpm', 'npm', 'python', 'python3'].includes(command) && args.length === 1 && args[0] === '--version') return input
  if (command !== 'git' || !args[0] || args[0].startsWith('-')) return undefined
  const rest = args.slice(1)
  const allowed = (words: string[]) => rest.every(arg => words.includes(arg))
  if (args[0] === 'status' && allowed(['--short', '--branch', '--porcelain', '--porcelain=v1', '-s', '-b'])) return input
  if (args[0] === 'diff' && allowed(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--no-ext-diff', '--no-textconv'])) return input
  if (args[0] === 'log') {
    const bound = /^(?:-(?:[1-9]|[1-9][0-9])|--max-count=(?:[1-9]|[1-9][0-9]))$/
    if (rest.some(arg => bound.test(arg)) && rest.every(arg => arg === '--oneline' || arg === '--no-decorate' || bound.test(arg))) return input
  }
  return undefined
}

export function evaluateExecPolicy(value: unknown, input: { argv: string[]; program?: ExecProgram; cwd?: string }): ExecPolicyResult {
  const config = parseExecPolicy(value)
  if (!argv.safeParse(input.argv).success) throw new Error('EXEC_POLICY_ARGV_INVALID')
  const hits: ExecPolicyResult['matchedRules'] = []
  for (const [source, rules] of [['host', config.rules ?? []], ['workspace', config.restrictions ?? []]] as const) rules.forEach((rule, index) => {
    const first = rule.pattern[0]
    let candidate = input.argv
    if (rule.decision !== 'allow') {
      // Unknown absolute paths cannot evade a basename denial. This does not
      // give that executable any authority to inherit a basename allow rule.
      if (!absolute(first) && fileName(candidate[0]!) === first) candidate = [first, ...candidate.slice(1)]
    } else {
      if (!input.program) return
      if (rule.binding) {
        // Remembered rules store the exact argv. A previously saved short prefix
        // must not keep matching longer commands.
        const exact = safeCommandPrefix(input.argv)
        if (rule.binding.fingerprint !== input.program.fingerprint || rule.binding.cwd !== input.cwd || !exact || rule.pattern.length !== input.argv.length) return
      } else if (absolute(first)) {
        if (!samePath(first, input.program.path)) return
        candidate = [first, ...candidate.slice(1)]
      } else {
        if (!(config.hostExecutables?.[first] ?? []).some(path => samePath(path, input.program!.path))) return
        if (fileName(candidate[0]!) !== first) return
        candidate = [first, ...candidate.slice(1)]
      }
    }
    if (matches(rule, candidate)) hits.push({ ...(rule.id ? { id: rule.id } : {}), ...(rule.configSource ? { configSource: rule.configSource } : {}), source, index, decision: rule.decision, ...(rule.justification ? { justification: rule.justification } : {}) })
  })
  const decision = (['forbidden', 'prompt', 'allow'] as const).find(d => hits.some(r => r.decision === d)) ?? 'none'
  return { decision, matchedRules: hits, reason: decision === 'none' ? 'no_trusted_match' : `exec_policy_${decision}` }
}
