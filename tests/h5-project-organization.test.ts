import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import type { WebConversation, WebProject } from '../packages/server/src/protocol.js'

describe('H5 conversation project organization', () => {
  it('migrates legacy history, preserves messages when moving, and retains explicit ungrouping after refresh and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-project-organization-'))
    const cwd = join(root, 'legacy')
    const target = join(root, 'target')
    const dataDir = join(root, 'data')
    await mkdir(cwd)
    await mkdir(target)
    let host = createLocalHost({ cwd, dataDir })
    let server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
    try {
      await host.init()
      const legacy = await host.createConversation({ title: 'Historical conversation' })
      await host.appendAssistantUserMessage(legacy.id, { id: 'old-message', runId: 'old-run', text: 'Keep this history', createdAt: new Date().toISOString() })
      const before = await host.getConversationMessages(legacy.id)
      let baseUrl = `http://127.0.0.1:${(await server.start()).port}`
      const authorize = async () => {
        const local = await fetch(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl } })
        return { Cookie: local.headers.get('set-cookie')!, Origin: baseUrl, 'Content-Type': 'application/json' }
      }
      let headers = await authorize()
      const list = async () => fetch(`${baseUrl}/api/conversations`, { headers }).then(response => response.json()) as Promise<WebConversation[]>
      expect((await list()).find(item => item.id === legacy.id)?.projectId).toBeTruthy()
      const projectResponse = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Target', cwd: target }) })
      expect(projectResponse.status).toBe(201)
      const project = await projectResponse.json() as WebProject
      const move = async (projectId: string | null) => fetch(`${baseUrl}/api/conversations/${legacy.id}`, { method: 'PATCH', headers, body: JSON.stringify({ projectId }) })
      expect((await move(project.id)).status).toBe(200)
      expect((await list()).find(item => item.id === legacy.id)).toMatchObject({ projectId: project.id, cwd: project.cwd })
      expect(await host.getConversationMessages(legacy.id)).toEqual(before)
      expect((await move(null)).status).toBe(200)
      for (let i = 0; i < 2; i++) {
        const summary = (await list()).find(item => item.id === legacy.id)!
        expect(summary.projectId).toBeUndefined()
        expect(summary.projectUnassigned).toBe(true)
      }
      const newConversation = await fetch(`${baseUrl}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ title: 'Explicitly ungrouped' }) }).then(response => response.json()) as WebConversation
      expect((await list()).find(item => item.id === newConversation.id)).toMatchObject({ projectUnassigned: true })
      await server.stop()
      await host.close()
      host = createLocalHost({ cwd, dataDir })
      server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
      baseUrl = `http://127.0.0.1:${(await server.start()).port}`
      headers = await authorize()
      expect((await list()).find(item => item.id === legacy.id)?.projectId).toBeUndefined()
      expect((await list()).find(item => item.id === newConversation.id)?.projectId).toBeUndefined()
      expect(await host.getConversationMessages(legacy.id)).toEqual(before)
      expect((await move(project.id)).status).toBe(200)
      expect((await list()).find(item => item.id === legacy.id)?.projectUnassigned).toBeUndefined()
    } finally {
      await server.stop()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
