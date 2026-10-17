import { realpath } from 'node:fs/promises'
import { win32 } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { SandboxManager, expandWindowsFsPaths, getWindowsSandboxUserStatusAsync, resolveSrtWin, stampWindowsAcl, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

const windowsAclBatchSize = 8
interface DenyBatch { denyRead: string[]; denyWrite: string[] }

async function windowsDenyBatches(policy: SandboxRuntimeConfig): Promise<DenyBatch[] | undefined> {
  const fs = policy.filesystem
  // Credential-derived file denies belong to the SDK's own convergence pass.
  if (!fs || fs.disabled || policy.credentials) return undefined
  const reads = expandWindowsFsPaths(fs.denyRead ?? [], { mode: 'deny' })
  const writes = expandWindowsFsPaths(fs.denyWrite ?? [], { mode: 'deny' })
  if (reads.length + writes.length <= windowsAclBatchSize) return undefined
  // Resolve aliases before merging masks: a later write-only deny must never
  // downgrade a read deny on the same physical object. Let the SDK handle
  // missing paths and its placeholder lifecycle without changing semantics.
  const physical = await Promise.all([...reads, ...writes].map(path => realpath(path).catch(() => undefined)))
  if (physical.some(path => path === undefined)) return undefined
  const targets = new Map<string, { path: string; read: boolean }>()
  physical.forEach((path, index) => {
    const key = win32.normalize(path!).toLowerCase()
    if (!targets.has(key)) targets.set(key, { path: path!, read: index < reads.length })
  })
  const batches: DenyBatch[] = []
  const entries = [...targets.values()]
  for (let offset = 0; offset < entries.length; offset += windowsAclBatchSize) {
    const batch: DenyBatch = { denyRead: [], denyWrite: [] }
    for (const target of entries.slice(offset, offset + windowsAclBatchSize)) (target.read ? batch.denyRead : batch.denyWrite).push(target.path)
    batches.push(batch)
  }
  return batches.length > 1 ? batches : undefined
}

export async function initializeShellSandbox(policy: SandboxRuntimeConfig, platform: NodeJS.Platform = process.platform, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const batches = platform === 'win32' ? await windowsDenyBatches(policy) : undefined
  signal?.throwIfAborted()
  const initial = batches ? { ...policy, filesystem: { ...policy.filesystem, ...batches[0]! } } : policy
  try {
    await SandboxManager.initialize(initial, undefined, false)
  } catch (error) {
    // Retry only the cold WFP readiness probe, before any command is run.
    if (platform !== 'win32' || !error || typeof error !== 'object'
      || !('code' in error) || error.code !== 'srt_win_timeout'
      || !('subcommand' in error) || error.subcommand !== 'wfp') throw error
    await SandboxManager.reset()
    await SandboxManager.initialize(initial, undefined, false)
  }
  signal?.throwIfAborted()
  if (!batches) return
  const srtWin = resolveSrtWin(policy.windows?.srtWin)
  const status = await getWindowsSandboxUserStatusAsync({ srtWin })
  if (!status.provisioned || !status.sid) throw new Error('Windows sandbox not provisioned')
  for (const batch of batches.slice(1)) {
    signal?.throwIfAborted()
    stampWindowsAcl({ ...batch, sandboxUserSid: status.sid, holderPid: process.pid, srtWin })
    await setImmediate()
  }
  signal?.throwIfAborted()
  // Additional batches use the SAME holder PID. The SDK's reset() releases all
  // ledger holds for that PID, including partial batches after failure. The
  // first batch ensures its cleanup bookkeeping is active even without grants.
  // Publish the full declared policy only once every native deny has landed;
  // the SDK's cached deny list is only a per-exec deduplication optimization.
  SandboxManager.updateConfig(policy)
}
