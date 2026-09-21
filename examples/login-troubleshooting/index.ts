import { z } from 'zod'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

const LoginState = z.object({
  plan: z.object({ analyzeGoal: z.string(), testsGoal: z.string(), fixGoal: z.string() }).optional(),
})

const workerProgram = defineLaneProgram({ id: 'login-troubleshooting.worker', version: '1' }, (builder) => {
  builder.addStep('start', (ctx) => ({
    actions: [{ type: 'complete', result: ctx.goal === 'analyze'
      ? { finding: 'token initialization race' }
      : ctx.goal === 'tests'
        ? { test: 'reproduction captured' }
        : { patch: 'serialized token initialization' } }],
    next: 'start',
  }))
})

const mainProgram = defineLaneProgram({
  id: 'login-troubleshooting.main',
  version: '1',
  system: 'You are a senior incident investigator. Work from evidence.',
  toolSet: 'coding.default',
  state: LoginState,
}, (builder) => {
  builder.addStructuredLLMStep('plan', {
    task: 'plan',
    instruction: (view) => `Break down the login incident for ${view.goal}.`,
    schema: z.object({ analyzeGoal: z.string(), testsGoal: z.string(), fixGoal: z.string() }),
    onSuccess: (plan, ctx) => {
      ctx.mutateLane((draft) => { draft.plan = plan })
      return 'dispatch'
    },
  })
  builder.addParallelStep('dispatch', {
    lanes: {
      analyze: { goal: 'analyze', program: { programId: workerProgram.id, programVersion: workerProgram.version } },
      tests: { goal: 'tests', program: { programId: workerProgram.id, programVersion: workerProgram.version } },
      fix: { goal: 'fix', program: { programId: workerProgram.id, programVersion: workerProgram.version }, dependsOn: [{ sibling: 'analyze', condition: 'success' }] },
    },
    join: { condition: 'settled' },
    onJoin: (outcomes) => outcomes.fix?.status === 'succeeded' && outcomes.tests?.status === 'succeeded'
      ? 'verify'
      : { fail: { code: 'PIPELINE_FAILED', message: 'Analyze, tests, or fix did not complete successfully.' } },
  })
  builder.addReActLoopStep('verify', {
    instruction: 'Verify the patch against the reproduced login failure.',
    outputSchema: z.object({ passed: z.boolean(), summary: z.string() }),
    onFinish: {
      text: () => ({ fail: { code: 'UNSTRUCTURED_VERIFY', message: 'Verification must be structured.' } }),
      structured: { schema: z.object({ passed: z.boolean(), summary: z.string() }), onParsed: (value) => value.passed ? { complete: { value } } : { fail: { code: 'VERIFY_FAILED', message: value.summary } } },
    },
  })
})

export function createLoginTroubleshootingRuntime(): { runtime: PulseRuntime; agentId: string } {
  const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
    if (effect.key === 'plan-llm') return { value: { analyzeGoal: 'analyze', testsGoal: 'tests', fixGoal: 'fix' } }
    if (effect.key === 'verify-turn-1') return { value: { passed: true, summary: 'The serialized token initialization fixes the reproduced race.' } }
    return { value: { ok: true } }
  } })
  runtime.register(workerProgram)
  const { agentId } = runtime.createAgent('login incident', mainProgram)
  return { runtime, agentId }
}
