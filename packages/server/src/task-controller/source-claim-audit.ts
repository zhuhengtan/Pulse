import { z } from 'zod'

export const sourceClaimSchema = z.object({
  id: z.string(), text: z.string().max(1800), deliveryRef: z.string(), path: z.string().optional(), hash: z.string().optional(),
})
export const claimAssessmentSchema = z.object({
  claimId: z.string(), criterionId: z.string(), status: z.enum(['supported', 'unsupported', 'contradicted', 'structural']),
  sourceRefs: z.array(z.string()).max(16), quote: z.string().max(600), rationale: z.string().min(1).max(600),
})
export const sourceClaimAuditSchema = z.object({
  schemaVersion: z.literal(1), targets: z.array(sourceClaimSchema).max(96), offset: z.number().int().min(0).max(96),
  assessments: z.array(claimAssessmentSchema).max(96), correctionRounds: z.number().int().min(0).max(1), error: z.string().optional(),
})
export type SourceClaim = z.infer<typeof sourceClaimSchema>
export type ClaimAssessment = z.infer<typeof claimAssessmentSchema>
export type SourceClaimAudit = z.infer<typeof sourceClaimAuditSchema>
export const claimBatchSize = 8
const absolute = /\b(?:always|never|every|all|any|none|only|no)\b|绝不|从不|永远|始终|一律|任何|所有|全部|只会|不会|不产生|没有/iu
const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim()

/** Select assertions mechanically, including statements labelled as summaries. */
export function sourceClaims(deliveries: Array<{ ref: string; text: string; path?: string; hash?: string }>): { targets: SourceClaim[]; error?: string } {
  const targets: SourceClaim[] = []
  for (const delivery of deliveries) {
    let fence: string | undefined
    for (const raw of delivery.text.split('\n')) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1]
      if (marker) { fence = fence ? undefined : marker[0]; continue }
      if (fence || !absolute.test(raw)) continue
      const text = raw.replace(/^\s*>\s?/, '').trim()
      if (text.length > 1800 || targets.length >= 96) return { targets, error: 'SOURCE_CLAIM_COVERAGE_INSUFFICIENT: assertion coverage exceeds the bounded audit; no acceptance from a partial list.' }
      targets.push({ id: `claim-${targets.length + 1}`, text, deliveryRef: delivery.ref, ...(delivery.path ? { path: delivery.path } : {}), ...(delivery.hash ? { hash: delivery.hash } : {}) })
    }
  }
  return { targets }
}

function structural(text: string): boolean {
  return /^(?:[-*>#]+\s*)?(?:this\s+(?:note|report|document|section|table|summary)|本(?:文|报告|节|表|文档))/iu.test(text)
    && !/\b(?:does|cannot|can|will|never|always|writes?|produces?|emits?|suppresses?|enables?|returns?)\b|产生|写入|输出|启用|返回/iu.test(text)
}

/** Quotes must exist in actual cited primary-source windows, not model prose. */
export function claimAssessmentError(targets: SourceClaim[], assessments: ClaimAssessment[], criterionIds: string[], sources: Map<string, string>): string | undefined {
  if (targets.length !== assessments.length || targets.some(target => assessments.filter(row => row.claimId === target.id).length !== 1)) return 'Each supplied claim ID must appear exactly once; no omitted, duplicated or invented claim.'
  for (const row of assessments) {
    if (!criterionIds.includes(row.criterionId) || row.sourceRefs.some(ref => !sources.has(ref))) return 'Use an original criterion ID and actual supplied primary-source refs only.'
    const target = targets.find(target => target.id === row.claimId)!
    if (row.status === 'structural' && !structural(target.text)) return 'A personal summary, recommendation label or interpretation cannot exempt a factual assertion from source support.'
    if (row.status === 'supported') {
      const quote = normalize(row.quote)
      if (quote.length < 12 || !row.sourceRefs.some(ref => normalize(sources.get(ref)!).includes(quote))) return 'A supported assertion needs a short exact quote from at least one cited actual primary-source window.'
    }
  }
  return undefined
}
