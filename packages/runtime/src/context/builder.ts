import { createHash } from 'node:crypto'
import type { AgentRecord, ArtifactRef, LaneRecord, LLMContextSpec, LLMRequestProjection, PrivacyLabel, PrivacyTaint, ResultRef, RuntimeState, JsonValue, ContextDelta, ContextOp } from '../core/types.js'
import { effectivePrivacy, privacyRank, strictestPrivacy } from '../core/types.js'

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
  artifactRefs?: ArtifactRef[]
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
      if (input.lane.visibleResultRefs !== undefined && !input.lane.visibleResultRefs.has(ref)) throw new Error(`RESULT_NOT_VISIBLE:${ref}`)
      return result
    })
    const artifactRefs = input.artifactRefs ?? []
    const artifacts = artifactRefs.map((ref) => {
      const artifact = this.state.artifacts.get(ref)
      if (!artifact) throw new Error(`UNKNOWN_ARTIFACT_REF:${ref}`)
      if (artifact.agentId !== undefined && artifact.agentId !== input.agent.id) throw new Error(`ARTIFACT_NOT_VISIBLE:${ref}`)
      return artifact
    })
    const globalMetadata = input.agent.globalPrivacy?.get(input.lane.contextSnapshotVersion) ?? { privacy: 'public' as const }
    const laneMetadata = { privacy: input.lane.context.privacy ?? 'public', privacyTaints: input.lane.context.privacyTaints }
    const effectiveResults = results.map((result) => ({ result, privacy: effectivePrivacy(result.privacy, result.privacyTaints) }))
    const effectiveArtifacts = artifacts.map((artifact) => ({ artifact, privacy: effectivePrivacy(artifact.privacy, artifact.privacyTaints) }))
    const privacy = strictestPrivacy([globalMetadata.privacy, laneMetadata.privacy, ...effectiveResults.map((item) => item.privacy), ...effectiveArtifacts.map((item) => item.privacy)])
    const privacyRefs = [
      ...(privacyRank(globalMetadata.privacy) > 0 ? [`global:${input.lane.contextSnapshotVersion}`] : []),
      ...(privacyRank(laneMetadata.privacy) > 0 ? [`lane:${input.lane.context.version}`] : []),
      ...effectiveResults.filter((item) => privacyRank(item.privacy) > 0).map((item) => ({ kind: 'result' as const, ref: item.result.id })),
      ...effectiveArtifacts.filter((item) => privacyRank(item.privacy) > 0).map((item) => ({ kind: 'artifact' as const, ref: item.artifact.ref })),
    ]
    const privacyTaints = [
      ...(globalMetadata.privacyTaints ?? []).map((taint) => ({ path: ['global', ...taint.path], privacy: taint.privacy })),
      ...(laneMetadata.privacyTaints ?? []).map((taint) => ({ path: ['lane', ...taint.path], privacy: taint.privacy })),
      ...effectiveResults.flatMap((item) => (item.result.privacyTaints ?? []).map((taint) => ({ path: [item.result.id, ...taint.path], privacy: taint.privacy }))),
      ...effectiveArtifacts.flatMap((item) => (item.artifact.privacyTaints ?? []).map((taint) => ({ path: [item.artifact.ref, ...taint.path], privacy: taint.privacy }))),
    ]
    const contextSpec: LLMContextSpec = { globalSnapshotVersion: input.lane.contextSnapshotVersion, laneSnapshotVersion: input.lane.context.version, resultRefs, ...(artifactRefs.length ? { artifactRefs } : {}), eventIds: input.eventIds ?? [], toolSetId: input.toolSetId, instruction: input.instruction, privacy, privacyRefs, ...(privacyTaints.length ? { privacyTaints } : {}) }
    const prefixBlocks = [
      { kind: 'system' as const, content: input.system ?? '' },
      { kind: 'policy' as const, content: input.policy ?? {} },
      { kind: 'tools' as const, content: input.tools ?? {} },
      { kind: 'global' as const, content: global },
      { kind: 'history' as const, content: input.lane.context.history.map((record) => ({ seq: record.seq, ...(record.effectId === undefined ? {} : { effectId: record.effectId }), instruction: record.instruction, resultRefs: record.resultRefs, ...(record.resultSelection === undefined ? {} : { resultSelection: record.resultSelection }), ...(record.result === undefined ? {} : { result: record.result }), ...(record.findings === undefined ? {} : { findings: record.findings }), output: record.output, privacy: record.privacy, ...(record.privacyTaints === undefined ? {} : { privacyTaints: record.privacyTaints as unknown as JsonValue }) })) },
    ]
    const blocks = [...prefixBlocks, { kind: 'lane' as const, content: input.lane.context.state }, { kind: 'events' as const, content: input.eventIds ?? [] }, { kind: 'results' as const, content: results.map((result) => ({ id: result.id, value: result.value ?? null, ...(result.privacyTaints === undefined ? {} : { privacyTaints: result.privacyTaints.map((taint) => ({ path: [...taint.path], privacy: taint.privacy }) as unknown as JsonValue) }) })) }, { kind: 'artifacts' as const, content: artifacts.map((artifact) => ({ ref: artifact.ref, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes, contentHash: artifact.contentHash })) }, { kind: 'instruction' as const, content: input.instruction }]
    return { contextSpec, blocks, prefixHash: hash(prefixBlocks), projectionHash: hash(blocks), builderVersion: this.version, policyVersion: '1', toolSetVersion: input.toolSetId, privacy, privacyRefs, ...(privacyTaints.length ? { privacyTaints } : {}) }
  }
}

export function appendHistory(lane: LaneRecord, record: { effectId?: string; instruction: string; resultRefs: string[]; resultSelection?: Array<{ ref: string; rule: string; hash: string }>; result?: string; findings?: string[]; output: JsonValue; privacy: PrivacyLabel; privacyTaints?: PrivacyTaint[] }): LaneRecord {
  const next = structuredClone(lane)
  const seq = next.context.history.length ? next.context.history[next.context.history.length - 1]!.seq + 1 : 1
  next.context.history.push({ seq, ...record })
  next.context.version += 1
  return next
}

/** A deterministic, conservative estimate used for admission rather than billing. */
export function estimateHistoryTokens(history: ReadonlyArray<{ seq: number; instruction: string; resultRefs: string[]; output: JsonValue; privacy: PrivacyLabel }>): number {
  return Math.ceil(Buffer.byteLength(stableSerialize(history), 'utf8') / 4)
}

export function historyPressure(history: ReadonlyArray<{ seq: number; instruction: string; resultRefs: string[]; output: JsonValue; privacy: PrivacyLabel }>, softTokens: number, hardTokens: number): { historyTokens: number; softTokens: number; hardTokens: number } | undefined {
  const historyTokens = estimateHistoryTokens(history)
  return historyTokens > softTokens ? { historyTokens, softTokens, hardTokens } : undefined
}

export function stableSerialize(value: unknown): string { return stable(value) }
export function contentHash(value: unknown): string { return hash(value) }

/**
 * Path segments that would reach the prototype chain instead of own data. Any
 * ContextDelta, MergeProposal or draft-proxy path containing one of these is
 * rejected before it can touch `Object.prototype`.
 */
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
export function isUnsafePathSegment(segment: string): boolean { return UNSAFE_PATH_SEGMENTS.has(segment) }
export function hasUnsafePathSegment(path: readonly string[]): boolean { return path.some(isUnsafePathSegment) }
/** Own-property lookup that never walks the prototype chain. */
export function ownChild(container: Record<string, JsonValue>, key: string): JsonValue | undefined { return Object.hasOwn(container, key) ? container[key] : undefined }

export interface RebaseConflict { path: string[]; reason: 'changed_since_base' | 'append_target_changed' | 'history_compaction_requires_review' }
export interface RebaseResult { delta?: ContextDelta; conflicts: RebaseConflict[] }

function atPath(value: JsonValue, path: string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || isUnsafePathSegment(part)) return undefined
    current = ownChild(current as Record<string, JsonValue>, part)
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
