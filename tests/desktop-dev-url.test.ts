import { expect, it } from 'vitest'
import { desktopPageUrl, isDesktopPageUrl } from '../packages/desktop/src/dev-url.mjs'

it('enables Vite only for an unpackaged desktop and an explicit local port', () => {
  expect(desktopPageUrl(false, 'http://127.0.0.1:5174/work')).toBe('http://127.0.0.1:5174/work')
  expect(desktopPageUrl(true, 'http://127.0.0.1:5174/work')).toBe('pulse://app/chat')
  expect(desktopPageUrl(false, undefined)).toBe('pulse://app/chat')
  for (const value of ['https://example.com', 'http://example.com:5174', 'http://localhost', 'http://user:pass@127.0.0.1:5174', 'file:///tmp/index.html']) expect(() => desktopPageUrl(false, value)).toThrow()
})

it('limits desktop navigation and IPC to the chosen renderer origin', () => {
  const page = desktopPageUrl(false, 'http://127.0.0.1:5174/work')
  expect(isDesktopPageUrl('http://127.0.0.1:5174/settings', page)).toBe(true)
  for (const value of ['http://127.0.0.1:5173/work', 'http://localhost:5174/work', 'http://example.com:5174', 'http://user@127.0.0.1:5174/work', 'pulse://app/chat']) expect(isDesktopPageUrl(value, page)).toBe(false)
  expect(isDesktopPageUrl('pulse://app/work/test', 'pulse://app/chat')).toBe(true)
  expect(isDesktopPageUrl('pulse://app.evil/chat', 'pulse://app/chat')).toBe(false)
})
