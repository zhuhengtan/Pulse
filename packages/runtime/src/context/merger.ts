import { hasUnsafePathSegment, ownChild, rebaseContextDelta, stableSerialize, type RebaseConflict } from './builder.js'
import { apply } from '../core/mutations.js'
import type { Mutation } from '../core/mutations.js'
import { privacyTaintPrivacy, strictestPrivacy } from '../core/types.js'
import type { AgentRecord, ContextDelta, JsonValue, MergeProposal, PrivacyMetadata, RuntimeState } from '../core/types.js'

export interface MergeConflict {
  proposalId: string
  sourceLaneId: string
  baseGlobalVersion: number
  conflicts: RebaseConflict[]
}

export interface MergePlan {
  agentId: string
  version?: number
  value?: JsonValue
  appliedProposalIds: string[]
  conflicts: MergeConflict[]
  mutations: Mutation[]
}

function clone<T>(value: T): T { return structuredClone(value) }

function setPath(root: JsonValue, path: string[], value: JsonValue): void {
  let cursor = root as Record<string, JsonValue>
  for (const part of path.slice(0, -1)) {
    const child = ownChild(cursor, part)
    if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[part] = {}
    cursor = cursor[part] as Record<string, JsonValue>
  }
  cursor[path[path.length - 1]!] = clone(value)
}

function removePath(root: JsonValue, path: string[]): void {
  let cursor: JsonValue = root
  for (const part of path.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return
    const next = ownChild(cursor as Record<string, JsonValue>, part)
    if (next === undefined) return
    cursor = next
  }
  if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) delete (cursor as Record<string, JsonValue>)[path[path.length - 1]!]
}

function applyDelta(root: JsonValue, delta: ContextDelta): JsonValue {
  const result = clone(root)
  for (const op of delta.ops) {
    if (op.op === 'compact_history') throw new Error('GLOBAL_HISTORY_COMPACTION_NOT_ALLOWED')
    const path = op.path ?? []
    if (path.length === 0 || hasUnsafePathSegment(path)) throw new Error('INVALID_CONTEXT_PATH')
    if (op.op === 'set') setPath(result, path, op.value ?? null)
    else if (op.op === 'remove') removePath(result, path)
    else {
      let cursor: JsonValue = result
      for (const part of path) {
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('APPEND_TARGET_NOT_ARRAY')
        const next = ownChild(cursor as Record<string, JsonValue>, part)
        if (next === undefined) throw new Error('APPEND_TARGET_NOT_ARRAY')
        cursor = next
      }
      if (!Array.isArray(cursor)) throw new Error('APPEND_TARGET_NOT_ARRAY')
      cursor.push(clone(op.value ?? null))
    }
  }
  return result
}

function proposalOrder(proposals: Iterable<MergeProposal>): MergeProposal[] {
  return [...proposals].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export class ContextMerger {
  constructor(private readonly state: RuntimeState) {}

  plan(agentId: string, proposalIds?: string[]): MergePlan {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    const wanted = proposalIds === undefined ? undefined : new Set(proposalIds)
    const proposals = proposalOrder([...this.state.mergeProposals.values()].filter((proposal) => proposal.agentId === agentId && (wanted === undefined || wanted.has(proposal.id))))
    let version = agent.latestGlobalVersion
    let value: JsonValue = clone(agent.globalVersions.get(version) ?? {})
    let metadata: PrivacyMetadata = clone(agent.globalPrivacy?.get(version) ?? { privacy: 'public' })
    const appliedProposalIds: string[] = []
    const conflicts: MergeConflict[] = []
    const mutations: Mutation[] = []
    const versionMutations: Mutation[] = []
    for (const proposal of proposals) {
      const base = agent.globalVersions.get(proposal.baseGlobalVersion)
      if (base === undefined) {
        conflicts.push({ proposalId: proposal.id, sourceLaneId: proposal.sourceLaneId, baseGlobalVersion: proposal.baseGlobalVersion, conflicts: [{ path: [], reason: 'changed_since_base' }] })
        continue
      }
      const rebased = rebaseContextDelta(proposal.delta, base, value, version)
      if (!rebased.delta || rebased.conflicts.length) {
        conflicts.push({ proposalId: proposal.id, sourceLaneId: proposal.sourceLaneId, baseGlobalVersion: proposal.baseGlobalVersion, conflicts: rebased.conflicts })
        continue
      }
      try {
        const next = applyDelta(value, rebased.delta)
        const nextMetadata: PrivacyMetadata = {
          privacy: strictestPrivacy([metadata.privacy, proposal.delta.privacy ?? 'public', privacyTaintPrivacy(proposal.delta.privacyTaints)]),
          ...(metadata.privacyTaints?.length || proposal.delta.privacyTaints?.length ? { privacyTaints: [...(metadata.privacyTaints ?? []), ...(proposal.delta.privacyTaints ?? [])] } : {}),
        }
        if (stableSerialize(next) !== stableSerialize(value) || stableSerialize(nextMetadata) !== stableSerialize(metadata)) {
          value = next
          version++
          // Every version number that is handed out must exist in `globalVersions`;
          // otherwise `adopt_context(version)` for an intermediate version fails.
          versionMutations.push({ op: 'setGlobal', agentId, version, value: clone(value), metadata: clone(nextMetadata) })
        }
        metadata = nextMetadata
        appliedProposalIds.push(proposal.id)
        mutations.push({ op: 'removeMergeProposal', proposalId: proposal.id })
      } catch (cause) {
        conflicts.push({ proposalId: proposal.id, sourceLaneId: proposal.sourceLaneId, baseGlobalVersion: proposal.baseGlobalVersion, conflicts: [{ path: [], reason: 'changed_since_base' }] })
      }
    }
    if (appliedProposalIds.length) {
      mutations.unshift(...versionMutations)
      mutations.push({ op: 'appendEvent', event: { type: 'context.merge_committed', agentId, data: { version, proposalIds: appliedProposalIds } as unknown as JsonValue } })
    }
    return { agentId, ...(appliedProposalIds.length ? { version, value: clone(value) } : {}), appliedProposalIds, conflicts, mutations }
  }

  commit(agentId: string, proposalIds?: string[]): MergePlan {
    const plan = this.plan(agentId, proposalIds)
    if (plan.conflicts.length) return plan
    if (plan.mutations.length) apply(this.state, plan.mutations)
    return plan
  }
}

export function mergeProposals(state: RuntimeState, agentId: string, proposalIds?: string[]): MergePlan { return new ContextMerger(state).commit(agentId, proposalIds) }

export type { AgentRecord }
