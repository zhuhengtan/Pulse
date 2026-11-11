import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { SettingsPage } from '../src/SettingsPage.js'
import type { PulseWebTransport } from '../src/transport.js'
import { settingsFixture } from './fixtures/settings.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const VERSION = 'a'.repeat(64)
/** Reuse the safe settings fixture; add the global prompt and capture/answer the one PUT under test. */
function promptFixture(putResponse: { status: number; body: unknown }) {
  const base = settingsFixture()
  const puts: any[] = []
  const transport: PulseWebTransport = {
    ...base.transport,
    async request(path, init) {
      if (path === '/api/config' && (init?.method ?? 'GET') === 'GET') {
        const original = await base.transport.request(path, init), body = await original.json()
        return new Response(JSON.stringify({ ...body, globalPrompt: { prompt: 'Saved prompt.', configured: true, path: '/example/global-prompt.json', version: VERSION } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (path === '/api/config' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(putResponse.body), { status: putResponse.status, headers: { 'Content-Type': 'application/json' } })
      }
      return base.transport.request(path, init)
    },
  }
  return { transport, puts }
}
async function editPrompt(transport: PulseWebTransport, draft: string) {
  render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig onClose={() => {}} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button', { name: '指令', exact: true }))
  const field = await screen.findByLabelText('全局提示词') as HTMLTextAreaElement
  await waitFor(() => expect(field.value).toBe('Saved prompt.'))
  fireEvent.change(field, { target: { value: draft } })
  fireEvent.click(screen.getByRole('button', { name: '保存全部' }))
  return field
}

describe('settings global prompt save', () => {
  it('sends the prompt version it read together with the edited prompt', async () => {
    const f = promptFixture({ status: 200, body: { ok: true, path: '/example/config.json', version: 'next', applied: true, restartRequired: [], config: {}, globalPrompt: { prompt: 'Edited prompt.', configured: true, path: '/example/global-prompt.json', version: 'b'.repeat(64) } } })
    await editPrompt(f.transport, 'Edited prompt.')
    await waitFor(() => expect(f.puts).toHaveLength(1))
    expect(f.puts[0]).toMatchObject({ globalPrompt: 'Edited prompt.', globalPromptVersion: VERSION })
  })

  it('keeps the user draft and reports the conflict when another writer changed the prompt', async () => {
    const f = promptFixture({ status: 409, body: { error: 'GLOBAL_PROMPT_CONFLICT' } })
    const field = await editPrompt(f.transport, 'My unsaved draft.')
    await waitFor(() => expect(f.puts).toHaveLength(1))
    expect(await screen.findByText(/全局提示词已被其他窗口修改/)).toBeTruthy()
    expect(f.puts[0]).toMatchObject({ globalPromptVersion: VERSION })
    expect(field.value).toBe('My unsaved draft.')
    expect(document.querySelector('[data-global-prompt-status]')?.getAttribute('data-global-prompt-status')).toBe('dirty')
  })
})
