import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '@hunterzhu/pulse-server'

describe('local CLI application host', () => {
  it('runs a mock task, projects events, and stores the conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-host-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'local result' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'say hello' })
      const events = []
      for await (const event of run.events) events.push(event)
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'local result' })
      expect(events.some((event) => event.type === 'complete')).toBe(true)
      expect(JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'manifest.json'), 'utf8')).activeRunId).toBeUndefined()
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps read-only mode explicit in the diagnostic surface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-doctor-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'read-only' })
      const doctor = await host.doctor()
      expect(doctor.ok).toBe(true)
      expect(doctor.tools).toContain('fs.read')
      expect(doctor.tools).toContain('shell.exec')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('only exposes web tools when network access is explicitly enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-network-'))
    try {
      const offline = createLocalHost({ cwd: directory, dataDir: join(directory, 'offline') })
      await expect(offline.doctor()).resolves.not.toMatchObject({ tools: expect.arrayContaining(['web.fetch', 'web.search']) })
      await offline.close()
      const online = createLocalHost({ cwd: directory, dataDir: join(directory, 'online'), allowNetwork: true })
      await expect(online.doctor()).resolves.toMatchObject({ tools: expect.arrayContaining(['web.fetch', 'web.search']) })
      await online.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('pauses for a durable tool approval and continues after reply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-approval-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'fs.write', input: { path: 'approved.txt', content: 'approved' } }], mockAfterToolResponse: 'write finished' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'write the file' })
      let replied = false
      for await (const event of run.events) {
        if (event.type !== 'waiting') continue
        const data = event.data as { effectId?: string }
        expect(data.effectId).toEqual(expect.any(String))
        await run.reply(data.effectId!, { approved: true })
        replied = true
      }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'write finished' })
      expect(replied).toBe(true)
      await expect(readFile(join(directory, 'approved.txt'), 'utf8')).resolves.toBe('approved')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('executes an approved write automatically in auto mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-auto-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'auto.txt', content: 'auto' } }], mockAfterToolResponse: 'auto finished' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'write automatically' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'auto finished' })
      await expect(readFile(join(directory, 'auto.txt'), 'utf8')).resolves.toBe('auto')
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('supports exact patching and records an artifact in the conversation index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-patch-'))
    try {
      await writeFile(join(directory, 'note.txt'), 'before\n')
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.apply_patch', input: { path: 'note.txt', find: 'before', replace: 'after' } }], mockAfterToolResponse: 'patched' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'patch the note' })
      for await (const _event of run.events) { /* drain */ }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'patched' })
      await expect(readFile(join(directory, 'note.txt'), 'utf8')).resolves.toBe('after\n')
      const content = await readFile(join(directory, 'note.txt'))
      const expectedHash = createHash('sha256').update(content).digest('hex')
      const artifactHost = createLocalHost({ cwd: directory, dataDir: join(directory, 'artifact-data'), approvalMode: 'auto', mockToolCalls: [{ name: 'artifact.record', input: { path: 'note.txt', mediaType: 'text/plain', label: 'note' } }], mockAfterToolResponse: 'recorded' })
      const artifactConversation = await artifactHost.createConversation()
      const artifactRun = await artifactHost.sendMessage(artifactConversation.id, { text: 'record the note' })
      for await (const _event of artifactRun.events) { /* drain */ }
      await expect(artifactRun.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'recorded' })
      await expect(artifactHost.listArtifacts(artifactConversation.id)).resolves.toEqual([expect.objectContaining({ path: 'note.txt', hash: expectedHash, label: 'note', mediaType: 'text/plain' })])
      await host.close(); await artifactHost.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('turns a denied approval into a failed run without applying the write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-deny-'))
    try {
      const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'fs.write', input: { path: 'denied.txt', content: 'nope' } }], mockAfterToolResponse: 'should not run' })
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'do not write' })
      for await (const event of run.events) {
        if (event.type === 'waiting') {
          const data = event.data as { effectId?: string }
          await run.reply(data.effectId!, { approved: false, reason: 'user denied' })
        }
      }
      await expect(run.outcome()).resolves.toMatchObject({ status: 'failed' })
      await expect(readFile(join(directory, 'denied.txt'), 'utf8')).rejects.toThrow()
      await host.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('restores an interrupted approval Run from the persisted runtime snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-resume-'))
    try {
      const options = { cwd: directory, dataDir: join(directory, 'data'), mockToolCalls: [{ name: 'fs.write', input: { path: 'resumed.txt', content: 'resumed' } }], mockAfterToolResponse: 'resumed finished' }
      const first = createLocalHost(options)
      const conversation = await first.createConversation()
      const interrupted = await first.sendMessage(conversation.id, { text: 'write and pause' })
      for await (const event of interrupted.events) {
        if (event.type === 'waiting') break
      }
      const firstRunId = (await first.getConversation(conversation.id)).summary.activeRunId
      const firstRuntime = (first as unknown as { active: Map<string, { runtime: { flushPersistence: () => Promise<void>; cancelAgent: () => void } }> }).active.get(firstRunId!)?.runtime
      if (!firstRuntime) throw new Error('FIRST_RUNTIME_NOT_FOUND')
      firstRuntime.cancelAgent = () => {}
      await first.close()
      const second = createLocalHost(options)
      const resumed = await second.resumeRun(conversation.id)
      for await (const event of resumed.events) {
        if (event.type !== 'waiting') continue
        const data = event.data as { effectId?: string }
        await resumed.reply(data.effectId!, { approved: true })
      }
      await expect(resumed.outcome()).resolves.toMatchObject({ status: 'succeeded', text: 'resumed finished' })
      await expect(readFile(join(directory, 'resumed.txt'), 'utf8')).resolves.toBe('resumed')
      await second.close()
      await first.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a second host while a conversation is owned by another process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-lock-'))
    try {
      const dataDir = join(directory, 'data')
      const first = createLocalHost({ cwd: directory, dataDir, mockResponse: 'first' })
      const second = createLocalHost({ cwd: directory, dataDir, mockResponse: 'second' })
      const conversation = await first.createConversation()
      const firstRun = await first.sendMessage(conversation.id, { text: 'hold the conversation' })
      await expect(second.sendMessage(conversation.id, { text: 'race the conversation' })).rejects.toThrow('CONVERSATION_BUSY')
      await firstRun.cancel('test cleanup')
      for await (const _event of firstRun.events) { /* drain */ }
      await first.close(); await second.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
