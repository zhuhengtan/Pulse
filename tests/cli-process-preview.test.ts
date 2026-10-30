import { describe, expect, it } from 'vitest'
import { shellProcessPending } from '../packages/server/src/run-presentation.ts'
import { toolCallFromObservation } from '../packages/cli/src/utils/tool-view.ts'

describe('CLI shell process preview', () => {
  it('keeps process status that the public preview already projected', () => {
    const call = toolCallFromObservation({ tool: 'shell.poll', status: 'succeeded', effectId: 'effect', preview: { status: 'running', output: 'partial', processId: 'secret' } })
    expect(call?.preview?.status).toBe('running')
    expect(call?.preview).not.toHaveProperty('processId')
    expect(shellProcessPending(call?.name, call?.status, call?.preview)).toBe(true)
    const exited = toolCallFromObservation({ tool: 'shell.poll', status: 'succeeded', preview: { status: 'exited' } })
    expect(shellProcessPending(exited?.name, exited?.status, exited?.preview)).toBe(false)
  })
})
