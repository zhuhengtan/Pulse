import { expect, it, vi } from 'vitest'
// @ts-expect-error desktop source is deliberately plain JavaScript.
import { configureWindowChrome, windowChrome } from '../packages/desktop/src/window-chrome.mjs'
it('removes Windows native title/menu bars while retaining native snap and window controls', () => {
  expect(windowChrome('win32')).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: 36 }, autoHideMenuBar: true })
  expect(windowChrome('win32', false).titleBarOverlay).toMatchObject({ color: '#ffffff', symbolColor: '#202020' })
  const window = { setMenu: vi.fn(), setMenuBarVisibility: vi.fn() }
  configureWindowChrome(window, 'win32')
  expect(window.setMenu).toHaveBeenCalledWith(null); expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false)
  expect(windowChrome('darwin')).toEqual({}); expect(windowChrome('linux')).toEqual({})
})
