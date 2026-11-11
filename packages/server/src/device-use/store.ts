import { mkdir, open, readFile, rename, lstat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { deviceCommandSchema, deviceRecordSchema, commandRequestSchema, deviceGrantSchema, devicePermissionEventSchema, type DevicePermissionEvent, type DeviceCommand, type DeviceGrant, type DeviceRecord, type DeviceCommandRequest } from './types.js'

export interface DeviceScene { sceneId: string; steps: Omit<DeviceCommandRequest, 'requestId' | 'deadline'>[] }
export interface DeviceLedger { version: 1; devices: DeviceRecord[]; enrolled: string[]; grants: DeviceGrant[]; commands: DeviceCommand[]; scenes: DeviceScene[]; permissionEvents?: DevicePermissionEvent[] }
const ledgerSchema = z.object({ version: z.literal(1), devices: z.array(deviceRecordSchema), enrolled: z.array(z.string()), grants: z.array(deviceGrantSchema), commands: z.array(deviceCommandSchema), permissionEvents: z.array(devicePermissionEventSchema).optional(), scenes: z.array(z.object({ sceneId: z.string(), steps: z.array(commandRequestSchema.omit({ requestId: true, deadline: true })) })) })
const tails = new Map<string, Promise<unknown>>()
const ownerToken = randomUUID()
const ownedPaths = new Set<string>()
/** Reject a second OS process: the Broker device mutex belongs to one shared Host. */
async function claimOwner(path: string): Promise<void> {
  if (ownedPaths.has(path)) return
  const ownerPath = `${path}.owner`
  const create = async () => {
    const file = await open(ownerPath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token: ownerToken })); await file.sync() } finally { await file.close() }
    ownedPaths.add(path)
  }
  try { await create(); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  // Recovery is itself exclusive; never steal a living process's ownership.
  let recovery
  try { recovery = await open(`${ownerPath}.recovery`, 'wx', 0o600) } catch { throw new Error('DEVICE_STORE_IN_USE') }
  try {
    if ((await lstat(ownerPath)).isSymbolicLink()) throw new Error('DEVICE_STORE_SYMLINK')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid?: unknown; token?: unknown }
    if (owner.pid === process.pid && owner.token === ownerToken) { ownedPaths.add(path); return }
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) throw new Error('DEVICE_STORE_OWNER_INVALID')
    try { process.kill(owner.pid as number, 0); throw new Error('DEVICE_STORE_IN_USE') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('DEVICE_STORE_IN_USE') }
    await unlink(ownerPath); await create()
  } finally { await recovery.close(); await unlink(`${ownerPath}.recovery`).catch(() => {}) }
}

/** One shared host owns the ledger. All Broker instances in that host serialize through this path. */
export class DeviceStore {
  readonly path: string
  constructor(path: string) { this.path = resolve(path) }
  async transaction<T>(change: (ledger: DeviceLedger) => T, write = true): Promise<T> {
    const previous = tails.get(this.path) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      for (const path of [dirname(this.path), this.path]) {
        try { if ((await lstat(path)).isSymbolicLink()) throw new Error('DEVICE_STORE_SYMLINK') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
      await claimOwner(this.path)
      let ledger: DeviceLedger
      try { ledger = ledgerSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) as DeviceLedger }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; ledger = { version: 1, devices: [], enrolled: [], grants: [], commands: [], scenes: [] } }
      const result = change(ledger)
      if (write) {
        ledgerSchema.parse(ledger)
        const temporary = `${this.path}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, 'wx', 0o600)
          try { await file.writeFile(JSON.stringify(ledger)); await file.sync() } finally { await file.close() }
          await rename(temporary, this.path)
          const directory = await open(dirname(this.path), 'r'); try { await directory.sync() } finally { await directory.close() }
        } finally { await unlink(temporary).catch(() => {}) }
      }
      return structuredClone(result)
    })
    tails.set(this.path, operation)
    try { return await operation } finally { if (tails.get(this.path) === operation) tails.delete(this.path) }
  }
}
