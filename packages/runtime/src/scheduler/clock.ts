import { performance } from 'node:perf_hooks'

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

export interface RuntimeClock {
  readonly timers: TimerWheel
  now(): number
  set(now: number): void
  advance(ms: number): void
  schedule(delayMs: number, callback: () => void): string
  waitUntil?(at: number): Promise<void>
}

export class VirtualClock implements RuntimeClock {
  readonly timers = new TimerWheel()
  private current = 0
  now(): number { return this.current }
  set(now: number): void { if (now < this.current) throw new Error('VirtualClock cannot move backwards'); this.current = now; this.flush() }
  advance(ms: number): void { if (ms < 0) throw new Error('VirtualClock cannot move backwards'); this.current += ms; this.flush() }
  schedule(delayMs: number, callback: () => void): string { return this.timers.schedule(this.current + delayMs, callback) }
  private flush(): void { for (const entry of this.timers.due(this.current)) entry.callback() }
}

/** Monotonic host clock for production runtimes; timers never fast-forward. */
export class MonotonicClock implements RuntimeClock {
  readonly timers = new TimerWheel()
  private readonly startedAt = performance.now()
  private readonly epoch: number
  private current: number

  constructor(startAt = Date.now()) {
    if (!Number.isFinite(startAt)) throw new Error('INVALID_CLOCK_START')
    this.epoch = startAt
    this.current = startAt
  }

  now(): number {
    this.current = Math.max(this.current, this.epoch + performance.now() - this.startedAt)
    this.flush()
    return this.current
  }

  set(now: number): void {
    if (!Number.isFinite(now) || now < this.current) return
    this.current = now
    this.flush()
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('MonotonicClock cannot move backwards')
    this.set(this.now() + ms)
  }

  schedule(delayMs: number, callback: () => void): string {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('INVALID_TIMER_DELAY')
    return this.timers.schedule(this.now() + delayMs, callback)
  }

  async waitUntil(at: number): Promise<void> {
    if (!Number.isFinite(at)) throw new Error('INVALID_TIMER_DEADLINE')
    while (this.now() < at) {
      const remaining = at - this.current
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, remaining)))
    }
    this.now()
  }

  private flush(): void { for (const entry of this.timers.due(this.current)) entry.callback() }
}
