import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationArtifacts, useConversationArtifacts } from '../src/ConversationArtifacts.js'

afterEach(cleanup)
it('shows unmerged file location and reads the registered artifact through transport', async () => {
  const request = vi.fn(async (path: string) => new Response(JSON.stringify(path.includes('/content?') ? { content: 'Saved plan' } : [{ path: 'docs/plan.md', runId: 'run-1', absolutePath: '/isolated/docs/plan.md', workspaceState: 'isolated' }]), { status: 200 }))
  const transport = { request, subscribe: () => () => {} }; function View() { const { artifacts } = useConversationArtifacts('conv-1', 'done', transport); return <ConversationArtifacts conversationId="conv-1" runId="run-1" artifacts={artifacts} transport={transport} /> }; render(<View />)
  await waitFor(() => expect(screen.getByText(/尚未合入项目/)).toBeTruthy())
  expect(screen.getByText('/isolated/docs/plan.md')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看' }))
  await waitFor(() => expect(screen.getByText('Saved plan')).toBeTruthy())
  expect(request.mock.calls.at(-1)?.[0]).toContain('runId=run-1')
})

it('downloads the selected turn file with its own run reference', async () => {
  const request = vi.fn(async (_path: string) => Response.json({ content: '正文' }))
  const create = vi.fn(() => 'blob:turn-file')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { expect(this.download).toBe('plan.md'); expect(this.href).toBe('blob:turn-file') })
  try {
    render(<ConversationArtifacts conversationId="conv-1" runId="run-2" artifacts={[{ path: 'docs/plan.md', runId: 'run-2', absolutePath: '/isolated/docs/plan.md', workspaceState: 'isolated' }]} transport={{ request, subscribe: () => () => {} }} />)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    await waitFor(() => expect(click).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toContain('runId=run-2')
  } finally { click.mockRestore(); vi.unstubAllGlobals() }
})
