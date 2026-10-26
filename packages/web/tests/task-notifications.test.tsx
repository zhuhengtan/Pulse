import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskNotificationInbox } from '../src/TaskNotifications.js'
import type { PulseWebTransport } from '../src/transport.js'

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
