import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RunProcessPanel } from '../src/RunProcessPanel.js'
import type { PulseWebTransport } from '../src/transport.js'
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }) })
afterEach(() => cleanup())
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const id = 'a'.repeat(64)
it('pages read-only output through run endpoints and cancels exactly once without a stdin channel', async () => {
  let cancelled = false
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const process = { processId: id, command: { command: 'local-script', pty: true }, status: cancelled ? 'exited' : 'running', stdinReady: !cancelled }
    if (init?.method === 'POST') { expect(path).toBe(`/api/runs/run-a/processes/${id}/cancel`); cancelled = true; return json(process) }
    if (path === '/api/runs/run-a/processes') return json({ items: [process] })
    expect(path).toMatch(new RegExp(`/api/runs/run-a/processes/${id}\\?offset=(0|4)$`))
    return json({ ...process, output: path.endsWith('=0') ? 'one\n' : 'two\n', nextOffset: path.endsWith('=0') ? 4 : 8, truncated: path.endsWith('=0') })
  })
  const transport: PulseWebTransport = { request, subscribe: () => () => {} }
  render(<RunProcessPanel transport={transport} runId="run-a" onClose={() => {}} />)
  await waitFor(() => expect(screen.getByLabelText('只读进程输出').textContent).toBe('one\ntwo\n'))
  expect(document.querySelector('input,textarea,[contenteditable="true"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '停止进程' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '停止进程' }) as HTMLButtonElement).disabled).toBe(true))
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(request.mock.calls.some(([path]) => path.includes('stdin') || path.includes('/terminals'))).toBe(false)
})
it('disables unknown process cancellation and ignores output arriving after closure', async () => {
  let finish!: (value: Response) => void
  const transport: PulseWebTransport = { request: vi.fn(async path => path.endsWith('/processes') ? json({ items: [{ processId: id, command: { command: 'uncertain' }, status: 'unknown', inputUncertain: true }] }) : new Promise<Response>(resolve => { finish = resolve })), subscribe: () => () => {} }
  const view = render(<RunProcessPanel transport={transport} runId="run-old" onClose={() => {}} />)
  expect(await screen.findByText(/输入送达状态未知/)).toBeTruthy()
  expect((screen.getByRole('button', { name: '停止进程' }) as HTMLButtonElement).disabled).toBe(true)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.unmount(); finish(json({ output: 'stale-output', nextOffset: 12, truncated: false, status: 'exited' }))
  await Promise.resolve()
  expect(document.body.textContent).not.toContain('stale-output')
})
