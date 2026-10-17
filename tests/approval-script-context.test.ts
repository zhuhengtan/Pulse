import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalScriptContext } from '../packages/server/src/verification-policy.js'
import { createLocalHost } from '@hunterzhu/pulse-server'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('local script evidence for safety approval', () => {
  it('bounds the preview and excludes sensitive, outside and inline code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-script-preview-'))
    const outside = await mkdtemp(join(tmpdir(), 'pulse-preview-outside-'))
    try {
      await mkdir(join(root, '.verify'))
      await writeFile(join(root, '.verify/check.mjs'), 'x'.repeat(20000))
      expect(await approvalScriptContext(root, { command: 'node', args: ['.verify/check.mjs'] })).toMatchObject({ path: '.verify/check.mjs', truncated: true })
      expect((await approvalScriptContext(root, { command: 'node', args: ['.verify/check.mjs'] }))!.content.length).toBeLessThanOrEqual(16_384)
      await writeFile(join(root, '.env.mjs'), 'sensitive')
      await writeFile(join(outside, 'check.mjs'), 'outside')
      await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(await approvalScriptContext(root, { command: 'node', args: ['.env.mjs'] })).toBeUndefined()
      expect(await approvalScriptContext(root, { command: 'node', args: ['linked/check.mjs'] })).toBeUndefined()
      expect(await approvalScriptContext(root, { command: 'node', args: ['-e', '1'] })).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })

  it('provides script evidence to the local reviewer while honoring its DENY', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const root = await mkdtemp(join(tmpdir(), 'pulse-review-context-'))
    const source = "import assert from 'node:assert/strict'\n" + '// bounded fixture padding\n'.repeat(400) + "assert.equal(1, 1)\n"
    await writeFile(join(root, 'verify.mjs'), source)
    let requested = false, review = ''
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body))
      const safety = body.messages.some((m: any) => m.content.includes('You are the Pulse safety reviewer'))
      if (safety) {
        review = JSON.stringify(body.messages)
        expect(body.reasoning_effort).toBe('none')
      }
      const tool = !safety && !requested
      if (tool) requested = true
      const message = tool ? { content: '', tool_calls: [{ id: 'check', function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'node', args: ['verify.mjs'] }) } }] } : { content: safety ? 'DENY' : 'Not executed.' }
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: false, jarvis: { enabled: false }, provider: { provider: 'openai', defaultModel: 'fixture' }, approvalMode: 'auto', approvalReview: { provider: 'ollama', model: 'review-fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 31007 } })
    try {
      const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Verify the local application with verify.mjs' })
      const observations: unknown[] = []
      for await (const event of run.events) if (event.type === 'observation') observations.push(event.data)
      expect(review).toContain("assert.equal(1, 1)")
      expect(review).toContain('Workspace script evidence')
      expect(JSON.parse(review).some((message: { content: string }) => message.content.includes('"truncated":false'))).toBe(true)
      expect(review).toContain('Creating task-requested output artifacts inside the workspace is permitted')
      expect(timers.mock.calls.some(([, delay]) => delay === 31007)).toBe(true)
      expect(observations).toContainEqual(expect.objectContaining({ tool: 'shell.exec', status: 'failed', result: expect.objectContaining({ code: 'AI_APPROVAL_DENIED' }) }))
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })
})
