// Local scripted Provider; this worker never reads the user's provider configuration.
import { join } from 'node:path'
import { LocalHost } from '../../packages/server/dist/index.js'
import { runH5WorkWorker } from '../../packages/server/dist/h5/work-worker.js'
import { MockAdapter } from '../../packages/adapters/dist/index.js'
const directory = process.argv[process.argv.indexOf('--data-dir') + 1]
let step = 0
MockAdapter.prototype.executeAttempt = async function (params) {
  if (params.outputSchema) return { text: JSON.stringify({ status: 'unverifiable', criteria: [{ criterionId: 'criterion-1', status: 'unverifiable', evidenceRefs: [], rationale: 'Local transport fixture only.' }] }), toolCalls: [], finishReason: 'stop' }
  step++
  const name = step === 1 ? 'shell.start' : 'ask.choice'
  const input = step === 1 ? { command: 'node', args: [join(directory, 'interactive.cjs')], pty: true, timeoutMs: 15000 } : { prompt: 'Keep the local process open for transport verification?', options: [{ value: 'yes', label: 'Yes' }] }
  return { text: '', toolCalls: [{ toolCallId: `fixture-${step}`, name, input }], finishReason: 'tool_calls' }
}
const host = new LocalHost({ cwd: directory, dataDir: directory, provider: { provider: 'mock' }, taskController: false, jarvis: { enabled: false }, approvalMode: 'ask' })
process.exitCode = await runH5WorkWorker(host, process.argv[4])
