import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { defineReActLane, PulseRuntime } from '@hunterzhu/pulse-runtime'

describe('whole-change acceptance regressions', () => {
  it('blocks external capability execution in read-only mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-capability-policy-'))
    let executions = 0
    const host = createLocalHost({
      cwd: root, dataDir: join(root, 'data'), approvalMode: 'read-only',
      enabledCapabilityPacks: ['remote'],
      capabilityPacks: [{ manifest: { id: 'remote', version: '1', kind: 'mcp', title: 'Remote', description: 'External test tool' },
        async activate() { return { tools: [defineTool({ name: 'remote.write', description: 'Write externally', input: z.object({}), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'external', retrySafety: 'unsafe', execute: async () => { executions++; return { ok: true } } })] } },
      }],
      mockToolCalls: [{ name: 'remote.write', input: {} }], mockAfterToolResponse: 'Stopped.',
    })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Inspect only.' })
      for await (const _event of run.events) { /* drain */ }
      await run.outcome()
      expect(executions).toBe(0)
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('accepts a final answer on the last permitted model turn', async () => {
    const program = defineReActLane({ id: 'last-turn', instruction: 'Answer.', maxTurns: 1 })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { text: 'Done', finishReason: 'stop', toolCalls: [] } }) })
    const { agentId } = runtime.createAgent('Answer', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  })
})
