import { randomUUID } from 'node:crypto'
import { deviceCommandSourceSchema, type DeviceCommand, type DeviceCommandAudit, type DeviceCommandSource, type DeviceGrant } from './types.js'
import type { DeviceLedger } from './store.js'

export const MAX_DEVICE_COMMANDS = 10_000
export const MAX_DEVICE_PERMISSION_EVENTS = 10_000
export function auditCapacity(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fallback) throw new Error('DEVICE_AUDIT_CAPACITY_INVALID')
  return limit
}
/** Correlation identifiers are diagnostic data, never evidence of user identity or approval. */
export function commandAudit(brokerId: string, at: number, grant: DeviceGrant | undefined, source?: DeviceCommandSource, hostIdentity?: { instanceId: string; epoch: number }): DeviceCommandAudit {
  const origin = deviceCommandSourceSchema.parse(source ?? { entryPoint: 'broker-api' })
  return { version: 1, origin: { brokerId, ...origin, ...(hostIdentity ? { hostInstanceId: hostIdentity.instanceId, epoch: hostIdentity.epoch } : {}) },
    acceptance: { at, authorizationChecked: false, grant: grant ? structuredClone(grant) : null } }
}
/** Revocation is never blocked by audit capacity. Once full, grants fail closed;
 * only the finite set of already-existing grants can still add revoke events. */
export function appendPermissionEvent(ledger: DeviceLedger, action: 'grant' | 'revoke', grant: DeviceGrant, at: number, maxEvents = MAX_DEVICE_PERMISSION_EVENTS): void {
  const events = ledger.permissionEvents ??= []
  if (action === 'grant' && events.length >= auditCapacity(maxEvents, MAX_DEVICE_PERMISSION_EVENTS)) throw new Error('DEVICE_PERMISSION_AUDIT_CAPACITY')
  events.push({ eventId: randomUUID(), at, action, source: 'host-registry', grant: structuredClone(grant) })
}
export function revokeDeviceGrants(ledger: DeviceLedger, predicate: (grant: DeviceGrant) => boolean, at: number): void {
  const revoked = ledger.grants.filter(predicate)
  for (const grant of revoked) appendPermissionEvent(ledger, 'revoke', grant, at)
  const removed = new Set(revoked)
  ledger.grants = ledger.grants.filter(grant => !removed.has(grant))
}
/** All unresolved receipts survive the recent-history window. No ledger evidence is pruned. */
export function projectCommandHistory(commands: DeviceCommand[], recentLimit = 30) {
  const unresolved = (command: DeviceCommand) => ['accepted', 'sent', 'unknown'].includes(command.status)
  const pending = commands.filter(unresolved), recent = commands.filter(command => !unresolved(command)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, recentLimit)
  return { commands: [...pending.sort((a, b) => b.updatedAt - a.updatedAt), ...recent], unresolvedCount: pending.length, blockingCount: pending.filter(command => !hasManualIsolationRelease(command)).length, manuallyReleasedCount: pending.filter(hasManualIsolationRelease).length, totalCount: commands.length, terminalHistoryTruncated: commands.length > pending.length + recent.length }
}

/** Administrative release is not an execution result and cannot change receipt status. */
export function hasManualIsolationRelease(command: DeviceCommand): boolean {
  const disposition = command.manualDisposition, device = command.audit?.dispatch?.device
  return command.status === 'unknown' && Boolean(disposition && device && disposition.commandFingerprint === command.fingerprint && disposition.device.deviceId === command.request.deviceId && disposition.device.deviceId === device.deviceId && disposition.device.adapter === device.adapter && disposition.device.homeId === device.homeId)
}
