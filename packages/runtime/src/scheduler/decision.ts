import type { LaneRecord } from '../core/types.js'

export interface SchedulerDecisionCandidate {
  laneId: string
  agentId: string
  goal?: string
  effectivePriority: number
  basePriority: number
  waitingMs: number
  inheritedFloor?: number
}

export interface SchedulerDecisionRequest {
  schemaVersion: 1
  decisionId: string
  candidateEpoch: number
  now: number
  availableSlots: number
  candidates: readonly SchedulerDecisionCandidate[]
}

export interface SchedulerDecision {
  decisionId: string
  candidateEpoch: number
  orderedLaneIds: string[]
  modelId: string
}

/**
 * An advisory scheduler policy. Implementations may be model-, ranker-, or
 * rule-based. They never receive Runtime mutators and their result is only
 * considered after it returns through the Runtime FactInbox.
 */
export interface SchedulerDecisionModel {
  readonly id: string
  decide(request: SchedulerDecisionRequest, signal: AbortSignal): Promise<SchedulerDecision>
}

export interface SchedulerDecisionConfig {
  model?: SchedulerDecisionModel
  /** Minimum number of ready lanes before the advisory model is consulted. */
  minCandidates?: number
  /** Maximum number of deterministic top candidates exposed to the model. */
  candidateLimit?: number
  /** Maximum time an advisory request may run before deterministic fallback. */
  decisionTimeoutMs?: number
  /** Number of outstanding advisory requests allowed at once. */
  maxOutstandingDecisions?: number
  /** Maximum distance from deterministic order that a suggestion may move a lane. */
  maxReorderDistance?: number
  /** Every Nth dispatch is deterministic, even when a model suggestion exists. */
  deterministicReserveEvery?: number
  /** Goals are local data; expose them only when the host explicitly opts in. */
  includeGoals?: boolean
}

export interface SchedulerDecisionCoordinatorOptions {
  model: SchedulerDecisionModel
  timeoutMs: number
  maxOutstanding: number
}

/**
 * Owns only the lifecycle of advisory calls. It deliberately has no Runtime
 * reference: completion is delivered to the caller, which must enqueue a
 * fact before touching Runtime state.
 */
export class SchedulerDecisionCoordinator {
  private readonly model: SchedulerDecisionModel
  private readonly timeoutMs: number
  private readonly maxOutstanding: number
  private readonly controllers = new Set<AbortController>()
  private outstanding = 0

  constructor(options: SchedulerDecisionCoordinatorOptions) {
    this.model = options.model
    this.timeoutMs = options.timeoutMs
    this.maxOutstanding = options.maxOutstanding
  }

  get pending(): number { return this.outstanding }

  request(request: SchedulerDecisionRequest, onDecision: (decision: SchedulerDecision) => void, onFailure: () => void = () => undefined): boolean {
    if (this.outstanding >= this.maxOutstanding) return false
    const controller = new AbortController()
    this.controllers.add(controller)
    this.outstanding++
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    void Promise.resolve()
      .then(() => this.model.decide(structuredClone(request), controller.signal))
      .then((decision) => {
        if (!decision || typeof decision !== 'object') return
        try { onDecision(structuredClone(decision)) } catch { /* advisory failures never escape into the Runtime turn */ }
      }, () => {
        try { onFailure() } catch { /* advisory failures never escape into the Runtime turn */ }
      })
      .finally(() => {
        clearTimeout(timer)
        this.controllers.delete(controller)
        this.outstanding--
      })
    return true
  }

  cancel(): void {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }
}

export function schedulerDecisionCandidateFromLane(
  lane: Readonly<LaneRecord>,
  effectivePriority: number,
  now: number,
  includeGoal: boolean,
  inheritedFloor = lane.inheritedFloor,
): SchedulerDecisionCandidate {
  return {
    laneId: lane.id,
    agentId: lane.agentId,
    ...(includeGoal ? { goal: lane.goal } : {}),
    effectivePriority,
    basePriority: lane.priority,
    waitingMs: Math.max(0, now - lane.readySince),
    ...(inheritedFloor === undefined ? {} : { inheritedFloor }),
  }
}
