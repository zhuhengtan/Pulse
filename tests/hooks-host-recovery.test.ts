import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { loadHookDefinitions } from '../packages/server/src/hooks/index.js'

it('cold restores the frozen hook version while preserving approval and settled receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-hook-resume-')), source = join(root, 'source'), workspace = join(root, 'workspace'), dataDir = join(root, 'data')
  await mkdir(source)
  await mkdir(workspace)
  await writeFile(join(source, 'hook.cjs'), 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("{}"))')
  const file = join(source, 'hooks.json')
  await writeFile(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'] }] }], PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'] }] }], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'] }] }], Stop: [{ hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'] }] }] } }))
  const hooks = { ...await loadHookDefinitions(file, join(root, 'installed')), enabled: true }
  const options = { cwd: workspace, dataDir, hooks, taskController: false, approvalMode: 'ask' as const, mockToolCalls: [{ name: 'fs.write', input: { path: 'once.txt', content: 'once' } }], mockAfterToolResponse: 'done' }
  let first: ReturnType<typeof createLocalHost> | undefined, second: typeof first
  try {
    first = createLocalHost(options)
    const c = await first.createConversation(), run = await first.sendMessage(c.id, { text: 'Create once.txt' })
    for await (const event of run.events) if (event.type === 'waiting') break
    const journal = join(dataDir, 'conversations', c.id, 'runs', run.id, 'hooks')
    const before = await readdir(journal)
    expect(before).toHaveLength(1)
    ;(first as any).active.get(run.id).runtime.cancelAgent = () => {}
    await first.close()
    second = createLocalHost({ ...options, mockToolCalls: [], mockResponse: 'done' })
    const resumed = await second.resumeRun(c.id)
    for await (const event of resumed.events) if (event.type === 'waiting') await resumed.reply((event.data as any).effectId, { approved: true })
    expect((await resumed.outcome()).status).toBe('succeeded')
    expect(await readFile(join(workspace, 'once.txt'), 'utf8')).toBe('once')
    const receipts = await Promise.all((await readdir(journal)).map(p => readFile(join(journal, p), 'utf8').then(JSON.parse)))
    expect(receipts.map(r => r.event).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'])
    expect(receipts.every(r => r.status === 'continue')).toBe(true)
  } finally {
    await second?.close()
    await first?.close()
    await rm(root, { recursive: true, force: true })
  }
}, process.platform === 'win32' ? 960000 : 30000)

it('a real short-deadline Host tool settles before its slow post observer', async () => {
  const { defineTool } = await import('@hunterzhu/pulse-tool-sdk'), { z } = await import('zod')
  const root = await mkdtemp(join(tmpdir(), 'pulse-hook-deadline-')), source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'hook.cjs'), 'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.stdout.write("{}"),600))')
  const file = join(source, 'hooks.json')
  await writeFile(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'probe.write', hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'], timeout: 2 }] }] } }))
  const hooks = { ...await loadHookDefinitions(file, join(root, 'installed')), enabled: true }
  let writes = 0
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), hooks, taskController: false, approvalMode: 'auto', enabledCapabilityPacks: ['probe'], capabilityPacks: [{ manifest: { id: 'probe', version: '1', kind: 'integration', title: 'fixture', description: 'local only' }, activate: async () => ({ tools: [defineTool({ name: 'probe.write', description: 'fixture', input: z.object({}), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'write', defaultTimeoutMs: 150, execute: async () => { writes++; await writeFile(join(root, 'once.txt'), 'once'); return { ok: true } } })] }) }], mockToolCalls: [{ name: 'probe.write', input: {} }], mockAfterToolResponse: 'done' })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Run local probe' })
    expect((await run.outcome()).status).toBe('succeeded')
    expect(writes).toBe(1)
    expect(await readFile(join(root, 'once.txt'), 'utf8')).toBe('once')
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}, process.platform === 'win32' ? 240000 : 30000)
