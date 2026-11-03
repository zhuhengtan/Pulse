import { createHash } from 'node:crypto'

export interface RequestDiagnostic {
  messageBytes: number
  toolBytes: number
  schemaBytes: number
  estimatedInputTokens: number
  outputReserveTokens?: number
  reusablePrefixBytes: number
  prefixChange: 'initial' | 'request-shape' | 'messages' | 'append' | 'identical'
  requestFingerprint: string
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')
function estimateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(estimateValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return 'x'.repeat(4096 * 4)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, estimateValue(item)]))
}

/** Stores only bounded fingerprints and sizes, never prompt text or credentials.
 * Matching message boundaries are a local diagnostic, NOT provider cache hits.
 */
export class RequestDiagnostics {
  private readonly previous = new Map<string, { shape: string; messages: Array<{ hash: string; bytes: number }> }>()
  measure(key: string, body: Record<string, unknown>): RequestDiagnostic {
    const { messages: rawMessages, input, tools, response_format, text, stream: _stream, stream_options: _options, ...conditions } = body
    const messages = Array.isArray(rawMessages) ? rawMessages : Array.isArray(input) ? input : []
    const shape = digest([conditions, tools, response_format, text])
    const rows = messages.map(message => ({ hash: digest(message), bytes: bytes(message) }))
    const prior = this.previous.get(key)
    let common = 0
    if (prior?.shape === shape) while (common < rows.length && common < prior.messages.length && rows[common]!.hash === prior.messages[common]!.hash) common++
    const reusablePrefixBytes = rows.slice(0, common).reduce((total, row) => total + row.bytes, 0)
    const messageBytes = bytes(messages), toolBytes = bytes(tools), schemaBytes = bytes(response_format ?? text)
    const outputReserve = body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens
    this.previous.delete(key)
    this.previous.set(key, { shape, messages: rows })
    if (this.previous.size > 128) this.previous.delete(this.previous.keys().next().value!)
    return { messageBytes, toolBytes, schemaBytes, ...(typeof outputReserve === 'number' ? { outputReserveTokens: outputReserve } : {}), estimatedInputTokens: Math.ceil((bytes(estimateValue(messages)) + toolBytes + schemaBytes + bytes(conditions.system)) / 4), reusablePrefixBytes,
      prefixChange: !prior ? 'initial' : prior.shape !== shape ? 'request-shape' : common < prior.messages.length ? 'messages' : common < rows.length ? 'append' : 'identical', requestFingerprint: digest(body) }
  }
}
