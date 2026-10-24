import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it.each([false, true])('keeps early readers attached while a worker starts (missing lookup: %s)', async missingLookup => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-work-start-race-'))
  const host = createLocalHost({ cwd: dir, dataDir: dir, mockResponse: 'retained work result' })
  const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
  let release!: () => void
  const handshake = new Promise<void>(resolve => { release = resolve })
  let runId: string | undefined
  const send = host.sendMessage.bind(host)
  vi.spyOn(host, 'sendMessage').mockImplementation(async (...args) => {
    const handle = await send(...args)
    runId = handle.id
    await handshake
    return handle
  })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const conversation = await host.createConversation({ title: 'Delayed handshake' })
    const sending = fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'hello', requestId: 'send-race-0001' }) })
    await vi.waitFor(() => expect(runId).toBeDefined())
    // This is the same durable runId used by uncertain-send reconciliation.
    expect(await host.findConversationByRunId(runId!)).toBe(conversation.id)
    const lookup = missingLookup ? vi.spyOn(host, 'findConversationByRunId').mockResolvedValue(undefined) : undefined
    let stateReturned = false, eventsReturned = false
    const state = fetch(`${base}/api/runs/${runId}/state`, { headers }).then(response => { stateReturned = true; return response.json() })
    const events = fetch(`${base}/api/runs/${runId}/events`, { headers }).then(response => { eventsReturned = true; return response.text() })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(stateReturned).toBe(false)
    expect(eventsReturned).toBe(false)
    lookup?.mockRestore()
    release()
    expect((await sending).status).toBe(200)
    expect(await state).toMatchObject({ runId })
    const stream = await events
    expect(stream).toContain('retained work result')
    expect(stream).toContain('run_finished')
    expect(host.sendMessage).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await server.stop()
    await host.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
