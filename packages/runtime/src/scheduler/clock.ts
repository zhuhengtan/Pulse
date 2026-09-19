export interface TimerEntry { id: string; at: number; callback: () => void; cancelled: boolean }

export class TimerWheel {
  private readonly entries = new Map<string, TimerEntry>()
  private seq = 0
  schedule(at: number, callback: () => void): string { const id = `timer-${++this.seq}`; this.entries.set(id, { id, at, callback, cancelled: false }); return id }
  cancel(id: string): void { const entry = this.entries.get(id); if (entry) entry.cancelled = true }
  due(now: number): TimerEntry[] {
    const due = [...this.entries.values()].filter((entry) => !entry.cancelled && entry.at <= now).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    for (const entry of due) this.entries.delete(entry.id)
    return due
  }
  nextAt(): number | undefined { return [...this.entries.values()].filter((entry) => !entry.cancelled).sort((a, b) => a.at - b.at)[0]?.at }
  get size(): number { return [...this.entries.values()].filter((entry) => !entry.cancelled).length }
}

export class VirtualClock {
  readonly timers = new TimerWheel()
  private current = 0
  now(): number { return this.current }
  set(now: number): void { if (now < this.current) throw new Error('VirtualClock cannot move backwards'); this.current = now; this.flush() }
  advance(ms: number): void { if (ms < 0) throw new Error('VirtualClock cannot move backwards'); this.current += ms; this.flush() }
  schedule(delayMs: number, callback: () => void): string { return this.timers.schedule(this.current + delayMs, callback) }
  private flush(): void { for (const entry of this.timers.due(this.current)) entry.callback() }
}
