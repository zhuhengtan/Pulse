import type { RuntimeError } from './types.js'

export class ControlError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(error: RuntimeError) {
    super(error.message)
    this.name = 'ControlError'
    this.code = error.code
    this.details = error.details
  }
}

export function error(code: string, message: string, details?: unknown): RuntimeError {
  return { code, message, ...(details === undefined ? {} : { details: details as never }) }
}

export function runtimeErrorFromCause(cause: unknown, fallbackCode = 'EFFECT_FAILED'): RuntimeError {
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : fallbackCode
    const message = typeof candidate.message === 'string' ? candidate.message : cause instanceof Error ? cause.message : String(cause)
    return {
      code,
      message,
      ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
      ...(isJsonValue(candidate.details) ? { details: candidate.details } : {}),
    }
  }
  return { code: fallbackCode, message: cause instanceof Error ? cause.message : String(cause) }
}

function isJsonValue(value: unknown): value is import('./types.js').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}
