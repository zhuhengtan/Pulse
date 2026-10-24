import type { JsonValue } from '@hunterzhu/pulse-runtime'

/** New-controller preflight; legacy tool callers retain their clamped reads. */
export function assertReadWindowInput(name: string, input: JsonValue, limit?: number): void {
  if (name !== 'fs.read' || !limit || !input || typeof input !== 'object' || Array.isArray(input)) return
  if (typeof input.maxBytes !== 'number' || input.maxBytes <= limit) return
  const message = `fs.read.maxBytes must be <= ${limit}. Larger legacy requests are clamped, not larger reads. If the previous result has nextOffset, read that offset with maxBytes <= ${limit}; do not reread the first page or increase maxBytes.`
  throw Object.assign(new Error(message), { code: 'INVALID_TOOL_INPUT', retryable: false, details: { tool: name, diagnostics: [{ path: 'maxBytes', constraint: `maximum ${limit} bytes per window`, received: input.maxBytes, message }] } })
}
