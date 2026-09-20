import type { DataRef, FindingRecord, LaneId, PrivacyLabel, PrivacyTaint, RuntimeState } from '../core/types.js'
import { effectivePrivacy, privacyMetadataForDerivedRef, privacyRank, privacyTaintsForDerivedRefs, provenanceRefId, strictestPrivacy, validatePrivacyTaints } from '../core/types.js'
import { contentHash, stableSerialize } from '../context/builder.js'

export interface FindingPublication {
  statement: string
  evidenceRefs: DataRef[]
  laneId: LaneId
  ref?: string
  privacy?: PrivacyLabel
  privacyTaints?: PrivacyTaint[]
}

function sourceVisible(state: RuntimeState, laneId: LaneId, ref: DataRef): boolean {
  const lane = state.lanes.get(laneId)
  if (!lane) return false
  if (ref.kind === 'result') return lane.visibleResultRefs === undefined || lane.visibleResultRefs.has(ref.ref)
  const artifact = state.artifacts.get(ref.ref)
  return artifact !== undefined && (artifact.agentId === undefined || artifact.agentId === lane.agentId)
}

export function prepareFindingPublication(state: RuntimeState, publication: FindingPublication): FindingRecord {
  if (!publication.statement.trim() || publication.statement.length > 4096) throw new Error('INVALID_FINDING_STATEMENT')
  if (publication.evidenceRefs.length === 0) throw new Error('FINDING_REQUIRES_EVIDENCE')
  const taintError = validatePrivacyTaints(publication.privacyTaints)
  if (taintError) throw new Error(taintError)
  const lane = state.lanes.get(publication.laneId)
  if (!lane) throw new Error('UNKNOWN_LANE')
  for (const ref of publication.evidenceRefs) {
    if (!sourceVisible(state, lane.id, ref) || !privacyMetadataForDerivedRef(state, lane, ref)) throw new Error(`UNKNOWN_FINDING_EVIDENCE:${provenanceRefId(ref)}`)
  }
  const sourceMetadata = publication.evidenceRefs.map((ref) => privacyMetadataForDerivedRef(state, lane, ref)!)
  const sourcePrivacy = sourceMetadata.map((metadata) => effectivePrivacy(metadata.privacy, metadata.privacyTaints))
  const privacy = strictestPrivacy([publication.privacy ?? 'public', ...sourcePrivacy])
  if (publication.privacy !== undefined && privacyRank(publication.privacy) < privacyRank(strictestPrivacy(sourcePrivacy))) throw new Error('PRIVACY_DOWNGRADE_WITHOUT_PROOF')
  const sourceTaints = privacyTaintsForDerivedRefs(state, lane, publication.evidenceRefs)
  const ref = publication.ref ?? `finding-${state.nextIds.result}`
  if (state.results.has(ref)) throw new Error('FINDING_REF_ALREADY_EXISTS')
  const record: FindingRecord = {
    id: ref,
    producer: { kind: 'lane', id: lane.id },
    kind: 'finding',
    agentId: lane.agentId,
    laneId: lane.id,
    statement: publication.statement,
    evidenceRefs: structuredClone(publication.evidenceRefs),
    value: { statement: publication.statement, evidenceRefs: structuredClone(publication.evidenceRefs) },
    sizeBytes: Buffer.byteLength(stableSerialize({ statement: publication.statement, evidenceRefs: publication.evidenceRefs }), 'utf8'),
    contentHash: contentHash({ statement: publication.statement, evidenceRefs: publication.evidenceRefs }),
    storageState: 'memory',
    pinCount: 0,
    privacy,
    ...(sourceTaints.length || publication.privacyTaints?.length ? { privacyTaints: [...sourceTaints, ...(publication.privacyTaints ?? [])] } : {}),
    derivedFrom: structuredClone(publication.evidenceRefs),
  }
  return structuredClone(record)
}

export function publishFinding(state: RuntimeState, publication: FindingPublication): FindingRecord {
  const record = prepareFindingPublication(state, publication)
  state.results.set(record.id, record)
  const lane = state.lanes.get(record.laneId)
  if (lane?.visibleResultRefs) lane.visibleResultRefs.add(record.id)
  else if (lane) lane.visibleResultRefs = new Set([record.id])
  advanceFindingId(state, record.id)
  return structuredClone(record)
}

export function advanceFindingId(state: RuntimeState, ref: string): void {
  const match = /^finding-(\d+)$/.exec(ref)
  if (match) state.nextIds.result = Math.max(state.nextIds.result, Number(match[1]) + 1)
}
