import { createHash } from 'node:crypto'
import type { ArtifactRecord, ArtifactRef, LaneId, PrivacyLabel, PrivacyTaint, ProvenanceRef, RuntimeState } from '../core/types.js'
import { effectivePrivacy, privacyMetadataForDerivedRef, privacyTaintsForDerivedRefs, privacyRank, strictestPrivacy, validatePrivacyTaints } from '../core/types.js'

export interface ArtifactPublication {
  mediaType: string
  content: Uint8Array | string
  laneId?: LaneId
  ref?: ArtifactRef
  privacy?: PrivacyLabel
  privacyTaints?: PrivacyTaint[]
  derivedFrom?: ProvenanceRef[]
}

function bytesOf(content: Uint8Array | string): Uint8Array { return typeof content === 'string' ? Buffer.from(content, 'utf8') : new Uint8Array(content) }
function mergeTaints(...groups: Array<readonly PrivacyTaint[] | undefined>): PrivacyTaint[] {
  const output: PrivacyTaint[] = []; const seen = new Set<string>()
  for (const group of groups) for (const taint of group ?? []) { const key = JSON.stringify(taint); if (!seen.has(key)) { seen.add(key); output.push(structuredClone(taint)) } }
  return output
}

export function prepareArtifactPublication(state: RuntimeState, publication: ArtifactPublication): ArtifactRecord {
  if (!publication.mediaType || publication.mediaType.length > 255) throw new Error('INVALID_ARTIFACT_MEDIA_TYPE')
  const taintError = validatePrivacyTaints(publication.privacyTaints)
  if (taintError) throw new Error(taintError)
  const lane = publication.laneId === undefined ? undefined : state.lanes.get(publication.laneId)
  if (publication.laneId !== undefined && !lane) throw new Error('UNKNOWN_LANE')
  const refs = publication.derivedFrom ?? []
  const sourceMetadata = refs.map((ref) => lane ? privacyMetadataForDerivedRef(state, lane, ref) : undefined)
  if (sourceMetadata.some((metadata) => metadata === undefined)) throw new Error('UNKNOWN_ARTIFACT_SOURCE')
  const sourcePrivacy = sourceMetadata.map((metadata) => effectivePrivacy(metadata!.privacy, metadata!.privacyTaints))
  const privacy = strictestPrivacy([publication.privacy ?? 'public', ...sourcePrivacy])
  if (publication.privacy !== undefined && privacyRank(publication.privacy) < privacyRank(strictestPrivacy(sourcePrivacy))) throw new Error('PRIVACY_DOWNGRADE_WITHOUT_PROOF')
  const sourceTaints = lane ? privacyTaintsForDerivedRefs(state, lane, refs) : []
  const content = bytesOf(publication.content)
  const ref = publication.ref ?? `artifact-${state.nextIds.artifact}`
  if (state.artifacts.has(ref)) throw new Error('ARTIFACT_REF_ALREADY_EXISTS')
  const record: ArtifactRecord = {
    ref,
    ...(lane ? { agentId: lane.agentId } : {}),
    mediaType: publication.mediaType,
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    contentBase64: Buffer.from(content).toString('base64'),
    privacy,
    ...(mergeTaints(sourceTaints, publication.privacyTaints).length ? { privacyTaints: mergeTaints(sourceTaints, publication.privacyTaints) } : {}),
    ...(refs.length ? { derivedFrom: [...refs] } : {}),
    storageState: 'memory',
    pinCount: 0,
  }
  return structuredClone(record)
}

export function publishArtifact(state: RuntimeState, publication: ArtifactPublication): ArtifactRecord {
  const record = prepareArtifactPublication(state, publication)
  state.artifacts.set(record.ref, record)
  advanceArtifactId(state, record.ref)
  return structuredClone(record)
}

export function advanceArtifactId(state: RuntimeState, ref: ArtifactRef): void {
  const match = /^artifact-(\d+)$/.exec(ref)
  if (match) state.nextIds.artifact = Math.max(state.nextIds.artifact, Number(match[1]) + 1)
}

export function readArtifact(state: RuntimeState, ref: ArtifactRef): Uint8Array {
  const record = state.artifacts.get(ref)
  if (!record) throw new Error('UNKNOWN_ARTIFACT_REF')
  return new Uint8Array(Buffer.from(record.contentBase64, 'base64'))
}

export function pinArtifact(state: RuntimeState, ref: ArtifactRef): void {
  const record = state.artifacts.get(ref)
  if (!record) throw new Error('UNKNOWN_ARTIFACT_REF')
  record.pinCount++
}

export function unpinArtifact(state: RuntimeState, ref: ArtifactRef): void {
  const record = state.artifacts.get(ref)
  if (!record) throw new Error('UNKNOWN_ARTIFACT_REF')
  if (record.pinCount === 0) throw new Error('ARTIFACT_NOT_PINNED')
  record.pinCount--
}

export function markArtifactPersisted(state: RuntimeState, ref: ArtifactRef): void {
  const record = state.artifacts.get(ref)
  if (!record) throw new Error('UNKNOWN_ARTIFACT_REF')
  record.storageState = 'persisted'
}
