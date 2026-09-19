import type { PulseRuntime } from '../scheduler/runtime.js'
import type { JsonValue, RuntimeEvent } from '../core/types.js'

export interface SessionEvent { type: 'fact' | 'gap' | 'snapshot'; seq: number; event?: RuntimeEvent; fromSeq?: number; toSeq?: number; snapshot?: JsonValue }

export class PulseSession {
  private readonly execution: Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }>
  constructor(private readonly runtime: PulseRuntime, readonly agentId: string) { this.execution = runtime.run() }
  async *stream(): AsyncIterable<SessionEvent> {
    let cursor = 0
    while (true) {
      const events = this.runtime.state.events.filter((event) => event.seq > cursor)
      for (const event of events) { cursor = event.seq; yield { type: 'fact', seq: event.seq, event } }
      const root = [...this.runtime.state.lanes.values()].find((lane) => lane.agentId === this.agentId && lane.ownerLaneId === undefined)
      if (root && ['succeeded', 'failed', 'cancelled'].includes(root.status) && this.runtime.state.events.at(-1)?.seq === cursor) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  snapshot(): JsonValue { return { agentId: this.agentId, lanes: [...this.runtime.state.lanes.values()].filter((lane) => lane.agentId === this.agentId).map((lane) => ({ id: lane.id, status: lane.status, step: lane.resume.step })), effects: [...this.runtime.state.effects.values()].filter((effect) => effect.agentId === this.agentId).map((effect) => ({ id: effect.id, state: effect.state })) } }
  async outcome(): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> { return this.execution }
  reply(effectId: string, value: JsonValue): void { this.runtime.completeEffect(effectId, { value }) }
}
