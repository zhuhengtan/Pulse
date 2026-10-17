import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

describe('ordinary test network isolation', () => {
  it('blocks external URLs before any real provider request can be sent', async () => {
    for (const input of ['https://api.openai.com/v1/chat/completions', new URL('https://example.invalid'), new Request('https://example.invalid')]) {
      await expect(fetch(input)).rejects.toThrow('OFFLINE_TEST_NETWORK_BLOCKED')
    }
  })

  it('allows explicit provider mocks and stays offline after they are restored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fixture')))
    expect(await (await fetch('https://example.invalid')).text()).toBe('fixture')
    vi.unstubAllGlobals()
    await expect(fetch('https://example.invalid')).rejects.toThrow('OFFLINE_TEST_NETWORK_BLOCKED')
  })
})
