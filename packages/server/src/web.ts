import { assertPublicNetworkUrl, publicUrl } from './security.js'

const MAX_PAGE_BYTES = 1_000_000

/** Bound DNS, redirects and body consumption under one deadline. */
export async function readPublicPage(raw: string, parent: AbortSignal, allowHosts?: string[], timeoutMs = 12_000): Promise<{ url: string; source: string; truncated: boolean }> {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  if (parent.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error('WEB_REQUEST_TIMEOUT')), timeoutMs)
  let removeAbort = () => {}
  try {
    const cancelled = new Promise<never>((_, reject) => {
      const listener = () => reject(controller.signal.reason ?? new Error('WEB_REQUEST_CANCELLED'))
      removeAbort = () => controller.signal.removeEventListener('abort', listener)
      controller.signal.addEventListener('abort', listener, { once: true })
      if (controller.signal.aborted) listener()
    })
    const request = async () => {
      let next = raw
      for (let redirects = 0; redirects <= 5; redirects++) {
        const url = await assertPublicNetworkUrl(next, allowHosts)
        controller.signal.throwIfAborted()
        const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location) throw new Error('WEB_REDIRECT_WITHOUT_LOCATION')
          next = new URL(location, url).toString()
          continue
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP_${response.status}`) }
        const type = response.headers.get('content-type') ?? ''
        if (!/text\/|json|xml/i.test(type)) { await response.body?.cancel(); throw new Error('UNSUPPORTED_WEB_CONTENT_TYPE') }
        const reader = response.body?.getReader()
        if (!reader) return { url: url.toString(), source: '', truncated: false }
        const chunks: Uint8Array[] = []
        let size = 0
        let truncated = false
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const remaining = MAX_PAGE_BYTES - size
            chunks.push(value.subarray(0, remaining))
            size += Math.min(value.byteLength, remaining)
            if (value.byteLength > remaining || size >= MAX_PAGE_BYTES) { truncated = true; await reader.cancel(); break }
          }
        } finally { reader.releaseLock() }
        return { url: url.toString(), source: Buffer.concat(chunks).toString('utf8'), truncated }
      }
      throw new Error('WEB_TOO_MANY_REDIRECTS')
    }
    return await Promise.race([request(), cancelled])
  } finally {
    clearTimeout(timer)
    removeAbort()
    parent.removeEventListener('abort', abort)
  }
}

export function plainWebText(source: string): string {
  return source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function fetchText(raw: string, signal: AbortSignal, allowHosts?: string[], offset = 0) {
  const page = await readPublicPage(raw, signal, allowHosts)
  const text = plainWebText(page.source)
  const title = plainWebText(page.source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? new URL(page.url).hostname)
  const window = webTextWindow(text, offset)
  return { url: page.url, title: title.slice(0, 160), ...window, sourceTruncated: page.truncated, fetchedAt: new Date().toISOString() }
}

export function parseSearchResults(page: string, limit: number, allowHosts?: string[]) {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const pattern = /result__a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?result__snippet[^>]*>([\s\S]*?)<\//g
  for (const match of page.matchAll(pattern)) {
    if (results.length >= limit) break
    try {
      const link = new URL(match[1]!.replace(/&amp;/g, '&'), 'https://html.duckduckgo.com')
      const target = link.hostname.endsWith('.duckduckgo.com') || link.hostname === 'duckduckgo.com' ? link.searchParams.get('uddg') ?? link.toString() : link.toString()
      const url = publicUrl(target, allowHosts).toString()
      results.push({ title: plainWebText(match[2] ?? ''), url, snippet: plainWebText(match[3] ?? '') })
    } catch { /* Skip invalid or disallowed results; never broaden the allow-list. */ }
  }
  if (!results.length && /anomaly|captcha|challenge-form/i.test(page)) throw new Error('SEARCH_PROVIDER_CHALLENGE')
  return results
}

export function webTextWindow(text: string, offset = 0) {
  let content = text.slice(offset, offset + 2000)
  while (Buffer.byteLength(content, 'utf8') > 3000) content = content.slice(0, -1)
  if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
  const end = offset + content.length
  return { text: content, offset, totalChars: text.length, truncated: end < text.length, nextOffset: end < text.length ? end : null }
}
