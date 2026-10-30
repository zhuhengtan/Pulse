import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveShellIdentity, type ShellIdentity } from '@hunterzhu/pulse-adapters'
import { evaluateExecPolicy, mergeExecPolicies, sourceExecPolicy, parseExecPolicy, safeCommandPrefix, type ExecPolicyConfig } from './exec-policy.js'
import { safeShellEnv, within } from './security.js'
import { withConfigFileLock } from './config-write-lock.js'

const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
function failure(code: string) { return Object.assign(new Error(code), { code, retryable: false }) }
export interface ExecApprovalOffer { token: string; prefix: string[]; canAmend: boolean; scope: 'run' }
interface Prepared { argv: string[]; cwd: string; identity?: ShellIdentity; version: string; binding: string; decision: ReturnType<typeof evaluateExecPolicy> }

export class ExecPolicyHost {
  private config: ExecPolicyConfig
  private base: ExecPolicyConfig
  private version: string
  private sessions = new Map<string, ExecPolicyConfig>()
  private once = new Map<string, string>()
  private offers = new Map<string, { offer: ExecApprovalOffer; binding: string; rule: NonNullable<ExecPolicyConfig['rules']>[number] }>()
  private launches = new Map<string, ShellIdentity>()
  constructor(config?: ExecPolicyConfig, private configPath?: string) { this.config = parseExecPolicy(config); this.base = this.inherited(this.config); this.version = hash(this.config) }
  getConfig() { return structuredClone(this.config) }
  configure(config?: ExecPolicyConfig, path?: string) {
    const next = parseExecPolicy(config), version = hash(next)
    if (this.version !== version) { this.sessions.clear(); this.offers.clear() }
    this.configPath = path; this.base = this.inherited(next); this.config = next; this.version = version
  }
  private inherited(config: ExecPolicyConfig): ExecPolicyConfig {
    const primary = (source?: string) => Boolean(this.configPath && source && (resolve(source) === resolve(this.configPath) || source.startsWith(this.configPath + '.') && source.endsWith('.validate.tmp')))
    return { ...config, rules: (config.rules ?? []).filter(r => !primary(r.configSource)), restrictions: (config.restrictions ?? []).filter(r => !primary(r.configSource)), hostExecutables: Object.fromEntries(Object.entries(config.hostExecutables ?? {}).filter(([name]) => !primary(config.hostExecutableSources?.[name]))) }
  }
  private async refresh(): Promise<void> {
    if (!this.configPath) return
    const info = await lstat(this.configPath).catch(e => { if (e.code === 'ENOENT') return undefined; throw e })
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)) throw failure('EXEC_POLICY_CONFIG_INVALID')
    const raw = JSON.parse(await readFile(this.configPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e }))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('EXEC_POLICY_CONFIG_INVALID')
    const own = parseExecPolicy(raw.execPolicy)
    const next = mergeExecPolicies(this.base, sourceExecPolicy(own, this.configPath))
    const version = hash(next)
    if (version !== this.version) { this.sessions.clear(); this.offers.clear(); this.config = next; this.version = version }
  }
  private scope(conversation: string, run: string, root: string) { return JSON.stringify([conversation, run, resolve(root)]) }
  private key(conversation: string, run: string, id: string) { return JSON.stringify([conversation, run, id]) }
  clearRun(conversation: string, run: string, root: string) {
    this.sessions.delete(this.scope(conversation, run, root))
    for (const map of [this.once, this.offers, this.launches]) for (const key of map.keys()) { const ids = JSON.parse(key); if (ids[0] === conversation && ids[1] === run) map.delete(key) }
  }
  identity(conversation: string, run: string, toolCallId: string) { return this.launches.get(this.key(conversation, run, toolCallId)) }
  private async prepare(args: Record<string, any>, root: string, conversation: string, run: string): Promise<Prepared> {
    await this.refresh()
    if (args.cwd !== undefined && typeof args.cwd !== 'string' || typeof args.command !== 'string' || args.args !== undefined && (!Array.isArray(args.args) || args.args.some((s: unknown) => typeof s !== 'string'))) throw failure('EXEC_POLICY_ARGV_INVALID')
    const argv = [args.command, ...args.args ?? []], cwd = await within(root, typeof args.cwd === 'string' ? args.cwd : '.')
    let identity: ShellIdentity | undefined
    try { identity = await resolveShellIdentity(argv[0]!, argv.slice(1), cwd, safeShellEnv()) } catch { /* unresolved commands cannot acquire an allow rule */ }
    const version = this.version
    const remembered = this.sessions.get(this.scope(conversation, run, root))?.rules ?? []
    const decision = evaluateExecPolicy({ ...this.config, rules: [...this.config.rules ?? [], ...remembered] }, { argv, cwd, ...(identity ? { program: identity } : {}) })
    return { argv, cwd, ...(identity ? { identity } : {}), version, binding: hash({ argv, cwd, identity: identity?.fingerprint ?? null, version }), decision }
  }
  async inspect(args: Record<string, any>, root: string, conversation = 'diagnostic', run = 'diagnostic') {
    const p = await this.prepare(args, root, conversation, run)
    return { ...p.decision, version: p.version, resolvedProgram: p.identity?.path ?? null, executable: p.identity?.executable ?? null, argv: p.argv, cwd: p.cwd }
  }
  async authorize(args: Record<string, any>, root: string, conversation: string, run: string, toolCallId: string): Promise<boolean> {
    const p = await this.prepare(args, root, conversation, run), key = this.key(conversation, run, toolCallId)
    if (p.decision.decision === 'forbidden') throw failure('EXEC_POLICY_FORBIDDEN')
    const once = this.once.get(key)
    if (once && once !== p.binding) throw failure('EXEC_POLICY_APPROVAL_CHANGED')
    if (p.decision.decision === 'prompt' && once !== p.binding) throw failure('EXEC_POLICY_PROMPT')
    const allowed = p.decision.decision === 'allow' || once === p.binding
    if (allowed && p.identity) this.launches.set(key, p.identity)
    return allowed
  }
  private calls(input: Record<string, any>) { return Array.isArray(input.tools) ? input.tools.map(record) : [] }
  async automatic(input: Record<string, any>, root: string, conversation: string, run: string): Promise<'allow' | 'forbidden' | 'none'> {
    const calls = this.calls(input)
    if (!calls.length) return 'none'
    let all = true
    for (const call of calls) {
      if (!['shell.exec', 'shell.start'].includes(call.toolName ?? call.name)) { all = false; continue }
      const p = await this.prepare(record(call.input ?? call.arguments), root, conversation, run)
      if (p.decision.decision === 'forbidden') return 'forbidden'
      if (p.decision.decision !== 'allow') all = false
    }
    return all ? 'allow' : 'none'
  }
  async offer(input: Record<string, any>, root: string, conversation: string, run: string, effectId: string): Promise<ExecApprovalOffer | undefined> {
    const key = this.key(conversation, run, effectId), calls = this.calls(input)
    if (calls.length !== 1 || !['shell.exec', 'shell.start'].includes(calls[0]!.toolName ?? calls[0]!.name)) return undefined
    const p = await this.prepare(record(calls[0]!.input ?? calls[0]!.arguments), root, conversation, run)
    if (['forbidden', 'prompt'].includes(p.decision.decision) || !p.identity) return undefined
    const prefix = safeCommandPrefix(p.argv)
    const hostTrusted = Object.values(this.config.hostExecutables ?? {}).flat().includes(p.identity.path)
    if (!prefix || !p.identity.trusted && !hostTrusted) return undefined
    const old = this.offers.get(key)
    if (old?.binding === p.binding) return old.offer
    const offer: ExecApprovalOffer = { token: randomUUID(), prefix, canAmend: Boolean(this.configPath), scope: 'run' }
    const rule = { pattern: prefix as [string, ...string[]], decision: 'allow' as const, binding: { cwd: p.cwd, fingerprint: p.identity.fingerprint } }
    this.offers.set(key, { offer, binding: p.binding, rule }); return offer
  }
  async approve(input: Record<string, any>, root: string, conversation: string, run: string, effectId: string, reply: Record<string, any>): Promise<void> {
    const calls = this.calls(input)
    // Reject a forged remember request before doing any file IO or granting a call.
    const choice = reply.remember
    if (choice !== undefined && !['session', 'permanent'].includes(choice)) throw failure('EXEC_POLICY_REMEMBER_INVALID')
    const offerKey = this.key(conversation, run, effectId), saved = this.offers.get(offerKey)
    if (choice && (!saved || reply.execPolicyToken !== saved.offer.token || calls.length !== 1)) throw failure('EXEC_POLICY_OFFER_STALE')
    for (const call of calls) {
      if (!['shell.exec', 'shell.start'].includes(call.toolName ?? call.name)) continue
      const p = await this.prepare(record(call.input ?? call.arguments), root, conversation, run)
      if (p.decision.decision === 'forbidden') throw failure('EXEC_POLICY_FORBIDDEN')
      if (choice && (saved!.binding !== p.binding || ['forbidden', 'prompt'].includes(p.decision.decision))) throw failure('EXEC_POLICY_OFFER_STALE')
    }
    if (choice === 'session') this.sessions.set(this.scope(conversation, run, root), { rules: [...this.sessions.get(this.scope(conversation, run, root))?.rules ?? [], saved!.rule].slice(-128) })
    if (choice === 'permanent') {
      if (!this.configPath || !saved!.offer.canAmend) throw failure('EXEC_POLICY_AMEND_UNAVAILABLE')
      const path = this.configPath
      await withConfigFileLock(path, async () => {
        const info = await lstat(path).catch(e => { if (e.code === 'ENOENT') return undefined; throw e })
        if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)) throw failure('EXEC_POLICY_CONFIG_INVALID')
        const before = await readFile(path, 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e })
        const raw = JSON.parse(before)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('EXEC_POLICY_CONFIG_INVALID')
        const fresh = await this.prepare(record(calls[0]!.input ?? calls[0]!.arguments), root, conversation, run)
        if (fresh.binding !== saved!.binding || ['prompt', 'forbidden'].includes(fresh.decision.decision)) throw failure('EXEC_POLICY_OFFER_STALE')
        const policy = parseExecPolicy(raw.execPolicy), rule = { ...saved!.rule, id: `remembered-${randomUUID()}` }
        const rules = policy.rules ?? []
        if (!rules.some(r => hash({ ...r, id: undefined }) === hash({ ...rule, id: undefined }))) rules.push(rule)
        const next = parseExecPolicy({ ...policy, rules })
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, JSON.stringify({ ...raw, execPolicy: next }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
          if (await readFile(path, 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e }) !== before) throw failure('CONFIG_VERSION_CONFLICT')
          await rename(temp, path)
          // Never interpret a write which already landed as an ungranted action.
          this.config = mergeExecPolicies(this.base, sourceExecPolicy(next, path)); this.version = hash(this.config)
          this.sessions.clear(); this.offers.clear()
        } finally { await rm(temp, { force: true }) }
      })
    }
    for (const call of calls) if (['shell.exec', 'shell.start'].includes(call.toolName ?? call.name)) {
      const p = await this.prepare(record(call.input ?? call.arguments), root, conversation, run)
      this.once.set(this.key(conversation, run, String(call.toolCallId ?? '')), p.binding)
    }
    this.offers.delete(offerKey)
  }
}
