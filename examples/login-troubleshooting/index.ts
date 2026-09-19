import { PulseRuntime, type LaneProgram } from '@pulse/runtime'

const point = (step: string) => ({ programId: 'login-troubleshooting', programVersion: '1', step, locals: {} })

export function createLoginTroubleshootingRuntime(): { runtime: PulseRuntime; agentId: string } {
  const program: LaneProgram = {
    id: 'login-troubleshooting', version: '1',
    step: ({ lane }) => {
      if (lane.resume.step === 'start' && lane.goal === 'login incident') return { actions: [{ type: 'fork', lanes: [
        { key: 'analyze', goal: 'analyze', program: point('worker') },
        { key: 'tests', goal: 'tests', program: point('worker') },
      ], join: { condition: 'settled', onUnsatisfied: 'resume_with_error' } }], next: point('synthesize') }
      if (lane.resume.step === 'worker') return { actions: [{ type: 'complete', result: lane.goal === 'analyze' ? { finding: 'token initialization race' } : { test: 'reproduction captured' } }], next: point('worker') }
      return { actions: [{ type: 'complete', result: { status: 'fixed', evidence: ['analyze', 'tests'] } }], next: point('synthesize') }
    },
  }
  const runtime = new PulseRuntime()
  const { agentId } = runtime.createAgent('login incident', program)
  return { runtime, agentId }
}
