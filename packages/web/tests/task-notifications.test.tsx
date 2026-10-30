import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskNotificationInbox } from '../src/TaskNotifications.js'
import type { PulseWebTransport } from '../src/transport.js'

const webRoot = process.cwd().endsWith('/packages/web') ? process.cwd() : join(process.cwd(), 'packages/web')
const themeCss = readFileSync(join(webRoot, 'src/workbench-theme.css'), 'utf8')
const surfaceCss = readFileSync(join(webRoot, 'src/chat-surface.css'), 'utf8')
function installActionStyles() {
  const action = themeCss.match(/\.task-notice-panel \.task-notice-action \{[^}]+\}/)?.[0]
  const focus = themeCss.match(/\.task-notice-panel \.task-notice-action:hover,\.task-notice-panel \.task-notice-action:focus-visible \{[^}]+\}/)?.[0]
  if (!action || !focus) throw new Error('notification action rules missing')
  const node = document.createElement('style')
  node.textContent = `:root .chat.chat-surface[data-chat-theme="dark"] { --ink:#ededed; --surface-raised:#242424; --soft:#2d2d2d; } button:not(.ant-btn){color:inherit} ${action} ${focus}`
  document.head.append(node)
  return () => node.remove()
}

function channels(color: string) {
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = color.match(/^#([0-9a-f]{6})$/i)
  if (!hex) throw new Error(`unparsed color ${color}`)
  const value = hex[1] ?? ''
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16))
}
function contrast(foreground: string, background: string) {
  const delta = (index: number) => Math.abs((channels(foreground)[index] ?? 0) - (channels(background)[index] ?? 0))
  return Math.max(delta(0), delta(1), delta(2))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState({}, '', '/') })
it('keeps denied notifications as actionable inbox items without requesting permission', async () => {
  const requestPermission = vi.fn()
  vi.stubGlobal('Notification', Object.assign(class {}, { permission: 'denied', requestPermission }))
  const item = { id: 'question', kind: 'ask', runId: 'r', conversationId: 'c', groupId: 'g' }
  const request = vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/notifications' ? [item] : { state: 'running', interactions: [{ groupId: 'g' }] })))
  const open = vi.fn(), view = render(<TaskNotificationInbox transport={{ request } as unknown as PulseWebTransport} open={open}/>)
  await waitFor(() => expect(view.getByRole('button', { name: '通知 / 待办（1）' })).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: '通知 / 待办（1）' }))
  fireEvent.click(view.getByRole('button', { name: '回答待处理问题' }))
  expect(open).toHaveBeenCalledWith('/work/c?notification=g')
  expect(requestPermission).not.toHaveBeenCalled()
  expect(localStorage.getItem('pulse-task-notices')).not.toContain('question')
})
it('does not notify completed historical tasks on first load', async () => {
  const construct = vi.fn()
  vi.stubGlobal('Notification', Object.assign(class { constructor(...args: any[]) { construct(...args) } }, { permission: 'granted' }))
  const transport = { request: async () => new Response(JSON.stringify([{ id: 'complete:r', kind: 'complete', runId: 'r', conversationId: 'c' }])) } as unknown as PulseWebTransport
  const view = render(<TaskNotificationInbox transport={transport} open={() => {}}/>)
  await waitFor(() => expect(view.getByText('通知 / 待办（1）')).toBeTruthy())
  expect(construct).not.toHaveBeenCalled()
  expect(localStorage.getItem('pulse-task-notices')).toContain('complete:r')
})
it('keeps all pending items actionable when system notification construction throws', async () => {
  const construct = vi.fn(() => { throw new TypeError('Notification constructor unavailable') })
  vi.stubGlobal('Notification', Object.assign(class { constructor() { construct() } }, { permission: 'granted' }))
  const items = ['a', 'b'].map(id => ({ id, kind: 'ask', runId: id, conversationId: id, groupId: id }))
  const request = vi.fn(async (path: string) => Response.json(path === '/api/notifications' ? items : { state: 'running', interactions: [{ groupId: path.split('/')[3] }] }))
  const open = vi.fn(), view = render(<TaskNotificationInbox transport={{ request } as unknown as PulseWebTransport} open={open}/>)
  fireEvent.click(await view.findByRole('button', { name: '通知 / 待办（2）' }))
  fireEvent.click(view.getAllByRole('button', { name: '回答待处理问题' })[1]!)
  expect(open).toHaveBeenCalledWith('/work/b?notification=b')
  expect(construct).toHaveBeenCalledTimes(2)
  expect(localStorage.getItem('pulse-task-notices')).not.toContain('"a"')
  expect(localStorage.getItem('pulse-task-notices')).not.toContain('"b"')
})
it('keeps dark notification actions readable and clamps the menu inside a 390px viewport', async () => {
  document.documentElement.dataset.theme = 'dark'
  const requestPermission = vi.fn().mockResolvedValue('granted')
  vi.stubGlobal('Notification', Object.assign(class {}, { permission: 'default', requestPermission }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
  const theme = themeCss
  const surface = surfaceCss
  expect(theme.startsWith('import ')).toBe(false)
  expect(theme).toContain('background-color:var(--surface-raised); color:var(--ink);')
  expect(theme).toContain('.task-notice-action:focus-visible { background-color:var(--soft); color:var(--ink);')
  expect(theme).toContain('.task-notice-panel { position:fixed; z-index:90; right:8px; left:auto;')
  expect(theme).toContain('width:min(280px,calc(100vw - 16px))')
  expect(theme).toContain('.navbar.surface-work .navbar-actions { flex:0 1 auto;')
  expect(theme).not.toContain('flex:1 1 100%')
  expect(theme).toContain('.navbar.surface-work .navbar-status { display:flex; flex:1 0 100%;')
  expect(theme).toContain('top:calc(76px + var(--pulse-safe-top,env(safe-area-inset-top,0px)))')
  expect(theme).not.toContain('148px')
  expect(theme).not.toContain('max-width:6.5rem')
  expect(theme).toContain('.approval-panel .interaction-actions { flex-wrap:wrap; gap:6px; }')
  expect(surface).toContain('--ink:#ededed')
  expect(surface).toContain('--surface-raised:#242424')
  const removeStyles = installActionStyles()
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('task-notice-toggle')) return { x: 171, y: 8, left: 171, right: 239, top: 8, bottom: 48, width: 68, height: 40, toJSON() { return {} } } as DOMRect
    return { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, toJSON() { return {} } } as DOMRect
  })
  const item = { id: 'approval', kind: 'approval', runId: 'r', conversationId: 'c', groupId: 'g' }
  const request = vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/notifications' ? [item] : { state: 'running', interactions: [{ groupId: 'g' }] })))
  const open = vi.fn()
  try {
    const view = render(<div className="chat chat-surface" data-chat-theme="dark"><header className="navbar"><TaskNotificationInbox transport={{ request } as unknown as PulseWebTransport} open={open}/></header></div>)
    const toggle = await view.findByRole('button', { name: '通知 / 待办（1）' })
    expect(toggle.querySelector('.task-notice-compact svg')).toBeTruthy()
    expect(toggle.querySelector('.task-notice-count')?.textContent).toBe('1')
    fireEvent.click(toggle)
    const action = view.getByRole('button', { name: '查看待审批任务' })
    const paint = getComputedStyle(action)
    expect(paint.color).toBe('var(--ink)')
    expect(paint.backgroundColor).toBe('var(--surface-raised)')
    expect(contrast('#ededed', '#242424')).toBeGreaterThan(80)
    expect(contrast('#ededed', '#2d2d2d')).toBeGreaterThan(80)
    const panel = view.getByRole('region', { name: '待办列表' })
    const left = Number.parseFloat(panel.style.left)
    const width = Number.parseFloat(panel.style.width)
    expect(left).toBe(8)
    expect(left + width).toBeLessThanOrEqual(382)
    fireEvent.click(view.getByRole('button', { name: '启用系统通知' }))
    expect(requestPermission).toHaveBeenCalledOnce()
    fireEvent.click(action)
    expect(open).toHaveBeenCalledWith('/work/c?notification=g')
  } finally {
    rect.mockRestore()
    removeStyles()
    document.documentElement.dataset.theme = ''
  }
})
