import type { JsonValue, StepContext } from '@hunterzhu/pulse-runtime'

/** Controlled office outputs that create or replace a workspace binary. */
export const officeWriteToolNames = ['pdf.page.render', 'docx.write', 'spreadsheet.xlsx.write', 'pptx.write'] as const

const pptxReadToolNames = new Set(['pptx.read', 'document.pptx.read'])

type Results = Pick<StepContext<unknown>, 'results'>

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function refOrder(ref: string): number {
  return Number(ref.match(/\d+$/)?.[0] ?? 0)
}

/** A successful office write with a real path and SHA-256 is file evidence. */
export function isOfficeFileEdit(toolName: string | undefined, body: unknown): boolean {
  if (!toolName || !(officeWriteToolNames as readonly string[]).includes(toolName)) return false
  const row = record(body)
  return typeof row.path === 'string' && typeof row.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash)
}

/**
 * A PPTX page read is new evidence on the first window, on the cursor returned
 * by the previous read, or when the source hash changes. Repeated windows and
 * reads after the deck is exhausted are not new evidence.
 */
export function isPptxPageProgress(ctx: Results, ref: string, priorRefs: readonly string[]): boolean {
  const meta = ctx.results.meta(ref)
  if (meta?.outcomeStatus !== 'succeeded' || !pptxReadToolNames.has(meta.toolName ?? '')) return false
  const body = record(ctx.results.read(ref))
  const args = record(meta.toolArguments)
  const path = typeof body.path === 'string' ? body.path : typeof args.path === 'string' ? args.path : undefined
  if (!path) return false
  const start = integer(body.startSlide) ?? integer(args.startSlide) ?? 1
  const offset = integer(args.offset) ?? 0
  const priors = priorRefs.filter((prior) => {
    const previous = ctx.results.meta(prior)
    if (previous?.outcomeStatus !== 'succeeded' || !pptxReadToolNames.has(previous.toolName ?? '')) return false
    const previousBody = record(ctx.results.read(prior))
    const previousArgs = record(previous.toolArguments)
    const previousPath = typeof previousBody.path === 'string' ? previousBody.path : typeof previousArgs.path === 'string' ? previousArgs.path : undefined
    return previousPath === path
  }).sort((left, right) => refOrder(left) - refOrder(right))
  const latest = priors.at(-1)
  if (!latest) return start === 1 && offset === 0
  const previousBody = record(ctx.results.read(latest))
  if (typeof body.hash === 'string' && typeof previousBody.hash === 'string' && body.hash !== previousBody.hash) return true
  const nextSlide = integer(previousBody.nextSlide)
  if (previousBody.nextSlide === null || nextSlide === undefined) return false
  return start === nextSlide && offset === (integer(previousBody.nextOffset) ?? 0)
}
