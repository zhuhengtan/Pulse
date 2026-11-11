import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { HomeAssistantAdapter } from '../packages/server/src/device-use/home-assistant.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-temperature-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const service = new HostDeviceService(dir); cleanup.push(() => service.close())
  let attributes: Record<string, unknown> = { current_temperature: 68, temperature: 77 }
  const request = vi.fn(async () => new Response(JSON.stringify({ entity_id: 'climate.ac', state: 'cool', attributes, last_updated: new Date().toISOString() })))
  vi.stubGlobal('fetch', request)
  // No sockets, credentials or real hardware: exercise the real REST mapping only.
  vi.spyOn(HomeAssistantAdapter.prototype, 'startEvents').mockResolvedValue()
  const handoff = { homeId: 'fixture-home', baseUrl: 'https://ha.example', token: 'fixture-secret', entities: [{ entityId: 'climate.ac', writable: false }] }
  return { service, dir, request, handoff, setAttributes(value: Record<string, unknown>) { attributes = value } }
}
describe.skipIf(process.platform === 'win32')('trusted Host climate temperature preference', () => {
  it.each(['celsius', 'fahrenheit'] as const)('passes explicit %s only to the exact allowlisted read-only climate entity', async climateTemperatureUnit => {
    const f = await fixture()
    if (climateTemperatureUnit === 'celsius') f.setAttributes({ current_temperature: 20, temperature: 25 })
    const status = await f.service.connectHomeAssistant({ ...f.handoff, climateTemperatureUnit })
    const device = status.devices[0]!
    expect(device.state.temperatureC).toBe(20)
    expect(device.state.targetTemperatureC).toBe(25)
    expect(device.capabilities).toEqual([{ kind: 'thermostat', readable: true, writable: false, confirmable: false, unit: 'celsius' }])
    await f.service.enroll({ deviceId: device.deviceId })
    await expect(f.service.grant({ deviceId: device.deviceId, actions: ['power'], expiresInMinutes: 10 })).rejects.toThrow('DEVICE_HOST_HIGH_RISK_UNSUPPORTED')
    expect(f.request).toHaveBeenCalled()
    for (const [url, init] of f.request.mock.calls as unknown as Array<[string, RequestInit]>) { expect(String(url)).toBe('https://ha.example/api/states/climate.ac'); expect(init.method).toBe('GET') }
  })
  it('persists only the scoped unit, restores it offline after restart, and preserves it through disable/simulator settings', async () => {
    const f = await fixture()
    await f.service.connectHomeAssistant({ ...f.handoff, baseUrl: 'https://ha.example/', climateTemperatureUnit: 'fahrenheit' })
    await f.service.configure({ enabled: false, mode: 'home-assistant' })
    await f.service.configure({ enabled: false, mode: 'simulator' })
    const saved = JSON.parse(await readFile(join(f.dir, 'device-use', 'settings.json'), 'utf8'))
    expect(saved.homeAssistantTemperature).toEqual({ baseUrl: 'https://ha.example', homeId: 'fixture-home', climateTemperatureUnit: 'fahrenheit' })
    expect(JSON.stringify(saved)).not.toContain(f.handoff.token)
    expect(saved).not.toHaveProperty('entities')
    await f.service.close(); f.request.mockClear()
    const next = new HostDeviceService(f.dir); cleanup.push(() => next.close())
    expect(await next.status()).toMatchObject({ ready: false, credentials: 'not-configured', homeAssistantTemperature: saved.homeAssistantTemperature })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('does not inherit a previous unit on omitted or changed gateway/home handoff, and clears the saved preference', async () => {
    const f = await fixture()
    await f.service.connectHomeAssistant({ ...f.handoff, climateTemperatureUnit: 'fahrenheit' })
    for (const handoff of [f.handoff, { ...f.handoff, homeId: 'different-home', baseUrl: 'https://other.example' }]) {
      const status = await f.service.connectHomeAssistant(handoff)
      expect(status.homeAssistantTemperature).toBeNull()
      expect(status.devices.find(d => d.homeId === handoff.homeId)!.state).not.toHaveProperty('temperatureC')
      expect(status.devices.find(d => d.homeId === handoff.homeId)!.state).not.toHaveProperty('targetTemperatureC')
      expect(JSON.parse(await readFile(join(f.dir, 'device-use', 'settings.json'), 'utf8'))).not.toHaveProperty('homeAssistantTemperature')
    }
  })
  it('keeps unknown/conflicting device units hidden despite an explicit Host preference and rejects unsupported options before network use', async () => {
    const f = await fixture()
    await expect(f.service.connectHomeAssistant({ ...f.handoff, climateTemperatureUnit: 'kelvin' })).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    for (const temperature_unit of ['K', '°C']) {
      f.setAttributes({ current_temperature: 68, temperature: 77, temperature_unit })
      const status = await f.service.connectHomeAssistant({ ...f.handoff, climateTemperatureUnit: 'fahrenheit' })
      expect(status.devices[0]!.state).not.toHaveProperty('temperatureC')
      expect(status.devices[0]!.state).not.toHaveProperty('targetTemperatureC')
      expect(status.devices[0]!.capabilities[0]).not.toHaveProperty('unit')
    }
  })
})
