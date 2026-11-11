import { expect, it, vi } from 'vitest'
import { loginStartupEnabled, setLoginStartup } from '../packages/desktop/src/login-startup.mjs'

it('reads the Windows login item with the same args it registers', async () => {
  const get = vi.fn(() => ({ openAtLogin: true })), set = vi.fn()
  const app = { getLoginItemSettings: get, setLoginItemSettings: set }
  await setLoginStartup(app, true, 'win32')
  expect(set).toHaveBeenCalledWith({ openAtLogin: true, args: ['--background'] })
  expect(loginStartupEnabled(app, 'win32')).toBe(true)
  expect(get).toHaveBeenCalledWith({ args: ['--background'] })
})
it('leaves macOS reads unchanged', () => {
  const get = vi.fn(() => ({ openAtLogin: false }))
  expect(loginStartupEnabled({ getLoginItemSettings: get }, 'darwin')).toBe(false)
  expect(get).toHaveBeenCalledWith()
})
