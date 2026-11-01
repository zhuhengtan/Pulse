import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as adapters from '@hunterzhu/pulse-adapters'
import type { EffectRecord } from '@hunterzhu/pulse-runtime'
import { HookService, loadHookDefinitions } from '../packages/server/src/hooks/index.js'
import { createLocalHost } from '../packages/server/src/index.js'

const faults = vi.hoisted(() => ({ event: '', permanent: false, rejected: 0, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (source: string, target: string) => {
    const receipt = faults.event && String(target).endsWith('.json') && String(source).startsWith(String(target) + '.')
      ? await fs.readFile(source, 'utf8').then(JSON.parse).catch(() => undefined) : undefined
    if (receipt?.event === faults.event && (faults.permanent || faults.rejected === 0)) {
      faults.rejected++
      Object.defineProperty(process, 'platform', { ...faults.platform, value: 'win32' })
      throw Object.assign(new Error('synthetic Windows sharing violation at hook receipt settlement'), { code: 'EPERM' })
    }
    const result = await fs.rename(source, target)
    if (receipt?.event === faults.event) Object.defineProperty(process, 'platform', faults.platform)
    return result
  } }
})
const roots: string[] = []
const services: HookService[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', faults.platform)
  faults.event = ''; faults.permanent = false; faults.rejected = 0
  for (const service of services.splice(0)) await service.dispose()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})
async function fixture(events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-hook-storage-')); roots.push(root)
  const cwd = join(root, 'workspace'), source = join(root, 'source'), journal = join(root, 'receipts')
  await mkdir(cwd); await mkdir(source)
  await writeFile(join(cwd, 'a.txt'), 'hello')
  await writeFile(join(source, 'hook.cjs'), "process.stdin.resume();process.stdout.write('{}')")
  const file = join(source, 'hooks.json')
  await writeFile(file, JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'], timeout: 1 }] }]])) }))
  const snapshot = await loadHookDefinitions(file, join(root, 'installed')), trusted = { ...snapshot, enabled: true }
  const service = new HookService(cwd, journal, { conversationId: 'c', runId: 'r' }, snapshot, trusted); services.push(service)
  const shell = vi.spyOn(adapters, 'runShell').mockResolvedValue({ code: 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: false })
  return { root, cwd, journal, snapshot, trusted, service, shell }
}
const effect = (attemptId = 'a1') => ({ id: 'e1', kind: 'tool', attemptId, attemptNo: 1, agentId: 'agent', ownerLaneId: 'lane', toolCallId: 'tc', input: { name: 'fs.read', arguments: { path: 'a.txt' } } }) as EffectRecord
const receipts = async (directory: string) => Promise.all((await readdir(directory)).filter(p => p.endsWith('.json')).map(async p => JSON.parse(await readFile(join(directory, p), 'utf8'))))

it('settles a pre receipt after a sharing violation without replaying the hook or losing event order', async () => {
  const f = await fixture(), execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'once' }))
  faults.event = 'PreToolUse'
  await f.service.sessionStart(new AbortController().signal)
  const result = await f.service.around(effect(), new AbortController().signal, undefined, execute)
  await f.service.stop()
  expect(result, JSON.stringify(await receipts(f.journal))).toMatchObject({ status: 'succeeded' })
  expect((await receipts(f.journal)).map(r => r.event).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'])
  expect((await receipts(f.journal)).every(r => r.status === 'continue')).toBe(true)
  expect(f.shell).toHaveBeenCalledTimes(4); expect(execute).toHaveBeenCalledTimes(1)
  expect(faults.rejected).toBe(1)
})
it('keeps a timed-out pre hook unknown through a sharing violation and does not replay it', async () => {
  const f = await fixture(['PreToolUse']), execute = vi.fn()
  f.shell.mockResolvedValue({ code: null, stdout: '', stderr: '', truncated: false, timedOut: true, aborted: false })
  faults.event = 'PreToolUse'
  expect((await f.service.around(effect(), new AbortController().signal, undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED')
  Object.defineProperty(process, 'platform', faults.platform)
  expect((await receipts(f.journal)).filter(r => r.index !== undefined)).toEqual([expect.objectContaining({ event: 'PreToolUse', status: 'unknown', error: 'HOOK_OUTCOME_UNKNOWN' })])
  expect((await f.service.around(effect('a2'), new AbortController().signal, undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED')
  expect(f.shell).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled()
})
it('keeps a permanently unsaved pre receipt closed and never retries its script on another attempt', async () => {
  const f = await fixture(['PreToolUse']), execute = vi.fn()
  faults.event = 'PreToolUse'; faults.permanent = true
  expect((await f.service.around(effect(), new AbortController().signal, undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED')
  Object.defineProperty(process, 'platform', faults.platform)
  expect((await receipts(f.journal)).some(r => r.status === 'running')).toBe(true)
  expect((await f.service.around(effect('a2'), new AbortController().signal, undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED')
  expect(f.shell).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled()
})
it.each(['PostToolUse', 'Stop'])('settles %s through a sharing violation while preserving the applied effect', async event => {
  const f = await fixture([event]), execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'once', sideEffectState: 'applied' as const }))
  faults.event = event
  expect(await f.service.around(effect(), new AbortController().signal, undefined, execute)).toMatchObject({ status: 'succeeded', sideEffectState: 'applied' })
  await f.service.stop(); Object.defineProperty(process, 'platform', faults.platform)
  expect(await receipts(f.journal)).toEqual([expect.objectContaining({ event, status: 'continue' })])
  expect(f.shell).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1)
})
it('persists the real Host hook lifecycle without repeating the tool after a pre receipt sharing violation', async () => {
  const f = await fixture(), host = createLocalHost({ cwd: f.cwd, dataDir: join(f.root, 'data'), hooks: f.trusted, taskController: false, approvalMode: 'auto', mockToolCalls: [{ name: 'fs.read', input: { path: 'a.txt' } }], mockAfterToolResponse: 'done' })
  try {
    await host.init(); const conversation = await host.createConversation({ cwd: f.cwd })
    faults.event = 'PreToolUse'
    const run = await host.sendMessage(conversation.id, { text: 'Read a.txt' })
    const result = await run.outcome(); Object.defineProperty(process, 'platform', faults.platform)
    const saved = await receipts(join(f.root, 'data', 'conversations', conversation.id, 'runs', run.id, 'hooks'))
    expect(result, JSON.stringify(saved)).toMatchObject({ status: 'succeeded' })
    expect(saved.map(r => r.event).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'])
    expect(saved.every(r => r.runId === run.id && r.status === 'continue')).toBe(true)
    expect(f.shell).toHaveBeenCalledTimes(4)
  } finally { Object.defineProperty(process, 'platform', faults.platform); await host.close() }
}, 20000)
