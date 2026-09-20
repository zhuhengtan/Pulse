import { PulseRuntime, FileRuntimePersistenceBackend } from '../packages/runtime/src/index.ts'

const filePath = process.env.PULSE_PROCESS_RECOVERY_PATH
if (!filePath) throw new Error('PULSE_PROCESS_RECOVERY_PATH is required')
const backend = new FileRuntimePersistenceBackend(filePath)
const runtime = new PulseRuntime()
const program = { id: 'process-recovery', version: '1', step: () => ({ actions: [], next: { programId: 'process-recovery', programVersion: '1', step: 'start', locals: {} } }) }
const { agentId, laneId } = runtime.createAgent('process recovery', program)
runtime.state.effects.set('effect-1', { id: 'effect-1', agentId, ownerLaneId: laneId, key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'workspace', mode: 'exclusive' }], state: 'running', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'running', sideEffectState: 'applied', sideEffectPolicy: 'write' })
runtime.outbox.enqueue({ id: 'effect-1', attemptId: 'effect-1-attempt-1' })
await runtime.persist(backend)
process.kill(process.pid, 'SIGKILL')
