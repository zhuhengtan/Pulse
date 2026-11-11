import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { vi } from 'vitest'
import { DeviceStore, deviceLedgerSchema, type DeviceLedger } from '../../packages/server/src/device-use/store.js'

type MemoryLedger = { json?: string; tail: Promise<unknown> }
/** Broker/adapter tests use volatile state where private disk storage is unsupported.
 * This is deliberately test-only: it cannot enable a production Windows Host.
 * The optional test environment switch exercises the same branch on POSIX.
 */
export class TestDeviceStore extends DeviceStore {
  constructor(path: string, readonly persistent = process.platform !== 'win32' && process.env.PULSE_TEST_DEVICE_STORE !== 'memory', private readonly memory: MemoryLedger = { tail: Promise.resolve() }) { super(path) }
  reopen(): TestDeviceStore { return new TestDeviceStore(this.path, this.persistent, this.memory) }
  readText(): Promise<string> { return this.persistent ? readFile(this.path, 'utf8') : Promise.resolve(this.memory.json ?? '') }
  async writeText(json: string): Promise<void> { if (this.persistent) await writeFile(this.path, json); else this.memory.json = json }
  override async transaction<T>(change: (ledger: DeviceLedger) => T, write = true): Promise<T> {
    if (this.persistent) return super.transaction(change, write)
    const operation = this.memory.tail.catch(() => {}).then(() => {
      const ledger = deviceLedgerSchema.parse(this.memory.json === undefined ? { version: 1, devices: [], enrolled: [], grants: [], commands: [], scenes: [] } : JSON.parse(this.memory.json)) as DeviceLedger
      const result = change(ledger)
      if (write) { deviceLedgerSchema.parse(ledger); this.memory.json = JSON.stringify(ledger) }
      return structuredClone(result)
    })
    this.memory.tail = operation
    return operation
  }
}

/** Scope the virtual-scene tests' substitution to their owned temporary ledger.
 * Other stores, particularly the real Host, keep the production refusal.
 */
export function mockSceneSandboxStorage(): () => void {
  if (process.platform !== 'win32' && process.env.PULSE_TEST_DEVICE_STORE !== 'memory') return () => {}
  const stores = new Map<string, TestDeviceStore>(), original = DeviceStore.prototype.transaction
  const spy = vi.spyOn(DeviceStore.prototype, 'transaction').mockImplementation(function<T>(this: DeviceStore, change: (ledger: DeviceLedger) => T, write = true): Promise<T> {
    if (basename(this.path) !== 'ledger.json' || !basename(dirname(this.path)).startsWith('pulse-scene-sandbox-')) return original.call(this, change, write) as Promise<T>
    let store = stores.get(this.path)
    if (!store) { store = new TestDeviceStore(this.path, false); stores.set(this.path, store) }
    return store.transaction(change, write)
  })
  return () => { spy.mockRestore(); stores.clear() }
}
