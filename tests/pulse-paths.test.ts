import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { legacyPulseDataPath, pulseDataPath, pulseHomePath, pulseLogPath } from '../packages/server/src/paths.js'

const originalHome = process.env.PULSE_HOME
const originalData = process.env.PULSE_DATA_DIR
const originalLogs = process.env.PULSE_LOG_DIR

afterEach(() => {
  if (originalHome === undefined) delete process.env.PULSE_HOME
  else process.env.PULSE_HOME = originalHome
  if (originalData === undefined) delete process.env.PULSE_DATA_DIR
  else process.env.PULSE_DATA_DIR = originalData
  if (originalLogs === undefined) delete process.env.PULSE_LOG_DIR
  else process.env.PULSE_LOG_DIR = originalLogs
})

describe('Pulse user paths', () => {
  it('uses one cross-platform home root for default data and logs', () => {
    delete process.env.PULSE_HOME
    delete process.env.PULSE_DATA_DIR
    delete process.env.PULSE_LOG_DIR

    expect(pulseHomePath()).toBe(resolve(join(homedir(), '.pulse')))
    expect(pulseDataPath()).toBe(join(pulseHomePath(), 'data'))
    expect(pulseLogPath()).toBe(join(pulseHomePath(), 'logs'))
    expect(legacyPulseDataPath()).toBe(join(homedir(), '.local', 'share', 'pulse'))
  })

  it('allows relocating the shared root and log directory with environment variables', () => {
    process.env.PULSE_HOME = '/tmp/pulse-home-test'
    process.env.PULSE_LOG_DIR = '/tmp/pulse-logs-test'

    expect(pulseHomePath()).toBe('/tmp/pulse-home-test')
    expect(pulseDataPath()).toBe('/tmp/pulse-home-test/data')
    expect(pulseLogPath()).toBe('/tmp/pulse-logs-test')
  })
})
