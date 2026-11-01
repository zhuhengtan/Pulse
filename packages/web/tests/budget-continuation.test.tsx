import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { BudgetContinuationPrompt } from '../src/BudgetContinuationPrompt.js'
import { InteractionPanel } from '../src/InteractionPanel.js'
import { routingFixture } from './fixtures/routing.js'
beforeAll(() => { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList })
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
const offer = { status: 'available', conversationId: 'c', runId: 'old', used: 256, limit: 256, totalUsed: 512, calls: 256, continuationRunId: 'next' }
function fixture(post: (init: RequestInit) => Promise<Response> = async () => Response.json({ runId: 'next' })) {
  const transport = routingFixture().transport, writes: unknown[] = []
  transport.request = async (_path, init) => {
    if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return post(init) }
    return Response.json(offer)
  }
  return { transport, writes }
}
it('only asks after the allowance is exhausted; displaying or declining never renews it', async () => {
  const f = fixture(), continued = vi.fn()
  render(<PulseDesignSystem><BudgetContinuationPrompt transport={f.transport} conversationId="c" revision="old" running={false} onContinued={continued}/></PulseDesignSystem>)
  await screen.findByRole('region', { name: '调用额度已用尽' })
  expect(screen.getByText(/任务累计使用 512 次/)).toBeTruthy()
  expect(f.writes).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '暂不继续' }))
  expect(screen.queryByRole('region', { name: '调用额度已用尽' })).toBeNull()
  expect(continued).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
})
it('confirms a single 256-call continuation and retries with the identical source boundary', async () => {
  let fail = true
  const f = fixture(async () => fail ? Response.json({ error: 'OFFLINE' }, { status: 503 }) : Response.json({ runId: 'next' })), continued = vi.fn()
  render(<PulseDesignSystem><BudgetContinuationPrompt transport={f.transport} conversationId="c" revision="old" running={false} onContinued={continued}/></PulseDesignSystem>)
  fireEvent.click(await screen.findByRole('button', { name: '继续，增加 256 次调用' }))
  await screen.findByRole('alert'); expect(continued).not.toHaveBeenCalled()
  fail = false; fireEvent.click(screen.getByRole('button', { name: '继续，增加 256 次调用' }))
  await waitFor(() => expect(continued).toHaveBeenCalledWith('next')); expect(continued).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual([{ confirmed: true, expectedUsed: 256, expectedLimit: 256 }, { confirmed: true, expectedUsed: 256, expectedLimit: 256 }])
})
it('does not start an old conversation after the confirmation response arrives late', async () => {
  let finish!: (value: Response) => void
  const f = fixture(() => new Promise(resolve => { finish = resolve })), continued = vi.fn()
  const view = render(<PulseDesignSystem><BudgetContinuationPrompt transport={f.transport} conversationId="c" revision="old" running={false} onContinued={continued}/></PulseDesignSystem>)
  fireEvent.click(await screen.findByRole('button', { name: '继续，增加 256 次调用' }))
  view.unmount(); finish(Response.json({ runId: 'next' }))
  await Promise.resolve(); await Promise.resolve()
  expect(continued).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1)
})
it('offers permanent command remembering for mixed approval groups without remembering other operations', async () => {
  const submit = vi.fn(async () => true)
  const interaction = { kind: 'interaction' as const, runId: 'r', groupId: 'g', interactionKind: 'approval' as const, items: [
    { effectId: 'commands', input: { tools: [{ toolName: 'fs.read' }, { toolName: 'shell.exec', details: { command: 'ls', args: ['-la', 'src'] } }, { toolName: 'shell.exec', details: { command: 'cat', args: ['src/notes.txt'] } }], execPolicy: { token: 'host-token', prefix: ['ls', '-la', 'src'], commands: [['ls', '-la', 'src'], ['cat', 'src/notes.txt']], canAmend: true } } },
    { effectId: 'write', input: { tools: [{ toolName: 'fs.apply_patches', details: { path: 'src/main.ts' } }] } },
  ] }
  render(<PulseDesignSystem><InteractionPanel interaction={interaction} localAdmin reviewNote="" delegated submit={submit}/></PulseDesignSystem>)
  expect(screen.getByText('cat src/notes.txt')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '以后放行相同命令' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith([{ effectId: 'commands', value: { approved: true, remember: 'permanent', execPolicyToken: 'host-token' } }, { effectId: 'write', value: { approved: true } }]))
})
