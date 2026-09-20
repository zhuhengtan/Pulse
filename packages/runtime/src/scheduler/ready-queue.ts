import type { LaneRecord } from '../core/types.js'

export interface ReadyItem { laneId: string; basePriority: number; readySince: number; enqueueSeq: number; inheritedFloor?: number }

export class ReadyQueue {
  private readonly items = new Map<string, ReadyItem>()
  constructor(private readonly agingIntervalMs = 1000, private readonly agingCap = Number.POSITIVE_INFINITY) {}
  enqueue(item: ReadyItem): void { this.items.set(item.laneId, item) }
  remove(laneId: string): void { this.items.delete(laneId) }
  get size(): number { return this.items.size }
  has(laneId: string): boolean { return this.items.has(laneId) }
  score(item: ReadyItem, now: number): number {
    const aging = Math.min(this.agingCap, Math.floor(Math.max(0, now - item.readySince) / this.agingIntervalMs))
    return Math.max(item.basePriority + aging, item.inheritedFloor ?? Number.NEGATIVE_INFINITY)
  }
  dequeue(now: number): string | undefined {
    const best = [...this.items.values()].sort((a, b) => this.score(b, now) - this.score(a, now) || a.enqueueSeq - b.enqueueSeq)[0]
    if (!best) return undefined
    this.items.delete(best.laneId)
    return best.laneId
  }
  snapshot(now: number): Array<ReadyItem & { effectivePriority: number }> { return [...this.items.values()].map((item) => ({ ...item, effectivePriority: this.score(item, now) })).sort((a, b) => b.effectivePriority - a.effectivePriority || a.enqueueSeq - b.enqueueSeq) }
}

export class PriorityInheritance {
  private readonly floors = new Map<string, Map<string, number>>()
  clear(): void { this.floors.clear() }
  raise(targetLaneId: string, consumerId: string, score: number): void { if (!this.floors.has(targetLaneId)) this.floors.set(targetLaneId, new Map()); this.floors.get(targetLaneId)!.set(consumerId, score) }
  release(targetLaneId: string, consumerId: string): void { this.floors.get(targetLaneId)?.delete(consumerId) }
  floor(targetLaneId: string): number | undefined { const values = [...(this.floors.get(targetLaneId)?.values() ?? [])]; return values.length ? Math.max(...values) : undefined }
}

export function readyItemFromLane(lane: LaneRecord, inheritedFloor = lane.inheritedFloor): ReadyItem { return { laneId: lane.id, basePriority: lane.priority, readySince: lane.readySince, enqueueSeq: lane.enqueueSeq, ...(inheritedFloor === undefined ? {} : { inheritedFloor }) } }
