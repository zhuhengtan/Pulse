import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationArtifacts } from '../src/ConversationArtifacts.js'

afterEach(cleanup)
it('shows unmerged file location and reads the registered artifact through transport', async () => {
  const request = vi.fn(async (path: string) => new Response(JSON.stringify(path.includes('/content?') ? { content: 'Saved plan' } : [{ path: 'docs/plan.md', runId: 'run-1', absolutePath: '/isolated/docs/plan.md', workspaceState: 'isolated' }]), { status: 200 }))
  render(<ConversationArtifacts conversationId="conv-1" revision="done" transport={{ request, subscribe: () => () => {} }} />)
  await waitFor(() => expect(screen.getByText(/尚未合入项目/)).toBeTruthy())
  expect(screen.getByText('/isolated/docs/plan.md')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看' }))
  await waitFor(() => expect(screen.getByText('Saved plan')).toBeTruthy())
  expect(request.mock.calls.at(-1)?.[0]).toContain('runId=run-1')
})
