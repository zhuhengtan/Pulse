import { expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

it.each([{ batchSize: 1, limit: 1 }, { batchSize: 4, limit: 4 }, { batchSize: 4, limit: 1 }])('consumes compacted tool proposals once through approval ($batchSize calls, limit $limit)', async ({ batchSize, limit }) => {
  let models = 0, summaries = 0, approvals = 0
  const executed: string[] = []
  const program = defineLaneProgram({
    id: `compacted-approval-${batchSize}`, version: '1',
    historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 },
  }, builder => builder.addReActLoopStep('work', {
    instruction: 'Inspect the source, then write the plan. '.repeat(20),
    maxTurns: 12, maxToolsPerTurn: limit,
    toolApproval: { prompt: 'Approve this batch only.' },
    onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({ historySoftTokens: 128, historyHardTokens: 32_000, effectExecutor: async effect => {
    if (effect.kind === 'human') { approvals++; return { value: { approved: true } } }
    if (effect.kind === 'tool') {
      const input = effect.input as { name: string; arguments: { path: string } }
      executed.push(input.arguments.path)
      return { value: { path: input.arguments.path, content: 'settled source', changed: true } }
    }
    if ((effect.input as { task?: string }).task === 'summarize') { summaries++; return { value: { text: 'The source was inspected; retain the next proposal for approval.' } } }
    models++
    if (models === 1) return { value: { finishReason: 'tool_calls', toolCalls: Array.from({ length: batchSize }, (_, i) => ({ name: 'fs.read', input: { path: `source-${i}.ts` } })) } }
    if (models === 2) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'plan.write', input: { path: 'docs/plans/change.md', content: 'Confirmed plan' } }] } }
    return { value: { text: 'The plan is ready.', finishReason: 'stop' } }
  } })
  const session = runtime.start(runtime.createAgent('write the confirmed plan', program).agentId)
  const outcome = await session.outcome()
  expect(outcome, JSON.stringify({ outcome, models, summaries, approvals, executed })).toMatchObject({ status: 'succeeded' })
  expect(summaries).toBeGreaterThan(0)
  expect(models).toBe(3)
  expect(approvals).toBe(2)
  expect(executed).toEqual([...Array.from({ length: batchSize }, (_, i) => `source-${i}.ts`), 'docs/plans/change.md'])
})

it('stops the lane when a tool batch is denied even if stage recovery would continue', async () => {
  let tools = 0
  const program = defineLaneProgram({ id: 'denied-tool-approval', version: '1' }, builder => builder.addReActLoopStep('work', {
    instruction: 'Write the file.', maxTurns: 6, toolApproval: { prompt: 'Approve this write.' }, onError: () => 'work', onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'human') return { value: { approved: false, reason: 'no' } }
    if (effect.kind === 'tool') { tools++; return { value: { ok: true } } }
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'a.txt', content: 'x' } }] } }
  } })
  await expect(runtime.start(runtime.createAgent('deny the write', program).agentId).outcome()).resolves.toMatchObject({ status: 'failed', error: { code: 'APPROVAL_DENIED' } })
  expect(tools).toBe(0)
})

it('still stops genuinely repeated proposals after compaction and approval', async () => {
  let summaries = 0, models = 0
  const program = defineLaneProgram({
    id: 'repeated-compacted-approval', version: '1',
    historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 },
  }, builder => builder.addReActLoopStep('work', {
    instruction: 'Inspect and then deliver the plan. '.repeat(20), maxTurns: 20,
    toolApproval: { prompt: 'Approve this operation only.' }, onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({ historySoftTokens: 128, historyHardTokens: 32_000, effectExecutor: async effect => {
    if (effect.kind === 'human') return { value: { approved: true } }
    if (effect.kind === 'tool') return { value: { path: 'source.ts', content: 'unchanged' } }
    if ((effect.input as { task?: string }).task === 'summarize') { summaries++; return { value: { text: 'Repeated read has no new evidence.' } } }
    models++
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'source.ts' } }] } }
  } })
  expect(await runtime.start(runtime.createAgent('stop actual loops', program).agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
  expect(summaries).toBeGreaterThan(0)
  expect(models).toBeLessThan(20)
})

it('recovers a legacy checkpoint with a stale compacted proposal without replaying its read', async () => {
  let models = 0, reads = 0
  const program = () => defineLaneProgram({ id: 'legacy-approved-pin', version: '1' }, builder => {
    builder.addStep('start', () => ({
      actions: [{ type: 'submit_effects', effects: [{ key: 'legacy-proposal', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'legacy-approved',
    }))
    // Reproduce the persisted shape of an old approval: the read was dispatched
    // but its compacted model proposal remained pinned across the tool wait.
    builder.addStep('legacy-approved', ctx => {
      const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).find(item => item.state === 'settled') : undefined
      if (dependency?.state !== 'settled' || !dependency.outcome.resultRef) throw new Error('LEGACY_PROPOSAL_MISSING')
      return {
        actions: [{ type: 'submit_effects', effects: [
          { key: 'legacy-read', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.read', arguments: { path: 'source.ts' } } },
          { key: 'restart-checkpoint', kind: 'human', concurrencyClass: 'none', input: { prompt: 'Resume this saved checkpoint.' } },
        ], wait: { onUnsatisfied: 'resume_with_error' } }],
        next: 'work:tools', locals: { $sdk: { workTurns: 1, workInputs: {}, workPendingResultRef: dependency.outcome.resultRef } },
      }
    })
    builder.addReActLoopStep('work', { instruction: 'Finish using the completed read.', maxTurns: 8, onFinish: () => ({ complete: {} }) })
  })
  const execute = async (effect: { kind: string }) => {
    if (effect.kind === 'tool') { reads++; return { value: { path: 'source.ts', content: 'settled source' } } }
    models++
    return { value: models === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'source.ts' } }] } : { text: 'Finished from retained evidence.', finishReason: 'stop' } }
  }
  const original = new PulseRuntime({ builtinHumanEffects: true, effectExecutor: execute })
  const agent = original.createAgent('recover old approved read', program())
  const originalSession = original.start(agent.agentId)
  await expect.poll(() => reads === 1 && [...original.state.effects.values()].some(effect => effect.kind === 'human' && !effect.outcome)).toBe(true)
  const question = [...original.state.effects.values()].find(effect => effect.kind === 'human' && !effect.outcome)!
  const restored = new PulseRuntime({ persistence: original.exportPersistence(), programs: [program()], builtinHumanEffects: true, effectExecutor: execute })
  await originalSession.cancel('SIMULATED_PROCESS_REPLACEMENT')
  await originalSession.outcome()
  const session = restored.start(agent.agentId)
  await session.reply(question.id, { approved: true })
  expect(await session.outcome()).toMatchObject({ status: 'succeeded' })
  expect(reads).toBe(1)
  expect(models).toBe(2)
})
