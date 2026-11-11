import { expect, it } from 'vitest'
import { PulseRuntime, SessionStoragePolicy, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { historyBudget } from '../packages/server/src/model-settings.js'

it('keeps small model windows and fits large windows to the persisted storage limits', () => {
  const limits = new SessionStoragePolicy().snapshot().limits
  expect(historyBudget({ maxContextTokens: 32_000, maxOutputTokens: 4096 }, limits)).toEqual({ historySoftTokens: 6976, historyHardTokens: 13952 })
  expect(historyBudget({ maxContextTokens: 1, maxOutputTokens: 4096 }, limits)).toEqual({ historySoftTokens: 1, historyHardTokens: 1 })
  expect(historyBudget({ maxContextTokens: 1_048_576, maxOutputTokens: 64_960 }, limits)).toEqual({ historySoftTokens: 62_500, historyHardTokens: 125_000 })
  expect(historyBudget({ maxContextTokens: 1_048_576 }, { ...limits, maxSnapshotBytes: 500_000 })).toEqual({ historySoftTokens: 31_250, historyHardTokens: 62_500 })
  expect(historyBudget({ maxContextTokens: 1_048_576 }, { ...limits, maxTotalMemoryBytes: 500_000 })).toEqual({ historySoftTokens: 31_250, historyHardTokens: 62_500 })
})

it.each([false, true])('compacts a long approved task before storage admission fails (storageAware=%s)', async storageAware => {
  const limits = new SessionStoragePolicy().snapshot().limits
  const budget = historyBudget({ maxContextTokens: 1_048_576, maxOutputTokens: 64_960 }, storageAware ? limits : undefined)
  let models = 0, summaries = 0, approvals = 0
  const executed: string[] = []
  const program = defineLaneProgram({
    id: 'storage-aware-history', version: '1', explicitContext: true, includeLaneHistory: true,
    historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 },
  }, builder => builder.addReActLoopStep('work', {
    instruction: 'Inspect the next distinct source. Preserve the confirmed user decisions.',
    maxTurns: 100, continuousExecution: true,
    toolApproval: { prompt: 'Approve this operation.' }, onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({ ...budget, maxResultSummaryBytes: 128_000,
    // Model the Host's durable-write acknowledgement between effect dispatches.
    persistenceBackend: { load: async () => undefined, save: async () => undefined },
    effectExecutor: async effect => {
      if (effect.kind === 'human') { approvals++; return { value: { approved: true } } }
      if (effect.kind === 'tool') {
        const path = (effect.input as { arguments: { path: string } }).arguments.path
        executed.push(path)
        return { value: { path, content: 'Settled evidence for this distinct file.' } }
      }
      if ((effect.input as { task?: string }).task === 'summarize') {
        summaries++
        return { value: { text: 'Confirmed user decisions retained. Continue inspecting the next distinct source.', finishReason: 'stop' } }
      }
      models++
      return { value: models <= 16 ? {
        text: `Round ${models}: ` + 'confirmed decision and source evidence; '.repeat(2400),
        finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `source-${models}.ts` } }],
      } : { text: 'Inspection completed.', finishReason: 'stop' } }
    },
  })
  const outcome = await runtime.start(runtime.createAgent('Inspect 16 distinct files with confirmed user decisions.', program).agentId).outcome()
  if (!storageAware) {
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'SESSION_STORAGE_LIMIT_EXCEEDED' } })
    expect(summaries).toBe(0)
  } else {
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(summaries).toBeGreaterThan(0)
    expect(models).toBe(17)
    expect(approvals).toBe(16)
    expect(executed).toEqual(Array.from({ length: 16 }, (_, i) => `source-${i + 1}.ts`))
    expect(runtime.storagePolicy.snapshot().limits).toEqual(limits)
  }
}, 30_000)
