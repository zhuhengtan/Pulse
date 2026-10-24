import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { H5ProjectCatalog } from '../packages/server/src/h5/projects.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

describe('project source folders and manual order', () => {
  it('validates a complete edit before replacing it and persists primary folders and drag order', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-project-folders-')))
    try {
      const paths = ['a', 'b', 'c'].map(name => join(root, name)); await Promise.all(paths.map(path => mkdir(path)))
      const data = join(root, 'data'), catalog = new H5ProjectCatalog(data)
      const first = await catalog.add('First', paths[0]!), second = await catalog.add('Second', paths[2]!)
      await expect(catalog.update(first.id, { name: 'Must not change', cwd: paths[1]!, folders: [paths[0]!] })).rejects.toThrow('PROJECT_PRIMARY_FOLDER_REQUIRED')
      expect((await catalog.get(first.id))?.name).toBe('First')
      await expect(catalog.update(first.id, { folders: [] })).rejects.toThrow('PROJECT_FOLDERS_INVALID')
      await expect(catalog.update(first.id, { cwd: paths[2]!, folders: [paths[2]!] })).rejects.toThrow('PROJECT_ALREADY_REGISTERED')
      const edited = await catalog.update(first.id, { name: 'Edited', cwd: paths[1]!, folders: [paths[0]!, paths[1]!, paths[1]!] })
      expect(edited).toMatchObject({ name: 'Edited', cwd: paths[1], folders: paths.slice(0, 2) })
      await catalog.update(first.id, { pinned: true })
      await catalog.reorder([second.id, first.id])
      const restored = new H5ProjectCatalog(data)
      expect((await restored.list()).map(item => item.id)).toEqual([second.id, first.id])
      expect(await restored.get(first.id)).toMatchObject({ cwd: paths[1], folders: paths.slice(0, 2) })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('uses the edited primary folder for new conversations while preserving existing execution directories', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-project-primary-'))), initial = join(root, 'initial'), next = join(root, 'next'), dataDir = join(root, 'data')
    await mkdir(initial); await mkdir(next)
    const host = createLocalHost({ cwd: initial, dataDir }), server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
    try {
      const base = `http://127.0.0.1:${(await server.start()).port}`
      const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
      const headers = { Cookie: local.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
      const request = (path: string, method: string, body: unknown) => fetch(base + path, { method, headers, body: JSON.stringify(body) })
      const projects = await fetch(base + '/api/projects', { headers }).then(response => response.json())
      const project = projects.find((item: { cwd: string }) => item.cwd === initial) ?? await request('/api/projects', 'POST', { name: 'Primary test', cwd: initial }).then(response => response.json())
      const old = await request('/api/conversations', 'POST', { projectId: project.id }).then(response => response.json())
      expect(old.cwd).toBe(initial)
      const patch = await request(`/api/projects/${project.id}`, 'PATCH', { name: 'Edited', folders: [initial, next], cwd: next })
      expect(patch.status).toBe(200)
      expect(await patch.json()).toMatchObject({ cwd: next, folders: [initial, next] })
      const created = await request('/api/conversations', 'POST', { projectId: project.id }).then(response => response.json())
      expect(created.cwd).toBe(next)
      expect((await host.listConversations()).find(item => item.id === old.id)?.cwd).toBe(initial)
      expect((await request(`/api/projects/${project.id}`, 'PATCH', { folders: 'invalid' })).status).toBe(400)
      expect((await request(`/api/projects/${project.id}`, 'PATCH', { folders: [initial], cwd: next })).status).toBe(400)
    } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })
})
