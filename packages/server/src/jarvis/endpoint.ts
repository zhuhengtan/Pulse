import { isIP } from 'node:net'
import { ipv4FromDottedOrInteger } from '../security.js'

/** Loopback Jarvis is local memory. Any other host is explicit network egress. */
export function assertJarvisApiUrl(raw: string, allowRemote = false): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('JARVIS_URL_INVALID')
  }
  if (url.username || url.password) throw new Error('JARVIS_URL_CREDENTIALS_NOT_ALLOWED')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('JARVIS_URL_SCHEME_NOT_ALLOWED')
  if (!allowRemote && !isLoopbackHost(url.hostname)) throw new Error('JARVIS_REMOTE_URL_DISABLED')
  const path = url.pathname.replace(/\/$/, '')
  return `${url.origin}${path}${url.search}`
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const ipv4 = ipv4FromDottedOrInteger(host) ?? (isIP(host) === 4 ? host : undefined)
  if (!ipv4) return false
  const [first] = ipv4.split('.').map(Number)
  return first === 127
}
