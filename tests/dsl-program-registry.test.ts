import { describe, expect, it } from 'vitest'
import { defineLaneProgram, PulseRuntime, type LaneProgram, type ProgramRef } from '../packages/runtime/src/index.js'

describe('DSL program registry contract', () => {
  it('registers programs and starts an agent from a ProgramRef', async () => {
    const program = defineLaneProgram({ id: 'registry-worker', version: '1' }, (builder) => {
      builder.addStep('custom', (ctx) => ({ actions: [{ type: 'complete', result: ctx.lane.resume.locals }], next: 'custom' }))
    })
    const runtime = new PulseRuntime()
    const ref: ProgramRef = { programId: program.id, programVersion: program.version, step: 'custom', locals: { marker: 'from-ref' } }

    runtime.programs.register(program)
    const created = runtime.createAgent({ goal: 'registered program', program: ref })
    const outcome = await runtime.run(created.agentId)

    expect(outcome.status).toBe('succeeded')
    expect(outcome.resultRef).toBeDefined()
    const root = runtime.state.lanes.get(created.laneId)
    expect(root?.resultRef).toBeDefined()
    expect(runtime.state.results.get(root!.resultRef!)?.value).toEqual({ marker: 'from-ref' })
  })

  it('rejects an unregistered ProgramRef instead of implicitly registering it', () => {
    const runtime = new PulseRuntime()
    expect(() => runtime.createAgent({
      goal: 'missing program',
      program: { programId: 'missing', programVersion: '1' },
    })).toThrow('PROGRAM_NOT_REGISTERED:missing@1')
  })

  it('keeps the compatibility path for direct LaneProgram creation', async () => {
    const program = defineLaneProgram({ id: 'direct-program', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'start' }))
    })
    const runtime = new PulseRuntime()
    const created = runtime.createAgent('direct program', program)

    expect((await runtime.run(created.agentId)).status).toBe('succeeded')
    expect(runtime.programs.has(program.id, program.version)).toBe(true)
  })

  it('rejects cyclic series program registration atomically', () => {
    const runtime = new PulseRuntime()
    const first: LaneProgram = { id: 'cycle-a', version: '1', step: () => ({ actions: [], next: { programId: 'cycle-a', programVersion: '1', step: 'start', locals: {} } }) }
    const second: LaneProgram = { id: 'cycle-b', version: '1', step: () => ({ actions: [], next: { programId: 'cycle-b', programVersion: '1', step: 'start', locals: {} } }), seriesMemberProgram: first }
    first.seriesMemberProgram = second
    expect(() => runtime.programs.register(first)).toThrow('PROGRAM_REGISTRATION_CYCLE:cycle-a@1')
    expect(runtime.programs.has('cycle-a', '1')).toBe(false)
    expect(runtime.programs.has('cycle-b', '1')).toBe(false)
  })
})
