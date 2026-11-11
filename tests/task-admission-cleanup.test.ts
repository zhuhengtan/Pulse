import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHost, type CapabilityPack, type LocalHostOptions, type RunHandle } from '../packages/server/src/index.js'
import { AdmittedTaskRun } from '../packages/server/src/task-admission-run.js'
import { HostTaskAdmissionStore } from '../packages/server/src/task-admission.js'

async function waitingRun(host: ReturnType<typeof createLocalHost>) {
  const conversation = await host.createConversation()
  const run = await host.sendMessage(conversation.id, { text: 'Hold this local task for a human answer.' })
  let waiting = false
  for await (const event of run.events) if (event.type === 'waiting') { waiting = true; break }
  expect(waiting).toBe(true)
  expect(await run.pendingInteractions()).not.toHaveLength(0)
  return { conversation, run }
}
async function fixture(failDispose = true) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-admission-cleanup-'))
  const dispose = vi.fn(async () => { if (failDispose) throw new Error('FIXTURE_RESOURCE_CLOSURE_FAILED') })
  const pack: CapabilityPack = {
    manifest: { id: 'cleanup-fixture', version: '1', kind: 'integration', title: 'Cleanup fixture', description: 'Offline resource closure probe' },
    activate: vi.fn(async () => ({ tools: [], dispose })),
  }
  const options: LocalHostOptions = {
    cwd: root, dataDir: join(root, 'data'), taskAdmissionDirectory: join(root, 'ledger'), taskAdmission: { maxRunning: 1 },
    provider: { provider: 'mock' }, taskController: false, jarvis: { enabled: false }, approvalMode: 'auto',
    capabilityPacks: [pack], enabledCapabilityPacks: ['cleanup-fixture'],
    mockToolCalls: [{ name: 'ask.choice', input: { prompt: 'Wait for confirmation', options: [{ label: 'Hold', value: 'hold' }] } }],
  }
  const host = createLocalHost(options)
  const store = new HostTaskAdmissionStore({ directory: options.taskAdmissionDirectory!, maxRunning: 1 })
  return { root, host, store, options, pack, dispose }
}

describe('task admission waits for confirmed checkpoint cleanup', () => {
  it('does not treat a successful checkpoint acknowledgement as resource closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-admission-checkpoint-'))
    const store = new HostTaskAdmissionStore({ directory: root, maxRunning: 1 })
    let rejectOutcome!: (error: Error) => void
    const outcome = new Promise<Awaited<ReturnType<RunHandle['outcome']>>>((_resolve, reject) => { rejectOutcome = reject })
    const checkpoint = vi.fn(async () => {})
    const permit = { directory: root, jobId: 'active', ownerToken: 'owner', runId: 'run-checkpoint', conversationKey: 'conversation' }
    store.enqueue({ ...permit, projectKey: 'project' })
    const actual: RunHandle = {
      id: permit.runId, conversationId: 'conversation', events: (async function* () {})(),
      outcome: () => outcome, usage: vi.fn(), taskOutcome: async () => undefined,
      checkpointForUpdate: checkpoint, cancel: async () => {}, pendingInteractions: async () => [],
      reviewApproval: async () => ({ status: 'manual' }), reply: async () => {}, replyBatch: async () => {}, submitHumanInput: async () => {},
    }
    try {
      const admitted = new AdmittedTaskRun(store, permit, 'conversation', async () => actual, async () => {})
      await admitted.waitForStart(); await admitted.handle.checkpointForUpdate!()
      expect(checkpoint).toHaveBeenCalledTimes(1)
      const result = admitted.handle.outcome()
      rejectOutcome(new Error('RESOURCE_STOP_UNCONFIRMED'))
      await expect(result).rejects.toThrow('RESOURCE_STOP_UNCONFIRMED')
      expect(store.get(permit.jobId)?.status).toBe('quarantined')
      expect(store.snapshot()).toMatchObject({ occupied: 1 })
      store.enqueue({ jobId: 'replacement', ownerToken: 'other', projectKey: 'project', conversationKey: 'replacement' })
      expect(store.claim('replacement', 'other')).toBeNull()
    } finally { store.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['close', 'releaseCheckpointedRun'] as const)('retains the slot when %s cannot dispose a real activated capability', async method => {
    const f = await fixture(), peer = createLocalHost({ ...f.options, dataDir: join(f.root, 'peer'), capabilityPacks: [], enabledCapabilityPacks: [] })
    let replacement: RunHandle | undefined
    try {
      const { conversation, run } = await waitingRun(f.host)
      expect(f.pack.activate).toHaveBeenCalledTimes(1)
      expect(f.store.snapshot()).toMatchObject({ occupied: 1 })
      if (method === 'close') {
        await expect(f.host.close({ preserveRuns: true })).rejects.toThrow('HOST_RUN_CLEANUP_UNCONFIRMED')
        // A second empty close must not turn an uncertain worker exit into success.
        await expect(f.host.close({ preserveRuns: true })).rejects.toThrow('HOST_RUN_CLEANUP_UNCONFIRMED')
      }
      else {
        await run.checkpointForUpdate!()
        await f.host.releaseCheckpointedRun(conversation.id, run.id)
      }
      expect(f.dispose).toHaveBeenCalledTimes(1)
      await expect(run.outcome()).rejects.toThrow('HOST_TASK_STOP_UNCONFIRMED')
      const ledger = f.store.list().find(record => record.metadata?.runId === run.id)
      expect(ledger).toMatchObject({ status: 'quarantined' })
      expect(f.store.snapshot()).toMatchObject({ occupied: 1, queued: 0 })
      const next = await peer.createConversation(), launch = vi.fn(async () => { throw new Error('REPLACEMENT_MUST_NOT_LAUNCH') })
      replacement = await peer.scheduleTask(next.id, { text: 'replacement' }, launch)
      await delay(180)
      expect(launch).not.toHaveBeenCalled()
      expect(replacement.admission?.().phase).toBe('queued')
      expect(f.store.snapshot()).toMatchObject({ occupied: 1, queued: 1 })
    } finally {
      await replacement?.cancel(); await replacement?.outcome()
      await peer.close()
      if (method === 'close') await expect(f.host.close({ preserveRuns: true })).rejects.toThrow('HOST_RUN_CLEANUP_UNCONFIRMED')
      else await f.host.close({ preserveRuns: true })
      f.store.close()
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('releases a successfully cleaned checkpoint as interrupted and resumes the same run ID', async () => {
    const f = await fixture(false)
    let restarted: ReturnType<typeof createLocalHost> | undefined
    try {
      const { conversation, run } = await waitingRun(f.host)
      await run.checkpointForUpdate!()
      await f.host.releaseCheckpointedRun(conversation.id, run.id)
      expect(f.dispose).toHaveBeenCalledTimes(1)
      await expect(run.outcome()).rejects.toThrow('HOST_TASK_CHECKPOINTED')
      expect(f.store.list().find(record => record.metadata?.runId === run.id)?.status).toBe('interrupted')
      expect(f.store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
      await f.host.close({ preserveRuns: true })
      restarted = createLocalHost(f.options)
      const resumed = await restarted.resumeRun(conversation.id)
      expect(resumed.id).toBe(run.id)
      let waiting = false
      for await (const event of resumed.events) if (event.type === 'waiting') { waiting = true; break }
      expect(waiting).toBe(true)
      expect(f.store.snapshot()).toMatchObject({ occupied: 1, queued: 0 })
      await restarted.close({ preserveRuns: true }); restarted = undefined
      expect(f.store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
    } finally {
      await restarted?.close({ preserveRuns: true }); await f.host.close({ preserveRuns: true }); f.store.close()
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
