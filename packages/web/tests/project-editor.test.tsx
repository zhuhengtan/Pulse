import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ProjectEditor } from '../src/ProjectEditor.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { WebProject } from '../src/transport.js'
beforeAll(() => { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList; vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(cleanup)
const project: WebProject = { id: 'p', name: 'Example', cwd: '/example/a', folders: ['/example/a', '/example/b'], pinned: false, available: true, createdAt: '', updatedAt: '' }
it('atomically saves the name, source folders and selected primary directory', async () => {
  const request = vi.fn(async (_path: string, init?: RequestInit) => Response.json({ ...project, ...JSON.parse(String(init?.body)) })), saved = vi.fn(), close = vi.fn()
  render(<PulseDesignSystem><ProjectEditor project={project} transport={{ request, subscribe: () => () => {} }} canEditFolders onSaved={saved} onClose={close} onRemove={async () => {}}/></PulseDesignSystem>)
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: '设为主文件夹：/example/b' }))
  fireEvent.click(screen.getByRole('button', { name: '移除文件夹：/example/a' }))
  expect((screen.getByRole('button', { name: '移除文件夹：/example/b' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Renamed', cwd: '/example/b', folders: ['/example/b'] })))
  expect(close).toHaveBeenCalledOnce()
})
it('retains edits on a rejected save and leaves the project untouched on cancel', async () => {
  const request = vi.fn(async () => Response.json({ error: 'PROJECT_DIRECTORY_REQUIRED' }, { status: 400 })), saved = vi.fn(), close = vi.fn()
  render(<PulseDesignSystem><ProjectEditor project={project} transport={{ request, subscribe: () => () => {} }} canEditFolders onSaved={saved} onClose={close} onRemove={async () => {}}/></PulseDesignSystem>)
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Keep my draft' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByRole('alert')
  expect((screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value).toBe('Keep my draft')
  expect(saved).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog', { name: '编辑项目' })).getByRole('button', { name: '取消' }))
  expect(close).toHaveBeenCalledOnce()
})
