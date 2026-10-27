import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sha256Hex } from '../src/content-hash.js'
import { MessageBubble } from '../src/MessageBubble.js'
import { copyText } from '../src/clipboard.js'

vi.mock('../src/clipboard.js', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows and copies the revised final body after the same message was expanded', async () => {
  const old = '旧的成功报告。'.repeat(1500)
  const selected = '任务尚未完成，当前环境不可用。'
  const message = { id: 'msg-final-r', role: 'assistant' as const, text: old.slice(0, 8000), bodyTruncated: true, bodyLength: old.length, createdAt: '2026-01-01', runId: 'r' }
  const transport = { request: vi.fn(async () => Response.json({ ...message, text: old, bodyTruncated: false })) }
  const props = { mode: 'work' as const, retry: vi.fn(), onOpenWork: vi.fn(), transport, conversationId: 'a' }
  const view = render(<MessageBubble {...props} message={message} />)
  fireEvent.click(view.getByRole('button', { name: '展开完整消息' }))
  await waitFor(() => expect(view.container.textContent).toContain(old))
  view.rerender(<MessageBubble {...props} message={{ ...message, text: selected, bodyTruncated: false, bodyLength: selected.length }} />)
  expect(view.container.textContent).toContain(selected)
  expect(view.container.textContent).not.toContain('旧的成功报告。')
  fireEvent.click(view.getByRole('button', { name: '复制回复' }))
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(selected))
})

const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('')

it('reloads an expanded body when only the tail changes and the preview length stays the same', async () => {
  const prefix = '配置报告正文。'.repeat(1500)
  const old = `${prefix}最终端口8080`
  const current = `${prefix}最终端口9000`
  expect(current.length).toBe(old.length)
  expect(current.slice(0, 8000)).toBe(old.slice(0, 8000))
  const oldHash = await sha256(old)
  const currentHash = await sha256(current)
  const message = { id: 'msg-final-r', role: 'assistant' as const, text: old.slice(0, 8000), bodyTruncated: true, bodyLength: old.length, bodyHash: oldHash, createdAt: '2026-01-01', runId: 'r' }
  let body = old
  const transport = { request: vi.fn(async () => Response.json({ ...message, text: body, bodyHash: await sha256(body), bodyTruncated: false })) }
  const props = { mode: 'work' as const, retry: vi.fn(), onOpenWork: vi.fn(), transport, conversationId: 'a' }
  const view = render(<MessageBubble {...props} message={message} />)
  fireEvent.click(view.getByRole('button', { name: '展开完整消息' }))
  await waitFor(() => expect(view.container.textContent).toContain('最终端口8080'))
  body = current
  view.rerender(<MessageBubble {...props} message={{ ...message, bodyHash: currentHash }} />)
  await waitFor(() => expect(view.container.textContent).toContain('最终端口9000'))
  expect(view.container.textContent).not.toContain('最终端口8080')
  fireEvent.click(view.getByRole('button', { name: '复制回复' }))
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(current))
})

it('ignores a late body response after the message version changes and does not refetch an unchanged hash', async () => {
  const old = '旧版本报告正文。'.repeat(1500)
  const current = '新版本报告正文。'.repeat(1500)
  const oldHash = await sha256(old)
  const currentHash = await sha256(current)
  const message = { id: 'msg-final-r', role: 'assistant' as const, text: old.slice(0, 8000), bodyTruncated: true, bodyLength: old.length, bodyHash: oldHash, createdAt: '2026-01-01', runId: 'r' }
  let resolveOld: (response: Response) => void = () => undefined
  const request = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
    .mockImplementation(async () => Response.json({ ...message, text: current, bodyHash: currentHash, bodyTruncated: false }))
  const transport = { request }
  const props = { mode: 'work' as const, retry: vi.fn(), onOpenWork: vi.fn(), transport, conversationId: 'a' }
  const view = render(<MessageBubble {...props} message={message} />)
  fireEvent.click(view.getByRole('button', { name: '展开完整消息' }))
  expect(request).toHaveBeenCalledTimes(1)
  view.rerender(<MessageBubble {...props} message={{ ...message, text: current.slice(0, 8000), bodyHash: currentHash, bodyLength: current.length }} />)
  await waitFor(() => expect(view.container.textContent).toContain(current))
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => { resolveOld(Response.json({ ...message, text: old, bodyHash: oldHash, bodyTruncated: false })) })
  await waitFor(() => expect(view.container.textContent).toContain(current))
  expect(view.container.textContent).not.toContain('旧版本报告正文。')
  vi.mocked(copyText).mockClear()
  fireEvent.click(view.getByRole('button', { name: '复制回复' }))
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(current))
  expect(copyText).not.toHaveBeenCalledWith(old)
  const stable = request.mock.calls.length
  for (let index = 0; index < 3; index += 1) view.rerender(<MessageBubble {...props} message={{ ...message, text: current.slice(0, 8000), bodyHash: currentHash, bodyLength: current.length }} />)
  expect(request).toHaveBeenCalledTimes(stable)
})

it('checks the full body with the same SHA-256 when SubtleCrypto is unavailable', async () => {
  const full = '完整正文。'.repeat(2000)
  const hash = createHash('sha256').update(full).digest('hex')
  expect(sha256Hex(new TextEncoder().encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256Hex(new TextEncoder().encode(full))).toBe(hash)
  vi.stubGlobal('crypto', { subtle: undefined })
  const message = { id: 'msg-final-r', role: 'assistant' as const, text: full.slice(0, 8000), bodyTruncated: true, bodyLength: full.length, bodyHash: hash, createdAt: '2026-01-01', runId: 'r' }
  const transport = { request: vi.fn(async () => Response.json({ ...message, text: full, bodyHash: hash, bodyTruncated: false })) }
  const props = { mode: 'work' as const, retry: vi.fn(), onOpenWork: vi.fn(), transport, conversationId: 'a' }
  const view = render(<MessageBubble {...props} message={message} />)
  fireEvent.click(view.getByRole('button', { name: '展开完整消息' }))
  await waitFor(() => expect(view.container.textContent).toContain(full))
  fireEvent.click(view.getByRole('button', { name: '复制回复' }))
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(full))
  const wrong = render(<MessageBubble {...props} message={message} transport={{ request: vi.fn(async () => Response.json({ ...message, text: `${full}wrong`, bodyHash: hash, bodyTruncated: false })) }} />)
  fireEvent.click(wrong.getByRole('button', { name: '展开完整消息' }))
  await wrong.findByText('正文暂时无法加载，请重试。')
  expect(wrong.container.textContent).not.toContain('wrong')
})
