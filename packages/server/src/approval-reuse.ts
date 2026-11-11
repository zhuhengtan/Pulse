import { lstat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { within } from './security.js'
import { contentHash, type EffectRecord, type JsonValue, type PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { ToolManifest } from '@hunterzhu/pulse-tool-sdk'
import { workspaceStamp } from './task-controller/checkpoint.js'
import { isNecessaryVerification } from './verification-policy.js'

export async function approvalReuseIdentity(input: {
  runtime: PulseRuntime | undefined; effect: EffectRecord; mode: string | undefined; manuallyApproved: boolean
  workspace: string; name: string; args: Record<string, JsonValue>; intent: string; model: string
  reviewer: unknown; manifest: ToolManifest | undefined
}): Promise<string | undefined> {
  const { runtime, effect, manifest } = input
  if (!runtime || input.mode !== 'auto' || input.manuallyApproved || !['57', '58'].includes(String(runtime.state.lanes.get(effect.ownerLaneId)?.resume.programVersion)) || !['write', 'external'].includes(manifest?.sideEffectPolicy ?? '') || /^(?:image|video|audio)\.|^shell\.(?:start|cancel)$/.test(input.name)) return undefined
  if (manifest?.sideEffectPolicy === 'external' && input.name !== 'shell.exec') return undefined
  if (input.name === 'shell.exec' && !await isNecessaryVerification(input.workspace, input.args, input.intent)) return undefined
  // An unknown workspace or dependency set cannot establish an unchanged authority.
  const stamp = await workspaceStamp(input.workspace)
  if (!stamp.available || !stamp.digest) return undefined
  // Git's inventory omits ignored targets. Their unknown versions cannot reuse authority.
  for (const key of ['path', 'source', 'destination', 'target']) {
    if (typeof input.args[key] !== 'string') continue
    try {
      const target = await within(input.workspace, input.args[key]), path = relative(resolve(input.workspace), resolve(input.workspace, input.args[key])).split(sep).join('/')
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink() || stamp.files[path] === undefined) return undefined
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') return undefined }
  }
  const agent = runtime.state.agents.get(effect.agentId)
  const global = agent?.globalVersions.get(agent.latestGlobalVersion) as Record<string, any> | undefined
  return contentHash({ agentId: effect.agentId, workspace: input.workspace, stamp: stamp.digest, name: input.name, args: input.args, intent: input.intent, model: input.model, reviewer: input.reviewer ?? null, manifest, contract: global?.taskRecord?.acceptanceCriteria ?? [], updates: global?.taskController?.updates ?? [] })
}

export function hasApprovalGrant(runtime: PulseRuntime | undefined, fingerprint: string | undefined): boolean {
  return !!fingerprint && !!runtime && runtime.state.events.some(event => {
    const data = event.data as Record<string, JsonValue> | undefined
    return event.type === 'effect.execution_metadata' && data?.approvalFingerprint === fingerprint && data.approvalGranted === true
  })
}
