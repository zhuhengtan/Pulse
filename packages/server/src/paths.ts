import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The single user-level root shared by CLI, server, desktop, and web runtimes. */
export function pulseHomePath(): string {
  return resolve(process.env.PULSE_HOME ?? join(homedir(), '.pulse'))
}

export function pulseDataPath(): string {
  return join(pulseHomePath(), 'data')
}

export function pulseLogPath(): string {
  return resolve(process.env.PULSE_LOG_DIR ?? join(pulseHomePath(), 'logs'))
}

/** The pre-.pulse location used by releases before the unified layout. */
export function legacyPulseDataPath(): string {
  return join(homedir(), '.local', 'share', 'pulse')
}
