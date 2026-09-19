export class CancellationScope {
  readonly children = new Set<CancellationScope>()
  cancelled = false
  reason?: string
  constructor(readonly ownerId: string, readonly parent?: CancellationScope) { parent?.children.add(this) }
  cancel(reason = 'USER_REQUESTED'): void { if (this.cancelled) return; this.cancelled = true; this.reason = reason; for (const child of this.children) child.cancel(reason) }
  canCancel(target: CancellationScope): boolean { let current: CancellationScope | undefined = target; while (current) { if (current === this) return true; current = current.parent } return false }
  dispose(): void { this.parent?.children.delete(this); for (const child of this.children) child.dispose(); this.children.clear() }
}

export interface QuarantineEntry { effectId: string; unresolvedAt: number; reason: string }
export class QuarantineScope {
  private readonly entries = new Map<string, QuarantineEntry>()
  add(effectId: string, unresolvedAt: number, reason = 'cancel_grace_elapsed'): void { this.entries.set(effectId, { effectId, unresolvedAt, reason }) }
  reconcile(effectId: string): boolean { return this.entries.delete(effectId) }
  has(effectId: string): boolean { return this.entries.has(effectId) }
  get unresolvedEffectIds(): string[] { return [...this.entries.keys()] }
  run<T>(work: () => T): { value: T; unresolvedEffectIds: string[] } { return { value: work(), unresolvedEffectIds: this.unresolvedEffectIds } }
}

export class HostCommandQueue {
  private draining = false
  private readonly pending: Array<() => void> = []
  enqueue(command: () => void): void { if (this.draining) this.pending.push(command); else command() }
  beginDrain(): void { this.draining = true }
  finishDrain(): void {
    this.draining = false
    const commands = this.pending.splice(0)
    for (const command of commands) command()
  }
  get size(): number { return this.pending.length }
}
