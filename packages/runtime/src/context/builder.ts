import { createHash } from 'node:crypto'
import type { AgentRecord, LaneRecord, LLMContextSpec, LLMRequestProjection, PrivacyLabel, ResultRef, RuntimeState, JsonValue, ContextDelta, ContextOp } from '../core/types.js'
import { privacyRank, strictestPrivacy } from '../core/types.js'

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex') }

export interface ContextBuildInput {
  agent: AgentRecord
  lane: LaneRecord
  resultRefs?: ResultRef[]
  eventIds?: string[]
  instruction: string
  system?: string
  policy?: JsonValue
  tools?: JsonValue
  toolSetId: string
}

export class ContextBuilder {
  readonly version = '1'
  constructor(private readonly state: RuntimeState) {}
  build(input: ContextBuildInput): LLMRequestProjection {
    if (input.instruction.length > 2048) throw new Error('INSTRUCTION_TOO_LARGE')
    const global = input.agent.globalVersions.get(input.lane.contextSnapshotVersion)
    if (global === undefined) throw new Error('UNKNOWN_CONTEXT_VERSION')
    const resultRefs = input.resultRefs ?? []
    const results = resultRefs.map((ref) => {
      const result = this.state.results.get(ref)
      if (!result) throw new Error(`UNKNOWN_RESULT_REF:${ref}`)
      return result
    })
    const privacy = strictestPrivacy(results.map((result) => result.privacy))
    const privacyRefs = results.filter((result) => privacyRank(result.privacy) > 0).map((result) => result.id)
    const contextSpec: LLMContextSpec = { globalSnapshotVersion: input.lane.contextSnapshotVersion, laneSnapshotVersion: input.lane.context.version, resultRefs, eventIds: input.eventIds ?? [], toolSetId: input.toolSetId, instruction: input.instruction, privacy, privacyRefs }
    const prefixBlocks = [
      { kind: 'system' as const, content: input.system ?? '' },
      { kind: 'policy' as const, content: input.policy ?? {} },
      { kind: 'tools' as const, content: input.tools ?? {} },
      { kind: 'global' as const, content: global },
      { kind: 'history' as const, content: input.lane.context.history.map((record) => ({ seq: record.seq, instruction: record.instruction, resultRefs: record.resultRefs, output: record.output, privacy: record.privacy })) },
    ]
    const blocks = [...prefixBlocks, { kind: 'lane' as const, content: input.lane.context.state }, { kind: 'events' as const, content: input.eventIds ?? [] }, { kind: 'results' as const, content: results.map((result) => ({ id: result.id, value: result.value })) }, { kind: 'instruction' as const, content: input.instruction }]
    return { contextSpec, blocks, prefixHash: hash(prefixBlocks), projectionHash: hash(blocks), builderVersion: this.version, policyVersion: '1', toolSetVersion: input.toolSetId, privacy, privacyRefs }
  }
}

export function appendHistory(lane: LaneRecord, record: { instruction: string; resultRefs: string[]; output: JsonValue; privacy: PrivacyLabel }): LaneRecord {
  const next = structuredClone(lane)
  const seq = next.context.history.length ? next.context.history[next.context.history.length - 1]!.seq + 1 : 1
  next.context.history.push({ seq, ...record })
  next.context.version += 1
  return next
}

export function stableSerialize(value: unknown): string { return stable(value) }
export function contentHash(value: unknown): string { return hash(value) }

export interface RebaseConflict { path: string[]; reason: 'changed_since_base' | 'append_target_changed' | 'history_compaction_requires_review' }
export interface RebaseResult { delta?: ContextDelta; conflicts: RebaseConflict[] }

function atPath(value: JsonValue, path: string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, JsonValue>)[part]
  }
  return current
}

function equal(a: JsonValue | undefined, b: JsonValue | undefined): boolean { return stableSerialize(a) === stableSerialize(b) }

export function rebaseContextDelta(delta: ContextDelta, baseState: JsonValue, currentState: JsonValue, currentVersion: number): RebaseResult {
  const conflicts: RebaseConflict[] = []
  for (const op of delta.ops) {
    if (op.op === 'compact_history') { conflicts.push({ path: ['history'], reason: 'history_compaction_requires_review' }); continue }
    const path = op.path ?? []
    const baseValue = atPath(baseState, path)
    const currentValue = atPath(currentState, path)
    if (op.op === 'append') {
      if (!Array.isArray(baseValue) || !Array.isArray(currentValue) || currentValue.length < baseValue.length || !baseValue.every((item, index) => equal(item, currentValue[index]))) conflicts.push({ path, reason: 'append_target_changed' })
    } else if (!equal(baseValue, currentValue)) conflicts.push({ path, reason: 'changed_since_base' })
  }
  if (conflicts.length) return { conflicts }
  return { conflicts: [], delta: { ...delta, baseVersion: currentVersion } }
}
