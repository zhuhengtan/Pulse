import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPublicPage, parseSearchResults, webTextWindow } from '../packages/server/src/web.js'

vi.mock('../packages/server/src/security.js', async (original) => {
  const actual = await original<typeof import('../packages/server/src/security.js')>()
  return { ...actual, assertPublicNetworkUrl: async (raw: string, hosts?: string[]) => actual.publicUrl(raw, hosts) }
})
afterEach(() => vi.unstubAllGlobals())

describe('bounded public web reads', () => {
  it('provides continuation offsets so summaries cannot silently hide the rest of a source', () => {
    const text = '雪'.repeat(2300)
    let offset = 0
    let restored = ''
    do {
      const window = webTextWindow(text, offset)
      expect(Buffer.byteLength(window.text)).toBeLessThanOrEqual(3000)
      restored += window.text
      if (window.nextOffset === null) break
      expect(window.truncated).toBe(true)
      offset = window.nextOffset
    } while (offset < text.length)
    expect(restored).toBe(text)
  })

  it('times out a stalled request and signals cancellation', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}) }))
    await expect(readPublicPage('https://example.com', new AbortController().signal, undefined, 10)).rejects.toThrow('WEB_REQUEST_TIMEOUT')
    expect(signal?.aborted).toBe(true)
  })
  it('validates every redirect before fetching it', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(readPublicPage('https://example.com', new AbortController().signal)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('bounds response bytes while reading instead of after buffering the page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('a'.repeat(1_100_000), { headers: { 'content-type': 'text/html' } })))
    const result = await readPublicPage('https://example.com', new AbortController().signal)
    expect(Buffer.byteLength(result.source)).toBe(1_000_000)
    expect(result.truncated).toBe(true)
  })
  it('resolves search redirect links to traceable public source URLs', () => {
    const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=123">Docs</a><a class="result__snippet">A source</a>'
    expect(parseSearchResults(html, 5)).toEqual([{ title: 'Docs', url: 'https://example.com/docs', snippet: 'A source' }])
    expect(parseSearchResults(html, 5, ['allowed.example'])).toEqual([])
    expect(() => parseSearchResults('<form id="challenge-form">captcha</form>', 5)).toThrow('SEARCH_PROVIDER_CHALLENGE')
  })
})
