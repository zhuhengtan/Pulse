import type { WebRunEvent } from '../protocol.js'
import { redactJarvisText } from '../jarvis/privacy.js'

const SECRET_KEY = /password|passwd|token|secret|credential|authorization|api[_-]?key|private[_-]?key|cookie/i
const SECRET_FLAG = /^--?(?:[\w-]*(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|cookie)[\w-]*|user)$/i
const TOOL_TEXT_LIMIT = 8_192
const TOOL_ARRAY_LIMIT = 16
const TOOL_DEPTH_LIMIT = 6

function redactText(text: string): string {
  return redactJarvisText(text)
    .replace(/\b((?:authorization|(?:set-)?cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:^|\s)--?(?:[\w-]*(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|cookie)[\w-]*|user)(?:\s*=\s*|\s+))(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/((?:^|\s)-u(?:\s+|=))(?:"[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'|[^\s,;]*:[^\s,;]*)/gi, '$1[REDACTED]')
    .replace(/((?:^|\s)(?:--cookie|-b)(?:\s+|=))(?:"[^"\n]*=[^"\n]*"|'[^'\n]*=[^'\n]*'|[^\s,;]*=[^\s,;]*)/gi, '$1[REDACTED]')
}

function redactsFollowingValue(flag: string, value: unknown): boolean {
  if (SECRET_FLAG.test(flag)) return true
  if (typeof value !== 'string') return false
  if (/^-u$/i.test(flag)) return value.includes(':')
  if (/^(?:-b|--cookie)$/i.test(flag)) return value.includes('=')
  return false
}

/** Preserve useful tool details without exporting credential fields or argv values. */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const previous = value[index - 1]
      return typeof previous === 'string' && redactsFollowingValue(previous, item) ? '[REDACTED]' : redactValue(item)
    })
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item)]))
  return value
}

function boundToolValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > TOOL_TEXT_LIMIT ? value.slice(0, TOOL_TEXT_LIMIT) : value
  if (typeof value !== 'object' || value === null) return value
  if (depth >= TOOL_DEPTH_LIMIT) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, TOOL_ARRAY_LIMIT).map(item => boundToolValue(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundToolValue(item, depth + 1)]))
}

/** Also applied when reading legacy traces, which may predate outbound redaction. */
export function sanitizeTraceEvent(event: WebRunEvent): WebRunEvent {
  if (event.type !== 'tool' && event.type !== 'trace' && event.type !== 'lanes') return event
  const data = redactValue(event.data)
  return { ...event, data: event.type === 'tool' ? boundToolValue(data) : data } as WebRunEvent
}

/** Highest original seq, including events compaction drops or folds away. */
export function traceWatermark(events: ReadonlyArray<{ seq?: number }>): number {
  return events.reduce((max, event) => Math.max(max, typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : 0), 0)
}

export function prepareRunEvent(event: WebRunEvent, runStartedAt?: number): WebRunEvent {
  const timestamp = event.timestamp ?? Date.now()
  return sanitizeTraceEvent({ ...event, timestamp, runStartedAt: event.runStartedAt ?? runStartedAt ?? timestamp })
}

const TRACE_TEXT_LIMIT = 24_000
const TRACE_EVENT_LIMIT = 3_000

/** Coalesce only within an attempt, retain original timing, and bound the stored size. */
export function compactTraceEvents(events: WebRunEvent[]): WebRunEvent[] {
  const out: WebRunEvent[] = []
  const reasoningSize = new Map<string, number>()
  let lanes: WebRunEvent | undefined
  const activity = new Map<string, number>()
  for (const raw of events) {
    const event = sanitizeTraceEvent(raw)
    if (event.type === 'lanes') { lanes = event; continue }
    if (event.type === 'tool') {
      const index = activity.get(event.data.activityId)
      if (index !== undefined) out[index] = event
      else { activity.set(event.data.activityId, out.length); out.push(event) }
      continue
    }
    if (event.type === 'trace' && (event.data.kind === 'reasoning' || event.data.kind === 'note')) {
      const key = JSON.stringify([event.data.kind, event.data.effectId, event.data.attemptId ?? event.data.attemptNo ?? 1])
      const previous = out.at(-1)
      const used = reasoningSize.get(key) ?? 0
      if (used >= TRACE_TEXT_LIMIT) {
        if (previous?.type === 'trace' && previous.data.kind === event.data.kind && previous.data.effectId === event.data.effectId && (previous.data.attemptId ?? previous.data.attemptNo ?? 1) === (event.data.attemptId ?? event.data.attemptNo ?? 1)) {
          out[out.length - 1] = { ...previous, seq: Math.max(previous.seq, event.seq), ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }) }
        }
        continue
      }
      const text = event.data.text.slice(0, TRACE_TEXT_LIMIT - used)
      reasoningSize.set(key, used + text.length)
      if (previous?.type === 'trace' && previous.data.kind === event.data.kind && previous.data.effectId === event.data.effectId && (previous.data.attemptId ?? previous.data.attemptNo ?? 1) === (event.data.attemptId ?? event.data.attemptNo ?? 1)) {
        const timestamp = event.timestamp ?? previous.timestamp
        out[out.length - 1] = { ...previous, seq: Math.max(previous.seq, event.seq), ...(timestamp === undefined ? {} : { timestamp }), data: { ...previous.data, text: `${(previous.data as { text: string }).text}${text}` } } as WebRunEvent
      } else out.push({ ...event, data: { ...event.data, text } } as WebRunEvent)
      continue
    }
    if (event.type === 'trace' || event.type === 'complete' || event.type === 'error' || event.type === 'status') out.push(event)
  }
  if (lanes) out.push(lanes)
  return out.slice(-TRACE_EVENT_LIMIT).map(sanitizeTraceEvent)
}
