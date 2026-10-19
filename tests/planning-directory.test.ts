import { afterEach, expect, it, vi } from 'vitest'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { createLocalHost } from '../packages/server/src/index.js'
import { createBuiltinSkillCapabilityPack } from '../packages/server/src/builtin-skills.js'
import { PlanWriter } from '../packages/server/src/editing.js'

const roots: string[] = []
const temporary = async () => { const path = await mkdtemp(join(tmpdir(), 'pulse-planning-directory-')); roots.push(path); return path }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('prepares a new planning workspace before the model inspects the plan catalog', async () => {
  const cwd = await temporary()
  vi.stubGlobal('fetch', vi.fn(async () => {
    await expect(access(join(cwd, 'docs/plans'))).resolves.toBeUndefined()
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The plan directory is available.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, approvalMode: 'auto', taskController: false, capabilityPacks: [createBuiltinSkillCapabilityPack()], enabledCapabilityPacks: ['builtin-skills'] })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '/grill-and-plan 整理一个新计划' })
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    expect(await new FilesystemTool(cwd).list('docs/plans')).toEqual([])
  } finally { await host.close() }
})

it.each(['read-only', 'ordinary'] as const)('does not prepare a plan directory for %s sessions', async mode => {
  const cwd = await temporary()
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'mock' }, mockResponse: 'Done.', jarvis: { enabled: false }, approvalMode: mode === 'read-only' ? 'read-only' : 'auto', taskController: false })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: mode === 'read-only' ? '/grill-and-plan 整理计划' : '只回复你好' })
    await run.outcome()
    await expect(access(join(cwd, 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await host.close() }
})

it('preparation preserves an existing plan', async () => {
  const cwd = await temporary()
  await mkdir(join(cwd, 'docs/plans'), { recursive: true })
  await writeFile(join(cwd, 'docs/plans/old.md'), 'Previously approved plan')
  await new PlanWriter(new FilesystemTool(cwd)).prepareDirectory()
  expect(await readFile(join(cwd, 'docs/plans/old.md'), 'utf8')).toBe('Previously approved plan')
})

it('refuses a docs symlink outside the workspace before creating directories', async () => {
  const cwd = await temporary(), outside = await temporary()
  await symlink(outside, join(cwd, 'docs'), 'dir')
  await expect(new PlanWriter(new FilesystemTool(cwd)).prepareDirectory()).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SANDBOX' })
  await expect(access(join(outside, 'plans'))).rejects.toMatchObject({ code: 'ENOENT' })
})
