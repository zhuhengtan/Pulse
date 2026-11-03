import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { UpdateSettings } from '../src/Updates.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
beforeAll(() => { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any })
afterEach(cleanup)
it('offers an explicit immediate install that keeps automatic recovery visible', async () => {
  const calls: any[] = [], status = { frontend: 'bundled', phase: 'ready', pending: true, staged: { backend: { version: '9.9.9' } }, recovery: [{ conversationId: 'original', runId: 'same-run', status: 'resumed' }] }
  const transport = { subscribe: () => () => {}, request: async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') calls.push({ path, body: JSON.parse(String(init.body)) })
    return Response.json(status)
  } }
  const ui = render(<PulseDesignSystem><UpdateSettings transport={transport} canManage/></PulseDesignSystem>)
  const install = await ui.findByRole('button', { name: '立即安装并恢复任务' })
  await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(install)
  await waitFor(() => expect(calls).toEqual([{ path: '/api/updates/apply', body: { force: true } }]))
  expect(ui.getByText(/更新前的任务已自动恢复/)).toBeTruthy()
})
it('renders immersive chrome only when the desktop shell advertises native controls', async () => {
  const titlebarTheme = vi.fn()
  window.pulseDesktop = { windowControlsOverlay: true, titlebarTheme } as any
  try {
    const ui = render(<PulseDesignSystem><main>window content</main></PulseDesignSystem>)
    expect(ui.getByLabelText('Pulse 窗口拖动区域')).toBeTruthy()
    expect(ui.container.querySelector('.desktop-window-content main')?.textContent).toBe('window content')
    await waitFor(() => expect(titlebarTheme).toHaveBeenCalled())
  } finally { delete window.pulseDesktop }
})
