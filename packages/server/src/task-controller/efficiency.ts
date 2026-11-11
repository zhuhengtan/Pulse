import type { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { controllerFromGlobal, type TaskControllerState } from './state.js'
import { claimBatchSize } from './source-claim-audit.js'

export interface VerificationDemand { calls: number; reason: string; repairUsed: boolean }

/** Derived from durable progress, never from a model's estimate of its own cost. */
export function verificationDemand(state: TaskControllerState | undefined, step: string, sources: boolean, visual: boolean, enabled: boolean): VerificationDemand {
  if (!enabled || step === 'report') return { calls: 0, reason: enabled ? 'report' : 'quality_review_disabled', repairUsed: false }
  const repairUsed = !!state && (state.tasks.some(t => !!t.citationRepairs) || !!state.finalReviewErrors?.length || (state.sourceClaimAudit?.correctionRounds ?? 0) > 0)
  const stages = state ? state.tasks.filter(t => ['pending', 'running', 'verifying'].includes(t.status)).length : 1
  const claimsStarted = step.startsWith('verify-claims') || !!state?.sourceClaimAudit
  const sourceStarted = claimsStarted || step.startsWith('verify-sources') || step.startsWith('source-delivery')
  const final = sourceStarted ? 0 : 1
  const source = sources || visual ? claimsStarted ? 0 : 1 : 0
  const audit = state?.sourceClaimAudit
  const claims = sources && !visual ? audit ? Math.ceil(Math.max(0, audit.targets.length - audit.offset) / claimBatchSize) : 1 : 0
  const mandatory = stages + final + source + claims
  const used = state?.actualBudget?.used ?? state?.usedTurns ?? 0
  const limit = state?.actualBudget?.limit ?? state?.maxTurns ?? 256
  const nextWork = !state?.tasks.length ? 2 : state.tasks.some(task => task.status === 'pending' || task.status === 'running') ? 1 : 0
  // Keep mandatory acceptance intact. An optional correction slot must not
  // consume the last slot needed to produce the artifact it would verify.
  const repair = !repairUsed && limit - used > mandatory + nextWork ? 1 : 0
  return { calls: mandatory + repair, reason: `stages=${stages};final=${final};sources=${source};claims=${claims}`, repairUsed }
}

export function runtimeVerificationDemand(runtime: PulseRuntime | undefined, enabled: boolean): VerificationDemand {
  if (!runtime) return verificationDemand(undefined, 'plan', false, false, enabled)
  const agent = [...runtime.state.agents.values()][0]
  const state = agent ? controllerFromGlobal(agent.globalVersions.get(agent.latestGlobalVersion) ?? {}) : undefined
  // Ordinary chat has no task-controller contract or reserved quality chain.
  if (!state) return { calls: 0, reason: 'no_controller', repairUsed: false }
  const lane = agent ? runtime.state.lanes.get(agent.rootLaneId) : undefined
  const tools = [...runtime.state.effects.values()].filter(effect => effect.agentId === agent?.id && effect.kind === 'tool' && effect.outcome?.status === 'succeeded').map(effect => (effect.input as { name?: string } | undefined)?.name)
  return verificationDemand(state, lane?.resume.step ?? 'plan', tools.includes('web.fetch'), tools.some(t => t === 'computer.observe' || t === 'browser.observe'), enabled)
}

/** Absolute deadlines survive checkpoint restoration; byte cursors never restart. */
export function shellWaitDeadline(now: number, previous: number | undefined, startedAt?: number, timeoutMs?: number): number {
  return previous ?? (startedAt ?? now) + (typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 600_000)
}
