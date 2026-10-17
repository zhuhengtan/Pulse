import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { runShell } from '@hunterzhu/pulse-adapters'

vi.mock('@hunterzhu/pulse-adapters', async original => ({
  ...await original<typeof import('@hunterzhu/pulse-adapters')>(),
  runShell: vi.fn(async () => ({ code: 0, stdout: '6 src/facade.mjs\n', stderr: '', truncated: false, timedOut: false, aborted: false })),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(runShell).mockClear() })

it.each(['bounded-count', 'sensitive-count', 'declared-test-glob', 'data-script-test', 'data-script-sensitive', 'data-script-readonly', 'data-script-read', 'data-script-sensitive-read', 'data-script-filtered-test'] as const)('uses necessary verification policy at the Host approval boundary: %s', async mode => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-read-verification-host-'))
  await mkdir(join(cwd, 'src'))
  await mkdir(join(cwd, 'test'))
  await writeFile(join(cwd, 'src/facade.mjs'), 'export const ready = true\n')
  await writeFile(join(cwd, '.env'), 'fixture=private')
  await writeFile(join(cwd, 'test/facade.test.mjs'), '')
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' } }))
  const sensitive = mode === 'sensitive-count' || mode === 'data-script-sensitive' || mode === 'data-script-sensitive-read'
  const read = mode === 'data-script-read' || mode === 'data-script-sensitive-read'
  const input = mode === 'data-script-filtered-test' ? { command: 'node', args: ['--test', '--test-name-pattern=report totals agree', '--test-reporter=spec', 'test/facade.test.mjs'] } : mode === 'declared-test-glob' ? { command: 'node', args: ['--test'] } : mode === 'data-script-test' || mode === 'data-script-readonly' ? { command: 'node', args: ['--test', 'test/facade.test.mjs'] } : { command: read ? 'cat' : 'wc', args: [read ? '-n' : '-l', sensitive ? '.env' : 'src/facade.mjs'] }
  let requested = false, safetyReviews = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const body = JSON.parse(String(options.body))
    const safety = body.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))
    if (safety) safetyReviews++
    const tool = !safety && !requested
    if (tool) requested = true
    const message = tool ? { content: '', tool_calls: [{ id: 'verify', function: { name: 'shell_exec', arguments: JSON.stringify(input) } }] } : { content: safety ? 'DENY' : 'Verification finished.' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), taskController: false, jarvis: { enabled: false }, approvalMode: 'auto', provider: { provider: 'openai', defaultModel: 'fixture' }, approvalReview: { provider: 'ollama', model: 'review-fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30000 } })
  try {
    const text = mode.startsWith('data-script') ? '请清洗并分析原始日志，编写可复现脚本并立即运行产出报表。' + (mode === 'data-script-readonly' ? '但不要执行测试。' : '') : '重构模块并验证文件行数和全部测试。'
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text })
    const observations: any[] = []
    for await (const event of run.events) if (event.type === 'observation') observations.push(event.data)
    const denied = sensitive || mode === 'data-script-readonly'
    expect(safetyReviews).toBe(denied ? 1 : 0)
    expect(runShell).toHaveBeenCalledTimes(denied ? 0 : 1)
    if (!denied) expect(vi.mocked(runShell).mock.calls[0]?.slice(0, 2)).toEqual([input.command, input.args])
    expect(observations).toContainEqual(expect.objectContaining({ tool: 'shell.exec', status: denied ? 'failed' : 'succeeded', ...(denied ? { result: expect.objectContaining({ code: 'AI_APPROVAL_DENIED' }) } : {}) }))
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
