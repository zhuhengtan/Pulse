import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { createLocalHost } from '@hunterzhu/pulse-server'

afterEach(() => vi.unstubAllGlobals())

it.each(['continue', 'stop', 'dismissed'])('waits for a capacity decision and handles %s without replaying work', async decision => {
  let models = 0, summaries = 0, writes = 0
  const program = () => defineLaneProgram({ id: 'capacity-confirmation', version: '1', historyCompaction: {
    summarizeTask: 'summary', keepRecentRounds: 1, confirmBeforeCompaction: true, maxContextTokens: 1_048_576,
  } }, builder => builder.addReActLoopStep('work', {
    instruction: 'Keep the settled file and finish the task. '.repeat(20), maxTurns: 6,
    onFinish: () => ({ complete: { value: { text: 'Finished.' } } }),
  }))
  const execute = async (effect: { kind: string; key: string }) => {
    if (effect.kind === 'tool') { writes++; return { value: { path: 'saved.md', changed: true } } }
    if (effect.key === '$compact-summary') { summaries++; return { value: { text: 'The file was saved. Preserve it; finish without repeating the write.', finishReason: 'stop' } } }
    models++
    return { value: models === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'saved.md', content: 'saved' } }] } : { text: 'Done.', finishReason: 'stop' } }
  }
  const config = { historySoftTokens: 100, historyHardTokens: decision === 'continue' ? 1000 : 400, builtinHumanEffects: true, effectExecutor: execute }
  const original = new PulseRuntime(config)
  const { agentId } = original.createAgent('Preserve completed work.', program())
  const first = original.start(agentId)
  await expect.poll(() => [...original.state.effects.values()].some(e => e.key === '$compact-confirm' && !e.outcome)).toBe(true)
  const question = [...original.state.effects.values()].find(e => e.key === '$compact-confirm' && !e.outcome)!
  expect(question.input).toMatchObject({ kind: 'ask', type: 'choice', options: [{ value: 'continue' }, { value: 'stop' }] })
  expect(summaries).toBe(0)
  const before = { models, writes }
  // A pending decision survives replacement of the backend without a model call.
  const restored = new PulseRuntime({ ...config, persistence: original.exportPersistence(), programs: [program()] })
  await first.cancel('SIMULATED_PROCESS_REPLACEMENT'); await first.outcome()
  const resumed = restored.start(agentId)
  await expect.poll(() => restored.state.lanes.get('lane-1')?.status).toBe('waiting')
  expect({ models, writes }).toEqual(before)
  await resumed.reply(question.id, decision === 'dismissed' ? { dismissed: true } : { value: decision })
  if (decision === 'continue') {
    // Each subsequent capacity boundary needs its own explicit decision.
    const replied = new Set([question.id])
    for await (const _event of resumed.stream()) {
      for (const e of restored.state.effects.values()) if (e.kind === 'human' && e.state === 'running' && !e.outcome && !replied.has(e.id)) {
        replied.add(e.id); await resumed.reply(e.id, { value: 'continue' })
      }
    }
    const outcome = await resumed.outcome()
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'succeeded' })
    expect(summaries).toBeGreaterThan(0)
    expect(models).toBe(2)
    expect(writes).toBe(1)
  } else {
    const outcome = await resumed.outcome()
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(restored.state.results.get(outcome.resultRef!)?.value).toMatchObject({ taskStatus: 'deferred' })
    expect(summaries).toBe(0)
    expect({ models, writes }).toEqual(before)
  }
})

it.each(['continue', 'stop'])('keeps the Host capacity question pending in auto approval across restart (%s)', async answer => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-capacity-question-'))
  let calls = 0, summaries = 0
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body))
    if (JSON.stringify(body).includes('Return a nonempty plain-text summary only.')) {
      summaries++
      return Response.json({ choices: [{ message: { content: 'Confirmed decisions and completed file reads retained.' }, finish_reason: 'stop' }] })
    }
    calls++
    return Response.json({ choices: [{ message: calls <= 8 ? { content: `Round ${calls}: ` + 'confirmed decisions; '.repeat(500), tool_calls: [{ id: `read-${calls}`, function: { name: 'fs_read', arguments: JSON.stringify({ path: `source-${calls}.txt` }) } }] } : { content: 'All eight files inspected.' }, finish_reason: calls <= 8 ? 'tool_calls' : 'stop' }] })
  }))
  const options = { cwd: root, dataDir: join(root, 'data'), taskController: false, approvalMode: 'auto' as const, maxModelCalls: 32,
    provider: { provider: 'openai-compatible' as const, defaultModel: 'fixture', maxContextTokens: 32_000, maxOutputTokens: 4096 } }
  const first = createLocalHost(options)
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    for (let i = 1; i <= 8; i++) await writeFile(join(root, `source-${i}.txt`), `settled source ${i}`)
    const conversation = await first.createConversation()
    const run = await first.sendMessage(conversation.id, { text: 'Inspect the eight distinct source files and retain the confirmed decisions.' })
    let waiting: Awaited<ReturnType<typeof run.pendingInteractions>> = []
    for await (const event of run.events) if (event.type === 'waiting') { waiting = await run.pendingInteractions(); break }
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.kind).toBe('ask')
    expect(waiting[0]!.items[0]!.input.prompt).toBe('已达到本轮上下文容量，是否继续？')
    expect(summaries).toBe(0)
    const before = calls
    // Preserve the checkpoint through an orderly host replacement.
    await first.close({ preserveRuns: true })
    second = createLocalHost(options)
    const resumed = await second.resumeRun(conversation.id)
    expect(resumed).toBeDefined()
    expect(await resumed!.pendingInteractions()).toEqual(waiting)
    expect(calls).toBe(before)
    await resumed!.reply(waiting[0]!.items[0]!.effectId, { value: answer })
    for await (const event of resumed!.events) if (event.type === 'waiting') {
      for (const group of await resumed!.pendingInteractions()) for (const item of group.items) await resumed!.reply(item.effectId, { value: 'continue' })
    }
    const outcome = await resumed!.outcome()
    expect(outcome.status).toBe(answer === 'stop' ? 'cancelled' : 'succeeded')
    if (answer === 'stop') { expect(calls).toBe(before); expect(summaries).toBe(0); expect(outcome.text).toContain('暂不继续') }
    else { expect(calls).toBeLessThanOrEqual(32); expect(calls).toBeGreaterThan(before); expect(summaries).toBeGreaterThan(0) }
    const saved = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
    if (answer === 'stop') {
      const outcomeFile = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'outcome.json'), 'utf8'))
      expect(outcomeFile.status).toBe('cancelled')
      expect(outcomeFile.error).toBeUndefined()
      expect(outcomeFile.taskOutcome?.status).not.toBe('accepted')
    }
    for (const [, effect] of saved.state.state.effects) if (effect.kind === 'tool' && effect.input?.name === 'fs.read') paths.push(effect.input.arguments.path)
    expect(new Set(paths).size).toBe(paths.length)
    if (answer === 'continue') expect(paths).toEqual(Array.from({ length: 8 }, (_, i) => `source-${i + 1}.txt`))
  } finally { await first.close(); await second?.close(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
