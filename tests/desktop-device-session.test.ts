import { expect, it, vi } from 'vitest'
import { deviceSessionPartition, restoreDeviceCookie, saveDeviceCookie } from '../packages/desktop/src/device-session.mjs'

it('isolates service credentials by data directory and persists only the session cookie', async () => {
 expect(deviceSessionPartition('/example/a')).not.toBe(deviceSessionPartition('/example/b'))
 expect(deviceSessionPartition('/example/a')).toBe(deviceSessionPartition('/example/./a'))
 const cookies = { get: vi.fn(async () => [{ value: 'fixture-token' }]), set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) }
 expect(await restoreDeviceCookie(cookies, 'http://127.0.0.1:7000')).toBe('pulse_device=fixture-token')
 await saveDeviceCookie(cookies, 'http://127.0.0.1:7001', 'pulse_device=fixture-token; HttpOnly; Path=/')
 expect(cookies.set).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://127.0.0.1:7001', name: 'pulse_device', value: 'fixture-token', httpOnly: true, sameSite: 'strict' }))
 expect(cookies.flushStore).toHaveBeenCalledOnce()
 await saveDeviceCookie(cookies, 'http://127.0.0.1:7001', 'other=value; Path=/')
 expect(cookies.set).toHaveBeenCalledTimes(1)
})
