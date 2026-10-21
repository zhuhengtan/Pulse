import type { EffectRecord, HumanInputRecord, JsonValue, LaneRecord } from '../core/types.js'

export type HumanArbitrationAction = 'respond' | 'steer' | 'spawn' | 'defer' | 'cancel'

export interface HumanArbitrationCandidate {
  laneId: string
  agentId: string
  status: LaneRecord['status']
  priority: number
  goal?: string
  activeWaitId?: string
}

export interface HumanArbitrationEffectCandidate {
  effectId: string
  agentId: string
  laneId: string
  kind: EffectRecord['kind']
  state: EffectRecord['state']
  sideEffectPolicy?: EffectRecord['sideEffectPolicy']
  sideEffectState: EffectRecord['sideEffectState']
}

export interface HumanArbitrationRequest {
  schemaVersion: 1
  decisionId: string
  agentId: string
  input: HumanInputRecord
  lanes: readonly HumanArbitrationCandidate[]
  effects: readonly HumanArbitrationEffectCandidate[]
  availableLLMSlots: number
}

export interface HumanArbitrationDecision {
  schemaVersion?: 1
  decisionId: string
  inputId: string
  agentId: string
  action: HumanArbitrationAction
  targetLaneId?: string
  targetEffectId?: string
  reason?: string
  modelId: string
  response?: string
}

export interface HumanArbitrationModel {
  readonly id: string
  decide(request: HumanArbitrationRequest, signal: AbortSignal): Promise<HumanArbitrationDecision>
}

export interface HumanArbitrationConfig {
  model?: HumanArbitrationModel
  timeoutMs?: number
}

export class HumanArbitrationCoordinator {
  private outstanding = 0
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly model: HumanArbitrationModel, private readonly timeoutMs: number) {}
  get pending(): number { return this.outstanding }
  request(request: HumanArbitrationRequest, onDecision: (decision: HumanArbitrationDecision) => void, onFailure: () => void): boolean {
    if (this.stopped) return false
    this.outstanding++
    // Preserve user-input order, without waiting for any execution Effect.
    this.tail = this.tail.then(async () => {
      if (this.stopped) return
      const controller = new AbortController()
      this.controllers.add(controller)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('HUMAN_INPUT_ABORTED')), { once: true }); timer = setTimeout(() => controller.abort(), this.timeoutMs) })
        const decision = await Promise.race([this.model.decide(structuredClone(request), controller.signal), timeout])
        if (!this.stopped && decision && typeof decision === 'object') onDecision(structuredClone(decision))
        else if (!this.stopped) onFailure()
      } catch { if (!this.stopped) onFailure() }
      finally { clearTimeout(timer); this.controllers.delete(controller) }
    }).finally(() => { this.outstanding-- })
    return true
  }
  cancel(): void { this.stopped = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear() }

}

/** Deterministic, side-effect-safe control grammar used before model arbitration. */
export function ruleHumanArbitration(value: JsonValue, agentId: string, inputId: string, modelId = 'rules'): HumanArbitrationDecision | undefined {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined
  const text = typeof value === 'string' ? value.trim() : typeof object?.text === 'string' ? object.text.trim() : undefined
  const command = typeof object?.command === 'string' ? object.command : text?.startsWith('/') ? text.slice(1).split(/\s+/, 1)[0] : undefined
  const targetLaneId = typeof object?.laneId === 'string' ? object.laneId : undefined
  const targetEffectId = typeof object?.effectId === 'string' ? object.effectId : undefined
  if (!command && text && object?.modelFirst !== true) {
    const normalizedText = text.toLowerCase().replace(/[\s，。！？!?、,.]+/g, '')
    const isContinuation = /^(继续|继续处理|接着做|往下做|恢复任务|resume|continue|goon|keepgoing)$/.test(normalizedText)
    const isStatusCheck = /^(你还活着吗|还在吗|有进展吗|进展呢|现在怎么样|areyoualive|areyoustillthere|anyupdate|status)$/.test(normalizedText)
    if (isContinuation || isStatusCheck) {
      return { schemaVersion: 1, decisionId: `rule:${inputId}`, inputId, agentId, action: 'steer', ...(targetLaneId === undefined ? {} : { targetLaneId }), reason: isContinuation ? 'Human asked the current task to continue.' : 'Human asked for the current task status.', modelId }
    }
  }
  if (!command) return undefined
  const normalized = command.toLowerCase()
  if (normalized === 'cancel' || normalized === 'stop' || normalized === 'abort') return { schemaVersion: 1, decisionId: `rule:${inputId}`, inputId, agentId, action: 'cancel', ...(targetLaneId === undefined ? {} : { targetLaneId }), ...(targetEffectId === undefined ? {} : { targetEffectId }), reason: 'Human requested cancellation.', modelId }
  if (normalized === 'steer' || normalized === 'redirect') return { schemaVersion: 1, decisionId: `rule:${inputId}`, inputId, agentId, action: 'steer', ...(targetLaneId === undefined ? {} : { targetLaneId }), reason: 'Human requested steering.', modelId }
  if (normalized === 'spawn' || normalized === 'parallel') return { schemaVersion: 1, decisionId: `rule:${inputId}`, inputId, agentId, action: 'spawn', reason: 'Human requested a concurrent interaction.', modelId }
  if (normalized === 'defer' || normalized === 'later') return { schemaVersion: 1, decisionId: `rule:${inputId}`, inputId, agentId, action: 'defer', reason: 'Human requested deferral.', modelId }
  if (normalized === 'respond' || normalized === 'reply') return { schemaVersion: 1, decisionId: `rule:${inputId}`, inputId, agentId, action: 'respond', ...(targetEffectId === undefined ? {} : { targetEffectId }), modelId }
  return undefined
}
