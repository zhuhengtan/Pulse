import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const mock = vi.hoisted(() => ({ options: [] as any[], calls: vi.fn(async (_name: string, _args: any) => ({ content: [{ type: 'text', text: '- 0: (current) [Fixture](https://example.com/)' }] })), close: vi.fn(async () => {}) }))
vi.mock('@hunterzhu/pulse-adapters', () => ({ McpStdioClient: class {
 constructor(options: unknown) { mock.options.push(options) }
 async connect() {}
 async refreshTools() { return ['browser_tabs', 'browser_close'].map(name => ({ name })) }
 callTool = mock.calls
 close = mock.close
} }))
import { BrowserBackend } from '../packages/server/src/automation/browser.js'
afterEach(() => { mock.options.length = 0; vi.clearAllMocks() })
it('uses a headless dedicated browser and never recreates a page after closing its last tab', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-browser-close-'))
 try {
  const backend = new BrowserBackend({}, root, join(root, 'profile'), true)
  expect(mock.options[0].args).toContain('--headless')
  const result = await backend.call('closeTab', { index: 0 })
  expect(result).toMatchObject({ items: [] })
  expect(mock.calls.mock.calls.filter(([name]) => name === 'browser_tabs')).toHaveLength(1)
  expect(mock.close).toHaveBeenCalledOnce()
  await expect(backend.call('tabs', {})).rejects.toThrow('AUTOMATION_SESSION_NOT_FOUND')
  expect(mock.calls.mock.calls.filter(([name]) => name === 'browser_tabs')).toHaveLength(1)
 } finally { await rm(root, { recursive: true, force: true }) }
})
it('keeps explicit attachment to an existing user browser separate', () => {
 new BrowserBackend({ mode: 'existing' }, '/tmp', '/tmp/profile', true)
 expect(mock.options[0].args).toContain('--extension')
 expect(mock.options[0].args).not.toContain('--headless')
})
