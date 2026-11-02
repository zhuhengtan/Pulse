import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, H5Server, type LocalHostOptions } from '@hunterzhu/pulse-server'

const directories: string[] = []
const hosts = new Set<ReturnType<typeof createLocalHost>>()
const closingHosts = new WeakMap<ReturnType<typeof createLocalHost>, Promise<void>>()
function closeOwnedHost(host: ReturnType<typeof createLocalHost>): Promise<void> {
  const closing = closingHosts.get(host)
  if (closing) return closing
  const result = host.close()
  closingHosts.set(host, result)
  return result
}
afterEach(async () => {
  // A Vitest timeout does not await the test body's finally. Drain the same
  // owned Host once before deleting its SQLite files, including cancellation.
  try { await Promise.all([...hosts].map(closeOwnedHost)) }
  finally { hosts.clear(); vi.restoreAllMocks() }
  await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true })))
})
async function root() { const dir = await mkdtemp(join(tmpdir(), 'pulse-policy-production-')); directories.push(dir); return dir }
async function versionRun(options: Partial<LocalHostOptions>, reply?: (run: any, event: any) => Promise<void>) {
  const dir = options.cwd ?? await root()
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'mock' }, taskController: false, mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'] } }], mockAfterToolResponse: 'Checked local Node.', ...options })
  hosts.add(host)
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Check the locally installed Node version.' }), events: any[] = []
    for await (const event of run.events) { events.push(event); if (event.type === 'waiting') { if (reply) await reply(run, event); else await run.reply((event.data as any).effectId, { approved: false }) } }
    return { events, outcome: await run.outcome() }
  } finally { await closeOwnedHost(host) }
}
const output = (events: any[]) => JSON.stringify(events.filter(e => e.type === 'observation'))
// Cold Windows SRT verification, ACL setup and cleanup are outside the tool's
// process deadline. Measured valid native phases alone exceed the generic 45s.
const nativeRunTimeout = (runs = 1) => process.platform === 'win32' ? runs * 180_000 : 45_000
function expectShellSucceeded(events: any[]): void {
  expect(events.filter(e => e.type === 'observation').map(e => e.data)).toContainEqual(expect.objectContaining({ tool: 'shell.exec', status: 'succeeded' }))
}

it('enforces a trusted allow through the real ask Host, native sandbox and Node process without an approval popup', async () => {
  const node = await realpath(process.execPath)
  const { events, outcome } = await versionRun({ approvalMode: 'ask', execPolicy: { hostExecutables: { node: [node] }, rules: [{ pattern: ['node', '--version'], decision: 'allow' }] } })
  expect(events.some(e => e.type === 'waiting')).toBe(false)
  expect(outcome.status).toBe('succeeded'); expect(output(events)).toMatch(/v\d+\.\d+/)
  expectShellSucceeded(events)
}, nativeRunTimeout())

it.each(['ask', 'auto'] as const)('explicit prompt requires a real human response in %s mode and disables remember', async approvalMode => {
  let waiting = 0
  const { events } = await versionRun({ approvalMode, execPolicy: { rules: [{ pattern: ['node'], decision: 'prompt' }] } }, async (run, event) => {
    waiting++
    expect(event.data.input.execPolicy).toBeUndefined()
    expect(await run.reviewApproval(event.data.effectId)).toMatchObject({ status: 'manual', reason: 'exec_policy_prompt' })
    await run.reply(event.data.effectId, { approved: true })
  })
  expect(waiting).toBe(1); expect(output(events)).toMatch(/v\d+\.\d+/)
  expectShellSucceeded(events)
}, nativeRunTimeout())

it.each(['ask', 'auto', 'read-only'] as const)('forbidden never executes or consumes a true reviewer in %s mode', async approvalMode => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_MODEL_REQUEST'))
  const { events } = await versionRun({ approvalMode, execPolicy: { rules: [{ pattern: ['node'], decision: 'forbidden' }] } })
  expect(output(events)).not.toMatch(/v\d+\.\d+/)
  expect(fetch).not.toHaveBeenCalled()
}, 45000)

it('a policy allow cannot lift read-only mode', async () => {
  const node = await realpath(process.execPath)
  const { events } = await versionRun({ approvalMode: 'read-only', execPolicy: { hostExecutables: { node: [node] }, rules: [{ pattern: ['node', '--version'], decision: 'allow' }] } })
  expect(output(events)).not.toMatch(/v\d+\.\d+/)
  expect(output(events)).toContain('READ_ONLY')
}, 45000)

it('binds permanent approval to the real pending offer and retains unrelated fixture config', async () => {
  const dir = await root(), path = join(dir, 'actual-host-config.json')
  await writeFile(path, JSON.stringify({ unrelated: { keep: true } }))
  let waiting = 0
  const { events } = await versionRun({ cwd: dir, approvalMode: 'ask', execPolicyConfigPath: path }, async (run, event) => {
    waiting++
    const policy = event.data.input.execPolicy
    expect(policy.canAmend).toBe(true)
    await expect(run.reply(event.data.effectId, { approved: true, remember: 'permanent', execPolicyToken: 'forged' })).rejects.toThrow('EXEC_POLICY_OFFER_STALE')
    await run.reply(event.data.effectId, { approved: true, remember: 'permanent', execPolicyToken: policy.token })
  })
  expect(waiting).toBe(1); expect(output(events)).toMatch(/v\d+\.\d+/)
  expectShellSucceeded(events)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  expect(saved.unrelated.keep).toBe(true); expect(saved.execPolicy.rules).toHaveLength(1)
  const next = await versionRun({ cwd: dir, approvalMode: 'ask', execPolicyConfigPath: path })
  expect(next.events.some(e => e.type === 'waiting')).toBe(false); expect(output(next.events)).toMatch(/v\d+\.\d+/)
  expectShellSucceeded(next.events)
}, nativeRunTimeout(2))

it('evaluates and validates draft rules through authenticated H5 without spawning a program', async () => {
  const dir = await root(), path = join(dir, 'settings.json')
  await writeFile(path, '{}')
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data') }), server = new H5Server(host, { dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, configuration: { path, prepare: async () => ({ cwd: dir, dataDir: join(dir, 'data') }) } })
  try {
    const info = await server.start(), base = `http://127.0.0.1:${info.port}`
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Origin: base, Cookie: session.headers.get('set-cookie')!, 'Content-Type': 'application/json' }
    const policy = { rules: [{ pattern: ['node'], decision: 'forbidden' }] }
    const checked = await fetch(base + '/api/config/exec-policy/check', { method: 'POST', headers, body: JSON.stringify({ argv: ['node', '--version'], execPolicy: policy }) })
    expect(checked.status).toBe(200); expect(await checked.json()).toMatchObject({ decision: 'forbidden' })
    const wrongOrigin = await fetch(base + '/api/config/exec-policy/check', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: JSON.stringify({ argv: ['node'] }) })
    expect(wrongOrigin.status).toBe(403)
    const invalid = await fetch(base + '/api/config/validate', { method: 'POST', headers, body: JSON.stringify({ config: { execPolicy: { rules: [{ pattern: ['node'], decision: 'allow', notMatch: [['node']] }] } } }) })
    expect(invalid.status).toBe(400); expect(await readFile(path, 'utf8')).toBe('{}')
    const before = await (await fetch(base + '/api/config', { headers })).json()
    const saved = await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ version: before.version, config: { execPolicy: policy } }) })
    expect(saved.status).toBe(200)
    expect(await host.checkExecPolicy({ command: 'node', args: ['--version'] })).toMatchObject({ decision: 'forbidden' })
    const conflict = await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ version: before.version, config: {} }) })
    expect(conflict.status).toBe(409)
  } finally { await server.stop(); await host.close() }
}, 45000)
