import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.on('message', (message) => {
  if (message?.schemaVersion === 1 && message.type === 'configure') {
    process.send({ schemaVersion: 1, type: 'configured' })
    return
  }
  if (message?.schemaVersion !== 1 || message.type !== 'start') return
  process.send({ schemaVersion: 1, type: 'started', requestId: message.requestId, runId: 'run-worker-fixture', conversationId: message.conversationId })
  process.send({ schemaVersion: 1, type: 'event', event: { schemaVersion: 1, type: 'text', conversationId: message.conversationId, runId: 'run-worker-fixture', seq: 1, data: 'from worker' } })
  process.send({ schemaVersion: 1, type: 'event', event: { schemaVersion: 1, type: 'complete', conversationId: message.conversationId, runId: 'run-worker-fixture', seq: 2, data: { status: 'succeeded' } } })
  const settle = setTimeout(() => {
    process.send({ schemaVersion: 1, type: 'settled', outcome: { status: 'succeeded' }, usage: { schemaVersion: 1, inputTokens: 1, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, visibleOutputChars: 11, modelCalls: 1, truncationEvents: 0, durationMs: 10, providerCosts: [], completeness: 'complete' } })
    // Model cleanup that still owns files after publishing the outcome.
    setTimeout(() => {
      const dataDir = process.argv[process.argv.indexOf('--data-dir') + 1]
      writeFileSync(join(dataDir, 'worker-cleanup-complete.txt'), 'closed')
      if (message.text === 'fail during cleanup') process.exitCode = 1
      process.disconnect()
    }, 150)
  }, 250)
  process.on('message', (rpc) => {
    if (rpc?.schemaVersion !== 1 || rpc.type !== 'rpc') return
    if (rpc.method === 'pendingInteractions') process.send({ schemaVersion: 1, type: 'rpcResult', requestId: rpc.requestId, ok: true, value: [] })
    else process.send({ schemaVersion: 1, type: 'rpcResult', requestId: rpc.requestId, ok: true })
  })
  process.on('disconnect', () => clearTimeout(settle))
})

process.send({ schemaVersion: 1, type: 'ready' })
