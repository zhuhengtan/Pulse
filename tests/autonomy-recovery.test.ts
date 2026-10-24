import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { ToolRegistry, defineTool } from '@hunterzhu/pulse-tool-sdk'
import { captureCheck, finishCheck } from '../packages/server/src/check-receipt.js'

it.each(['preflight', 'after-approval', 'manual-approval', 'denied', 'exhausted'] as const)('corrects invalid input without borrowing approval: %s', async mode => {
  const registry = new ToolRegistry()
  registry.register(defineTool({ name: 'patch', description: 'bounded patch', input: z.object({ patches: z.array(z.string()).min(2) }), output: z.unknown(), execute: async () => ({}) }))
  let models = 0, approvals = 0, writes = 0
  const notices: string[] = [], digests: string[] = []
  const manuallyApproved = new Set<string>()
  const program = defineLaneProgram({ id: 'approval-correction', version: '20' }, b => b.addReActLoopStep('work', {
    instruction: 'patch', toolAllow: ['patch'], maxTurns: mode === 'exhausted' ? 1 : 4,
    validateToolInput: (name, args) => { if (mode !== 'after-approval' && mode !== 'manual-approval') registry.validateInput(name, args) },
    ...(mode === 'manual-approval' ? { manualApprovalFallback: true } : { toolApproval: { prompt: 'approve exact arguments' } }), onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({
    effectSubmissionPreparer: submission => {
      if (submission.kind === 'tool') {
        const input = submission.input as any
        if (mode !== 'manual-approval' || manuallyApproved.has(JSON.stringify(input.arguments))) registry.validateInput('patch', input.arguments)
      }
      return submission
    },
    effectExecutor: async effect => {
      if (effect.kind === 'human') { approvals++; if (mode === 'manual-approval') for (const call of (effect.input as any).tools) manuallyApproved.add(JSON.stringify(call.input)); digests.push(String((effect.input as any).digest ?? JSON.stringify((effect.input as any).tools))); return { value: { approved: mode !== 'denied' } } }
      if (effect.kind === 'tool') {
        const input = effect.input as any
        if (mode === 'manual-approval' && !manuallyApproved.has(JSON.stringify(input.arguments))) throw Object.assign(new Error('Reviewer unavailable'), { code: 'AI_APPROVAL_UNAVAILABLE', retryable: false, details: { manualApproval: true, toolName: 'patch', toolCallId: `manual:${effect.id}`, input: input.arguments } })
        writes++; return { value: {} }
      }
      models++; notices.push(JSON.stringify(effect.input))
      return { value: models <= 2 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'patch', input: { patches: models === 1 ? ['a'] : ['a', 'b'] } }] } : { text: 'done', finishReason: 'stop' } }
    },
  })
  const { agentId } = runtime.createAgent('patch', program)
  const outcome = await runtime.start(agentId).outcome()
  expect(outcome.status, JSON.stringify(outcome)).toBe(mode === 'denied' || mode === 'exhausted' ? 'failed' : 'succeeded')
  expect(writes).toBe(mode === 'denied' || mode === 'exhausted' ? 0 : 1)
  expect(approvals).toBe(mode === 'exhausted' ? 0 : mode === 'after-approval' || mode === 'manual-approval' ? 2 : 1)
  expect(new Set(digests).size).toBe(digests.length)
  expect(models).toBe(mode === 'exhausted' ? 1 : mode === 'denied' ? 2 : 3)
  if (models > 1) expect(notices[1]).toContain('minimum')
})

it('reports only safe schema fields, not input values or custom messages', () => {
  const registry = new ToolRegistry()
  registry.register(defineTool({ name: 'sensitive', description: 'test', input: z.object({ value: z.string().max(1, 'secret-do-not-print') }), output: z.unknown(), execute: async () => ({}) }))
  try { registry.validateInput('sensitive', { value: 'credential-do-not-print' }); throw new Error('expected validation failure') }
  catch (e) { expect(JSON.stringify(e)).toContain('value'); expect(JSON.stringify(e)).not.toContain('do-not-print') }
})

it('binds SVG and CSV inputs without absorbing an unrelated verifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-input-scope-'))
  try {
    await writeFile(join(root, 'drawing.svg'), '<svg/>')
    const before = await captureCheck(root, root, 'xmllint', ['--noout', 'drawing.svg'])
    expect(before.scope).toMatchObject({ mode: 'explicit', inputs: ['drawing.svg'], coverage: 'declared-inputs' })
    expect(before.files['drawing.svg']).toMatch(/^[a-f0-9]{64}$/)
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts/verify.mjs'), "import fs from 'node:fs'; fs.readFileSync(process.argv[2]);")
    expect((await finishCheck(root, structuredClone(before))).stable).toBe(true)
    await writeFile(join(root, 'orders.csv'), 'a,b\n1,2')
    const data = await captureCheck(root, root, 'node', ['scripts/verify.mjs', 'orders.csv'])
    expect(Object.keys(data.files)).toEqual(expect.arrayContaining(['scripts/verify.mjs', 'orders.csv']))
    expect(data.scope?.coverage).toBe('unknown-dynamic')
    await writeFile(join(root, 'orders.csv'), 'a,b\n1,3')
    expect((await finishCheck(root, data)).stable).toBe(false)
    await writeFile(join(root, 'drawing.svg'), '<svg><path/></svg>')
    expect((await finishCheck(root, before)).stable).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retains legacy check capture semantics and detects changed definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-scope-legacy-'))
  try {
    await writeFile(join(root, 'drawing.svg'), '<svg/>')
    const before = await captureCheck(root, root, 'xmllint', ['--noout', 'drawing.svg'], false, 1)
    expect(before.schemaVersion).toBe(1)
    expect(before.scope).toBeUndefined()
    await writeFile(join(root, 'verify.mjs'), 'throw Error("failed")')
    expect((await finishCheck(root, before)).stable).toBe(false)
    const named = await captureCheck(root, root, 'node', ['verify.mjs'])
    await writeFile(join(root, 'verify.mjs'), 'process.exit(0)')
    expect((await finishCheck(root, named)).stable).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
