// Exercises the actual worker bootstrap and remote Tool Effect wiring with a
// deterministic host stub. It never opens credentials, a ledger or hardware.
import { runH5WorkWorker } from '../../packages/server/dist/h5/work-worker.js'
import { createRemoteDeviceActivation } from '../../packages/server/dist/device-use/worker-ipc.js'
let activation, complete
const finished = new Promise(resolve => { complete = resolve })
const host = {
  applyWorkerOptions() {}, async init() {}, async close() {},
  setDeviceUseRemoteExecutor(executor, tools, instructions) { activation = createRemoteDeviceActivation({ tools, instructions }, executor) },
  async sendMessage(conversationId) {
    const id = 'run-device-runtime-bootstrap'
    const events = (async function* () {
      const tool = activation.tools.find(t => t.manifest.name === 'device.list')
      if (!tool) throw new Error('DEVICE_REMOTE_TOOL_MISSING')
      const result = await tool.execute({}, { toolCallId: 'runtime-call', effectId: 'runtime-effect', attemptId: 'runtime-attempt', agentId: 'runtime-agent', laneId: 'runtime-lane', signal: new AbortController().signal, emit() {} })
      yield { schemaVersion: 1, type: 'text', runId: id, conversationId, seq: 1, data: JSON.stringify(result) }
      yield { schemaVersion: 1, type: 'complete', runId: id, conversationId, seq: 2, data: { status: 'succeeded' } }
      complete()
    })()
    return { id, events, outcome: async () => { await finished; return { status: 'succeeded' } }, usage: async () => ({ schemaVersion: 1, modelCalls: 0 }), taskOutcome: async () => undefined }
  },
}
process.exitCode = await runH5WorkWorker(host, process.argv[4])
