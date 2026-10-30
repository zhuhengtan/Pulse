import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateExecPolicy, mergeExecPolicies, parseExecPolicy, safeCommandPrefix, sourceExecPolicy, workspaceExecPolicy } from '../packages/server/src/exec-policy.js'
import { ExecPolicyHost } from '../packages/server/src/exec-policy-host.js'
import { resolveShellIdentity } from '@hunterzhu/pulse-adapters'
import { mergePulseConfigs } from '../packages/cli/src/config.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function root() { const p = await mkdtemp(join(tmpdir(), 'pulse-policy-')); dirs.push(p); return p }
const allow = { pattern: ['git', 'status'] as [string, string], decision: 'allow' as const }
const program = { path: '/usr/bin/git', fingerprint: 'version-1' }

describe('declarative exec policy', () => {
  it('requires an explicit host executable identity for basename allow rules', () => {
    const policy = { rules: [allow] }
    expect(evaluateExecPolicy(policy, { argv: ['git', 'status'], program }).decision).toBe('none')
    const trusted = { ...policy, hostExecutables: { git: ['/usr/bin/git'] } }
    expect(evaluateExecPolicy(trusted, { argv: ['git', 'status'], program }).decision).toBe('allow')
    expect(evaluateExecPolicy(trusted, { argv: ['/tmp/git', 'status'], program: { ...program, path: '/tmp/git' } }).decision).toBe('none')
    expect(evaluateExecPolicy(trusted, { argv: ['git', 'status'], program: { ...program, path: '/workspace/node_modules/.bin/git' } }).decision).toBe('none')
  })
  it('aggregates all sources and never lets allow override prompt or forbidden', () => {
    const policy = mergeExecPolicies({ rules: [allow], hostExecutables: { git: [program.path] } }, workspaceExecPolicy({ rules: [{ ...allow, decision: 'prompt' }] }))
    expect(evaluateExecPolicy(policy, { argv: ['git', 'status'], program }).decision).toBe('prompt')
    const strict = mergeExecPolicies(policy, { rules: [{ ...allow, decision: 'forbidden' }] })
    expect(evaluateExecPolicy(mergeExecPolicies(strict, {}), { argv: ['/tmp/git', 'status'], program: { ...program, path: '/tmp/git' } }).decision).toBe('forbidden')
  })
  it('keeps duplicate rule IDs from different layers and strips workspace authority', () => {
    const merged = mergePulseConfigs([{ trust: 'workspace', source: '/repo/.pulse/config.json', value: { execPolicy: { rules: [{ ...allow, id: 'same', decision: 'forbidden' }, allow], hostExecutables: { git: ['/tmp/git'] } } } }, { trust: 'user', source: '/host/config.json', value: { execPolicy: { rules: [{ ...allow, id: 'same' }], hostExecutables: { git: [program.path] } } } }])
    const result = evaluateExecPolicy(merged.execPolicy, { argv: ['git', 'status'], program })
    expect(result.decision).toBe('forbidden')
    expect(result.matchedRules.map(r => r.configSource)).toEqual(['/host/config.json', '/repo/.pulse/config.json'])
    expect(merged.execPolicy?.hostExecutables?.git).toEqual(['/usr/bin/git'])
  })
  it('validates argv examples and alternatives without interpreting shell punctuation', () => {
    const rule = { pattern: ['rg', ['--fixed-strings', '-F'], 'a;b|c'], decision: 'prompt' }
    const config = parseExecPolicy({ rules: [{ ...rule, match: [['rg', '-F', 'a;b|c', 'a.txt']], notMatch: [['rg', '-F', 'other']] }] })
    expect(evaluateExecPolicy(config, { argv: ['rg', '-F', 'a;b|c', 'a.txt'] }).decision).toBe('prompt')
    expect(() => parseExecPolicy({ rules: [{ ...rule, match: ['rg -F a;b|c'] }] })).toThrow('EXEC_POLICY_INVALID')
    expect(() => parseExecPolicy({ rules: [{ ...rule, notMatch: [['rg', '-F', 'a;b|c']] }] })).toThrow('EXEC_POLICY_NOT_MATCH_EXAMPLE_HIT')
    expect(() => parseExecPolicy({ rules: [{ ...rule, match: [['rg', '-F', 'bad']] }] })).toThrow('EXEC_POLICY_MATCH_EXAMPLE_FAILED')
  })
  it.each([['git', '-c', 'core.fsmonitor=evil', 'status'], ['git', 'diff', '--ext-diff'], ['git', 'status', '--help'], ['git', 'log'], ['git', 'log', '--oneline'], ['node', '-e', '1'], ['pnpm', 'test'], ['docker', 'run'], ['git'], ['/tmp/git', 'status']])('does not recommend dangerous or ambiguous argv %j', (...args) => expect(safeCommandPrefix(args)).toBeUndefined())
  it('supports bounded status and version templates only', () => {
    expect(safeCommandPrefix(['git', 'status', '--short'])).toEqual(['git', 'status', '--short'])
    expect(safeCommandPrefix(['git', 'diff', '--stat'])).toEqual(['git', 'diff', '--stat'])
    expect(safeCommandPrefix(['git', 'log', '-1'])).toEqual(['git', 'log', '-1'])
    expect(safeCommandPrefix(['node', '--version'])).toEqual(['node', '--version'])
  })
  it('limits remembered authority to cwd, exact program version, and the exact argv', () => {
    const config = { rules: [{ ...allow, binding: { cwd: '/repo', fingerprint: 'version-1' } }] }
    expect(evaluateExecPolicy(config, { argv: ['git', 'status'], cwd: '/repo', program }).decision).toBe('allow')
    for (const input of [{ argv: ['git', 'status'], cwd: '/other', program }, { argv: ['git', 'status'], cwd: '/repo', program: { ...program, fingerprint: 'v2' } }, { argv: ['git', 'status', '--help'], cwd: '/repo', program }, { argv: ['git', 'status', '--short'], cwd: '/repo', program }]) expect(evaluateExecPolicy(config, input).decision).toBe('none')
    const remembered = { rules: [{ pattern: ['git', 'log', '-1'], decision: 'allow' as const, binding: { cwd: '/repo', fingerprint: 'version-1' } }] }
    expect(evaluateExecPolicy(remembered, { argv: ['git', 'log', '-1'], cwd: '/repo', program }).decision).toBe('allow')
    for (const argv of [['git', 'log'], ['git', 'log', '-2'], ['git', 'log', '-1', '--stat'], ['git', 'diff', '--stat']]) expect(evaluateExecPolicy(remembered, { argv, cwd: '/repo', program }).decision).toBe('none')
    const stale = { rules: [{ pattern: ['git', 'log'], decision: 'allow' as const, binding: { cwd: '/repo', fingerprint: 'version-1' } }] }
    expect(evaluateExecPolicy(stale, { argv: ['git', 'log'], cwd: '/repo', program }).decision).toBe('none')
    expect(evaluateExecPolicy(stale, { argv: ['git', 'log', '-1'], cwd: '/repo', program }).decision).toBe('none')
    const admin = { rules: [allow], hostExecutables: { git: [program.path] } }
    expect(evaluateExecPolicy(admin, { argv: ['git', 'status', '--short'], program }).decision).toBe('allow')
    const diffAdmin = { rules: [{ pattern: ['git', 'diff'] as [string, string], decision: 'allow' as const }], hostExecutables: { git: [program.path] } }
    expect(evaluateExecPolicy(diffAdmin, { argv: ['git', 'diff', '--cached'], program }).decision).toBe('allow')
    const diffRemembered = { rules: [{ pattern: ['git', 'diff', '--stat'], decision: 'allow' as const, binding: { cwd: '/repo', fingerprint: 'version-1' } }] }
    expect(evaluateExecPolicy(diffRemembered, { argv: ['git', 'diff', '--stat'], cwd: '/repo', program }).decision).toBe('allow')
    expect(evaluateExecPolicy(diffRemembered, { argv: ['git', 'diff'], cwd: '/repo', program }).decision).toBe('none')
    expect(evaluateExecPolicy(diffRemembered, { argv: ['git', 'diff', '--cached'], cwd: '/repo', program }).decision).toBe('none')
  })
})

describe('host-owned remembered approvals', () => {
  const input = { tools: [{ toolName: 'shell.exec', toolCallId: 'call-1', input: { command: 'node', args: ['--version'] } }] }
  it('binds a one-use offer to run, exact input and current policy; prompt never offers remember', async () => {
    const dir = await root(), host = new ExecPolicyHost()
    const offer = await host.offer(input, dir, 'c1', 'r1', 'e1')
    expect(offer?.prefix).toEqual(['node', '--version'])
    await expect(host.approve(input, dir, 'c2', 'r1', 'e1', { remember: 'session', execPolicyToken: offer!.token })).rejects.toThrow('EXEC_POLICY_OFFER_STALE')
    await host.approve(input, dir, 'c1', 'r1', 'e1', { remember: 'session', execPolicyToken: offer!.token })
    expect(await host.authorize(input.tools[0]!.input, dir, 'c1', 'r1', 'next')).toBe(true)
    expect(await host.authorize({ command: 'node', args: [] }, dir, 'c1', 'r1', 'widened')).toBe(false)
    expect(await host.authorize(input.tools[0]!.input, dir, 'c1', 'r2', 'next')).toBe(false)
    expect(await new ExecPolicyHost().authorize(input.tools[0]!.input, dir, 'c1', 'r1', 'next')).toBe(false)
    host.configure({ rules: [{ pattern: ['node', '--version'], decision: 'prompt' }] })
    expect(await host.offer(input, dir, 'c1', 'r1', 'e1')).toBeUndefined()
    await expect(host.authorize(input.tools[0]!.input, dir, 'c1', 'r1', 'fresh')).rejects.toThrow('EXEC_POLICY_PROMPT')
    await host.approve(input, dir, 'c1', 'r1', 'e1', {})
    expect(await host.authorize(input.tools[0]!.input, dir, 'c1', 'r1', 'call-1')).toBe(true)
  })
  it('writes the explicit config path, preserves unrelated fields, deduplicates and restores across hosts', async () => {
    const dir = await root(), path = join(dir, 'custom.json')
    const old = { unrelated: { credentialRef: 'fixture-reference' }, approvalMode: 'ask' }
    await writeFile(path, JSON.stringify(old))
    const first = new ExecPolicyHost({}, path), offer = await first.offer(input, dir, 'c', 'r', 'e')
    await first.approve(input, dir, 'c', 'r', 'e', { remember: 'permanent', execPolicyToken: offer!.token })
    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw.unrelated).toEqual(old.unrelated); expect(raw.approvalMode).toBe('ask'); expect(raw.execPolicy.rules).toHaveLength(1)
    const second = new ExecPolicyHost({}, path)
    expect(await second.authorize(input.tools[0]!.input, dir, 'c', 'another-run', 'call-1')).toBe(true)
    const next = await second.offer(input, dir, 'c', 'another-run', 'e2')
    await second.approve(input, dir, 'c', 'another-run', 'e2', { remember: 'permanent', execPolicyToken: next!.token })
    expect(JSON.parse(await readFile(path, 'utf8')).execPolicy.rules).toHaveLength(1)
    await writeFile(path, JSON.stringify(old))
    expect(await second.authorize(input.tools[0]!.input, dir, 'c', 'another-run', 'fresh')).toBe(false)
  })
  it('reads tightening rules before launch even in a separate active worker', async () => {
    const dir = await root(), path = join(dir, 'config.json'), node = await realpath(process.execPath)
    const policy = { rules: [{ pattern: ['node', '--version'], decision: 'allow' }], hostExecutables: { node: [node] } }
    await writeFile(path, JSON.stringify({ execPolicy: policy }))
    const host = new ExecPolicyHost(sourceExecPolicy(policy, path), path)
    expect(await host.authorize(input.tools[0]!.input, dir, 'c', 'r', 'a')).toBe(true)
    await writeFile(path, JSON.stringify({ execPolicy: { ...policy, rules: [{ pattern: ['node'], decision: 'forbidden' }] } }))
    await expect(host.authorize(input.tools[0]!.input, dir, 'c', 'r', 'a')).rejects.toThrow('EXEC_POLICY_FORBIDDEN')
    await writeFile(path, JSON.stringify({ execPolicy: { ...policy, hostExecutables: {} } }))
    expect(await host.authorize(input.tools[0]!.input, dir, 'c', 'r', 'b')).toBe(false)
  })
  it('rejects stale program identities and never launches a diagnostic command', async () => {
    const dir = await root(), executable = join(dir, 'fixture')
    await writeFile(executable, 'before')
    const before = await resolveShellIdentity(executable, [], dir)
    await writeFile(executable, 'different program')
    const after = await resolveShellIdentity(executable, [], dir)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    const host = new ExecPolicyHost({ rules: [{ pattern: [after.path], decision: 'allow' }] })
    expect((await host.inspect({ command: executable, args: ['; literally data'] }, dir)).decision).toBe('allow')
    expect(await readFile(executable, 'utf8')).toBe('different program')
  })
})
