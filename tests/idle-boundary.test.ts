import { describe, expect, it } from 'vitest'
import { PulseRuntime, VirtualClock } from '@pulse/runtime'

describe('Runtime idle boundaries', () => {
  it('waitForIdle drains timers that are already due', async () => {
    const runtime = new PulseRuntime({ clock: new VirtualClock() })
    let fired = false
    runtime.clock.schedule(0, () => { fired = true })

    await runtime.waitForIdle()

    expect(fired).toBe(true)
  })

  it('shutdown drains timers that are already due before stopping', async () => {
    const runtime = new PulseRuntime({ clock: new VirtualClock() })
    let fired = false
    runtime.clock.schedule(0, () => { fired = true })

    await expect(runtime.shutdown()).resolves.toMatchObject({ status: 'stopped' })
    expect(fired).toBe(true)
  })
})
