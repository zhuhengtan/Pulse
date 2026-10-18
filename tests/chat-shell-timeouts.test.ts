import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'
import { runShell } from '@hunterzhu/pulse-adapters'

vi.mock('@hunterzhu/pulse-adapters', async original => ({ ...await original<typeof import('@hunterzhu/pulse-adapters')>(), runShell: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false })) }))

it.each([undefined, 180_000])('keeps the runtime timeout above the requested command timeout (%s)', async timeoutMs => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-shell-timeout-'))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'ask', mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'], ...(timeoutMs ? { timeoutMs } : {}) } }], mockAfterToolResponse: 'Checked' })
  try {
    const conversation = await host.createConversation(); const run = await host.sendMessage(conversation.id, { text: '验证 Node 版本' })
    for await (const event of run.events) if (event.type === 'waiting') await run.reply((event.data as { effectId: string }).effectId, { approved: true })
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    const saved = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
    const tool = saved.state.state.effects.map((entry: [string, { kind: string; attemptTimeoutMs: number }]) => entry[1]).find((effect: { kind: string }) => effect.kind === 'tool')
    expect(tool.attemptTimeoutMs).toBeGreaterThan(timeoutMs ?? 30_000)
    expect(vi.mocked(runShell).mock.calls.at(-1)?.[2]?.timeoutMs).toBe(timeoutMs ?? 30_000)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
