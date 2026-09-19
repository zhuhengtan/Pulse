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
