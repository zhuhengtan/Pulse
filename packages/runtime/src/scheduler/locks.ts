export type LockMode = 'shared' | 'exclusive'
interface Request { id: string; mode: LockMode; seq: number; resolve: (release: () => void) => void; reject: (error: Error) => void }

export class ResourceLockManager {
  private readonly holders = new Map<string, Map<string, LockMode>>()
  private readonly queues = new Map<string, Request[]>()
  private seq = 0

  acquire(resource: string, mode: LockMode, requestId = `lock-${++this.seq}`): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const request = { id: requestId, mode, seq: this.seq, resolve, reject }
      const queue = this.queues.get(resource) ?? []
      queue.push(request)
      this.queues.set(resource, queue)
      this.drain(resource)
    })
  }

  tryAcquire(resource: string, mode: LockMode, requestId = `lock-${++this.seq}`): (() => void) | undefined {
    const holders = this.holders.get(resource) ?? new Map<string, LockMode>()
    const queue = this.queues.get(resource) ?? []
    if (queue.length > 0) return undefined
    if (mode === 'exclusive' && holders.size > 0) return undefined
    if (mode === 'shared' && [...holders.values()].some((heldMode) => heldMode === 'exclusive')) return undefined
    holders.set(requestId, mode)
    this.holders.set(resource, holders)
    return () => this.release(resource, requestId)
  }

  private canGrant(resource: string, request: Request): boolean {
    const holders = this.holders.get(resource) ?? new Map()
    if (request.mode === 'shared' && [...holders.values()].some((mode) => mode === 'exclusive')) return false
    if (request.mode === 'exclusive' && holders.size) return false
    const queue = this.queues.get(resource) ?? []
    if (request.mode === 'shared' && queue.some((queued) => queued.seq < request.seq && queued.mode === 'exclusive')) return false
    return queue[0]?.id === request.id || request.mode === 'shared' && !queue.slice(0, queue.findIndex((queued) => queued.id === request.id)).some((queued) => queued.mode === 'exclusive')
  }

  private drain(resource: string): void {
    const queue = this.queues.get(resource) ?? []
    for (const request of [...queue]) {
      if (!this.canGrant(resource, request)) continue
      const holders = this.holders.get(resource) ?? new Map<string, LockMode>()
      holders.set(request.id, request.mode)
      this.holders.set(resource, holders)
      queue.splice(queue.findIndex((item) => item.id === request.id), 1)
      request.resolve(() => this.release(resource, request.id))
      if (request.mode === 'exclusive') break
    }
  }

  release(resource: string, requestId: string): void { this.holders.get(resource)?.delete(requestId); this.drain(resource) }
  isHeld(resource: string, mode?: LockMode): boolean { const values = [...(this.holders.get(resource)?.values() ?? [])]; return mode ? values.includes(mode) : values.length > 0 }
  queued(resource: string): number { return this.queues.get(resource)?.length ?? 0 }
}
