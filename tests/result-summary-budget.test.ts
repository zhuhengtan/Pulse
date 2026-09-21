import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

describe('Result summary budget', () => {
  it('drops oversized summaries while retaining the immutable result', async () => {
    const program: LaneProgram = {
      id: 'summary-budget',
      version: '1',
      step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'summary-budget', programVersion: '1', step: 'finish', locals: {} } }
        : { actions: [{ type: 'complete', result: { done: true } }], next: { programId: 'summary-budget', programVersion: '1', step: 'finish', locals: {} } },
    }
    const runtime = new PulseRuntime({ maxResultSummaryBytes: 8, effectExecutor: async () => ({ value: { payload: 'kept' }, summary: { too: 'large' } }) })
    const { agentId } = runtime.createAgent('summary budget', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const result = [...runtime.state.results.values()].find((record) => record.effectId === 'effect-1')
    expect(result?.value).toEqual({ payload: 'kept' })
    expect(result?.summary).toBeUndefined()
    expect(runtime.state.events.some((event) => event.type === 'result.summary_rejected')).toBe(true)
  })

  it('fails an effect cleanly when its Artifact cannot pass storage admission', async () => {
    const program: LaneProgram = {
      id: 'artifact-storage-limit',
      version: '1',
      step: ({ lane, resumeInput }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'artifact', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'artifact-storage-limit', programVersion: '1', step: 'finish', locals: {} } }
        : { actions: [{ type: 'complete', result: { status: resumeInput?.type === 'wait' ? resumeInput.resolution.status : 'missing' } }], next: { programId: 'artifact-storage-limit', programVersion: '1', step: 'finish', locals: {} } },
    }
    const runtime = new PulseRuntime({ storagePolicy: { maxArtifactBytes: 1 }, effectExecutor: async () => ({ value: null, artifact: { mediaType: 'text/plain', content: 'too large' } }) })
    const { agentId } = runtime.createAgent('artifact storage limit', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const effect = runtime.state.effects.get('effect-1')
    expect(effect).toMatchObject({ state: 'failed', outcome: { status: 'failed', error: { code: 'SESSION_STORAGE_LIMIT_EXCEEDED' } } })
    expect(runtime.state.artifacts.size).toBe(0)
    expect(runtime.state.events.some((event) => event.type === 'effect.settled')).toBe(true)
    expect(runtime.mutationLog.entries.some((entry) => entry.transactionId === 'effect:effect-1:effect-1-attempt-1:storage-rejected')).toBe(true)
  })

  it('fails a closing Lane instead of publishing an over-limit terminal Result', async () => {
    const point = (step: string) => ({ programId: 'closing-result-limit', programVersion: '1', step, locals: {} })
    const program: LaneProgram = {
      id: 'closing-result-limit',
      version: '1',
      step: ({ lane }) => {
        if (lane.goal === 'parent' && lane.resume.step === 'start') return { actions: [{ type: 'fork', lanes: [{ key: 'child', goal: 'child', program: point('child') }] }], next: point('close') }
        if (lane.goal === 'parent' && lane.resume.step === 'close') return { actions: [{ type: 'complete', result: { payload: 'x'.repeat(500) }, children: 'await' }], next: point('close') }
        if (lane.resume.step === 'child') return { actions: [{ type: 'submit_effects', effects: [{ key: 'child-work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('child-done') }
        return { actions: [{ type: 'complete', result: { child: true } }], next: point('child-done') }
      },
    }
    const runtime = new PulseRuntime({ storagePolicy: { maxResultBytes: 256 }, effectExecutor: async () => ({ value: { ok: true } }) })
    const { agentId, laneId } = runtime.createAgent('parent', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)).toMatchObject({ status: 'failed', failure: { error: { code: 'SESSION_STORAGE_LIMIT_EXCEEDED' } } })
    expect(runtime.state.lanes.get(laneId)?.resultRef).toBeUndefined()
  })

  it('fails closed when the fact-event budget cannot record the storage rejection', async () => {
    const program: LaneProgram = {
      id: 'event-storage-limit',
      version: '1',
      step: () => ({ actions: [{ type: 'complete', result: { done: true } }], next: { programId: 'event-storage-limit', programVersion: '1', step: 'done', locals: {} } }),
    }
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1 } })
    const { agentId, laneId } = runtime.createAgent('event storage limit', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)).toMatchObject({ status: 'failed', failure: { error: { code: 'SESSION_STORAGE_LIMIT_EXCEEDED' } } })
    expect(runtime.state.events).toHaveLength(0)
  })
})
