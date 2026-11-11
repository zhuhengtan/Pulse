import { expect, it } from 'vitest'
import { TerminalDiagnostics } from '../packages/server/src/device-use/terminal-diagnostics.js'

it('defaults off and rejects all arbitrary input without opening or pairing anything', async () => {
  const diagnostics = new TerminalDiagnostics()
  expect(diagnostics.snapshot()).toMatchObject({ enabled: false, simulated: true, productionListener: false, persistentPairing: false, session: { state: 'absent' }, callbacks: { asrPending: 0, replyPending: 0 }, cleanup: { state: 'idle', pendingCallbacks: 0 } })
  await expect(diagnostics.act({ action: 'run', scenario: 'playback-complete' })).rejects.toThrow('DISABLED')
  for (const input of [{ action: 'enable', url: 'http://example.com' }, { action: 'pair' }, { action: 'run', scenario: 'real-device' }, { action: 'run', scenario: 'playback-complete', text: 'untrusted', principal: 'owner' }]) await expect(diagnostics.act(input)).rejects.toThrow('INVALID')
  expect(diagnostics.snapshot().enabled).toBe(false)
  await diagnostics.close(); await expect(diagnostics.act({ action: 'enable' })).rejects.toThrow('CLOSED')
})
it('runs the real broker receipt stages in memory and returns a bounded redacted snapshot', async () => {
  const diagnostics = new TerminalDiagnostics()
  try {
    await diagnostics.act({ action: 'enable' })
    const result = await diagnostics.act({ action: 'run', scenario: 'playback-complete' })
    expect(result).toMatchObject({ enabled: true, busy: false, scenario: 'playback-complete', session: { state: 'open', generation: 1, reportedMuted: false }, reply: { phase: 'completed', admissionConfirmed: true, ackCount: 1, chunkCount: 1 } })
    expect(result.timeline.map(item => item.event)).toEqual(expect.arrayContaining(['session-opened', 'asr-started', 'synthetic-admission-confirmed', 'playback-sent', 'playback-received', 'playback-started', 'playback-completed']))
    const serialized = JSON.stringify(result)
    for (const field of ['"audio":', '"pcm":', '"text":', '"token":', '"key":', 'Late synthetic transcript']) expect(serialized).not.toContain(field)
    result.timeline.length = 0; result.reply!.phase = 'forged'
    expect(diagnostics.snapshot().reply?.phase).toBe('completed'); expect(diagnostics.snapshot().timeline.length).toBeGreaterThan(0)
    const disabled = await diagnostics.act({ action: 'disable' }); expect(disabled.session.generation).toBeUndefined(); expect(disabled).toMatchObject({ enabled: false, cleanup: { state: 'completed', pendingCallbacks: 0 }, session: { state: 'closed' } })
  } finally { await diagnostics.close() }
})
it('shows playback timeout as unknown and never replays it on refresh', async () => {
  const diagnostics = new TerminalDiagnostics()
  try {
    await diagnostics.act({ action: 'enable' })
    const result = await diagnostics.act({ action: 'run', scenario: 'playback-timeout' })
    expect(result.reply).toMatchObject({ phase: 'unknown', errorCode: 'VOICE_TERMINAL_PLAYBACK_TIMEOUT', ackCount: 0 })
    expect(result.timeline.filter(item => item.event === 'playback-sent')).toHaveLength(1)
    expect(diagnostics.snapshot().reply?.phase).toBe('unknown')
    expect(diagnostics.snapshot().timeline.filter(item => item.event === 'playback-sent')).toHaveLength(1)
  } finally { await diagnostics.close() }
})
it('retains uncooperative callback quarantine until the owned simulation actually settles', async () => {
  const diagnostics = new TerminalDiagnostics()
  try {
    await diagnostics.act({ action: 'enable' })
    const held = await diagnostics.act({ action: 'run', scenario: 'callback-quarantine' })
    expect(held).toMatchObject({ cleanup: { state: 'unconfirmed', pendingCallbacks: 1 }, session: { state: 'closed' }, callbacks: { asrPending: 1, asrQuarantined: 1 } })
    expect(diagnostics.snapshot().callbacks.asrPending).toBe(1); expect(held.session.generation).toBeUndefined()
    const settled = await diagnostics.act({ action: 'finish-cleanup' })
    expect(settled).toMatchObject({ cleanup: { state: 'completed', pendingCallbacks: 0 }, callbacks: { asrPending: 0, asrQuarantined: 0 } })
    expect(settled.timeline.map(item => item.event)).toEqual(expect.arrayContaining(['callback-quarantined', 'cleanup-unconfirmed', 'cleanup-completed']))
  } finally { await diagnostics.close() }
})
it('does not queue repeated runs and cleans its own stalled simulation on shutdown', async () => {
  const diagnostics = new TerminalDiagnostics()
  await diagnostics.act({ action: 'enable' })
  const running = diagnostics.act({ action: 'run', scenario: 'playback-timeout' })
  await expect(diagnostics.act({ action: 'run', scenario: 'playback-complete' })).rejects.toThrow('BUSY')
  await running; await diagnostics.act({ action: 'run', scenario: 'callback-quarantine' })
  await diagnostics.close()
  expect(diagnostics.snapshot()).toMatchObject({ enabled: false, busy: false, cleanup: { state: 'completed', pendingCallbacks: 0 }, callbacks: { asrPending: 0 } })
})
