export type LockMode = 'shared' | 'exclusive'
interface Request { id: string; mode: LockMode; seq: number; aheadSharedIds?: string[]; resolve: (release: () => void) => void; reject: (error: Error) => void }

export class ResourceLockManager {
  private readonly holders = new Map<string, Map<string, LockMode>>()
  private readonly queues = new Map<string, Request[]>()
  private seq = 0

  constructor(readonly writerPreferenceBound = Number.POSITIVE_INFINITY) {
    if (writerPreferenceBound !== Number.POSITIVE_INFINITY && (!Number.isInteger(writerPreferenceBound) || writerPreferenceBound < 0)) throw new Error('INVALID_WRITER_PREFERENCE_BOUND')
  }

  acquire(resource: string, mode: LockMode, requestId = `lock-${++this.seq}`): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(resource) ?? []
      const request = { id: requestId, mode, seq: ++this.seq, ...(mode === 'exclusive' ? { aheadSharedIds: queue.filter((queued) => queued.mode === 'shared').map((queued) => queued.id) } : {}), resolve, reject }
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

  wait(resource: string, mode: LockMode, requestId: string, onGrant: (release: () => void) => void): void {
    const holders = this.holders.get(resource) ?? new Map<string, LockMode>()
    if (holders.has(requestId)) { onGrant(() => this.release(resource, requestId)); return }
    const queue = this.queues.get(resource) ?? []
    if (queue.some((request) => request.id === requestId)) return
    const request: Request = { id: requestId, mode, seq: ++this.seq, ...(mode === 'exclusive' ? { aheadSharedIds: queue.filter((queued) => queued.mode === 'shared').map((queued) => queued.id) } : {}), resolve: onGrant, reject: () => undefined }
    queue.push(request)
    this.queues.set(resource, queue)
    this.drain(resource)
  }

  cancelWait(resource: string, requestId: string): void {
    const queue = this.queues.get(resource)
    if (!queue) return
    const index = queue.findIndex((request) => request.id === requestId)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(resource)
  }

  restoreHeld(resource: string, mode: LockMode, requestId: string): () => void {
    if (!requestId || this.holders.get(resource)?.has(requestId)) throw new Error('INVALID_LOCK_RESTORE')
    const holders = this.holders.get(resource) ?? new Map<string, LockMode>()
    if (mode === 'exclusive' && holders.size > 0) throw new Error('RESOURCE_RESTORE_CONFLICT')
    if (mode === 'shared' && [...holders.values()].some((heldMode) => heldMode === 'exclusive')) throw new Error('RESOURCE_RESTORE_CONFLICT')
    if ((this.queues.get(resource)?.length ?? 0) > 0) throw new Error('RESOURCE_RESTORE_CONFLICT')
    holders.set(requestId, mode)
    this.holders.set(resource, holders)
    return () => this.release(resource, requestId)
  }

  private canGrant(resource: string, request: Request): boolean {
    const holders = this.holders.get(resource) ?? new Map()
    if (request.mode === 'shared' && [...holders.values()].some((mode) => mode === 'exclusive')) return false
    if (request.mode === 'exclusive' && holders.size) return false
    const queue = this.queues.get(resource) ?? []
    const index = queue.findIndex((queued) => queued.id === request.id)
    if (index < 0) return false
    if (request.mode === 'exclusive') return !queue.slice(0, index).some((queued) => queued.mode === 'exclusive')
    const firstWriter = queue.find((queued) => queued.mode === 'exclusive')
    if (firstWriter === undefined) return true
    const sharedOrdinal = firstWriter.aheadSharedIds?.indexOf(request.id) ?? -1
    return sharedOrdinal >= 0 && sharedOrdinal < this.writerPreferenceBound
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
