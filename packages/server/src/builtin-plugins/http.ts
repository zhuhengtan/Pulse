import { AsyncLocalStorage } from 'node:async_hooks'
import { assertPublicNetworkUrl } from '../security.js'
import type { ResolvedConnection } from './config.js'

export type PluginNetworkAction = 'submit' | 'continue' | 'cancel'
/** Checked at each network boundary of the active plugin job. Absent outside a job. */
export const pluginNetworkGate = new AsyncLocalStorage<(action: PluginNetworkAction) => void>()
export function guardPluginNetwork(action: PluginNetworkAction): void { pluginNetworkGate.getStore()?.(action) }

export const MAX_MEDIA_BYTES = 128 * 1024 * 1024
export function pluginError(code: string): Error { return Object.assign(new Error(code), { code, retryable: false }) }
export function safeError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  return /^(?:PLUGIN|PROVIDER_CREDENTIAL)_[A-Z0-9_]+$/.test(code) ? code : 'PLUGIN_NETWORK_ERROR'
}
export function headers(c: ResolvedConnection): Record<string, string> {
  return c.apiKey ? c.adapter === 'google' ? { 'x-goog-api-key': c.apiKey } : c.adapter === 'elevenlabs' ? { 'xi-api-key': c.apiKey } : { authorization: 'Bearer ' + c.apiKey } : {}
}
export async function boundedBytes(response: Response, limit = MAX_MEDIA_BYTES): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw pluginError('PLUGIN_EMPTY_RESULT')
  let size = 0; const chunks: Uint8Array[] = []
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw pluginError('PLUGIN_RESPONSE_TOO_LARGE'); chunks.push(value) }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export function endpoint(c: ResolvedConnection, route: string): URL {
  // Routes are adapter-owned. Never follow an untrusted status URL.
  if (!route.startsWith('/') || route.includes('..') || route.startsWith('//')) throw pluginError('PLUGIN_PROTOCOL_ERROR')
  return new URL(c.baseURL.replace(/\/$/, '') + route)
}
export async function request(c: ResolvedConnection, route: string, signal: AbortSignal, body?: unknown, method = body === undefined ? 'GET' : 'POST', binary = false, action?: PluginNetworkAction): Promise<any> {
  guardPluginNetwork(action ?? (method === 'DELETE' ? 'cancel' : method === 'GET' || method === 'HEAD' ? 'continue' : 'submit'))
  signal.throwIfAborted()
  const form = body instanceof FormData
  let response: Response
  try {
    response = await fetch(endpoint(c, route), { method, headers: { ...headers(c), ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}), signal, redirect: 'manual' })
  } catch (e) { signal.throwIfAborted(); throw pluginError('PLUGIN_NETWORK_ERROR') }
  if (!response.ok) {
    await response.body?.cancel()
    throw pluginError(response.status >= 300 && response.status < 400 ? 'PLUGIN_REDIRECT_BLOCKED' : response.status === 401 || response.status === 403 ? 'PLUGIN_AUTH_FAILED' : response.status === 402 ? 'PLUGIN_QUOTA_EXHAUSTED' : 'PLUGIN_HTTP_' + response.status)
  }
  if (method === 'DELETE') { await response.body?.cancel().catch(() => {}); return {} }
  const bytes = await boundedBytes(response, binary ? MAX_MEDIA_BYTES : MAX_MEDIA_BYTES * 1.4)
  if (binary) return { bytes, mediaType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' }
  let value: any
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw pluginError('PLUGIN_PROTOCOL_ERROR') }
  if (!value || typeof value !== 'object') throw pluginError('PLUGIN_PROTOCOL_ERROR')
  if (value.error || value.base_resp?.status_code || value.code && value.code !== 'Success' && value.message || value.output?.task_status === 'FAILED') throw pluginError('PLUGIN_PROVIDER_REJECTED')
  return value
}
export interface MediaAsset { bytes?: Buffer; url?: string; mediaType: string }
function actualMediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm'
  if (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224) return 'audio/mpeg'
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
  throw pluginError('PLUGIN_MEDIA_TYPE_INVALID')
}
export async function materialize(c: ResolvedConnection, asset: MediaAsset, signal: AbortSignal): Promise<{ bytes: Buffer; mediaType: string }> {
  if (asset.bytes) {
    if (!asset.bytes.length || asset.bytes.length > MAX_MEDIA_BYTES) throw pluginError('PLUGIN_RESPONSE_TOO_LARGE')
    return { bytes: asset.bytes, mediaType: actualMediaType(asset.bytes) }
  }
  if (!asset.url) throw pluginError('PLUGIN_EMPTY_RESULT')
  let url: URL
  try { url = new URL(asset.url, c.baseURL + '/') } catch { throw pluginError('PLUGIN_PROTOCOL_ERROR') }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw pluginError('PLUGIN_PROTOCOL_ERROR')
  const sameOrigin = url.origin === new URL(c.baseURL).origin
  if (sameOrigin && c.adapter === 'custom' && !url.pathname.startsWith(new URL(c.baseURL).pathname.replace(/\/$/, '') + '/files/')) throw pluginError('PLUGIN_DOWNLOAD_TARGET_DENIED')
  if (!sameOrigin) try { await assertPublicNetworkUrl(url.href) } catch { throw pluginError('PLUGIN_DOWNLOAD_TARGET_DENIED') }
  guardPluginNetwork('continue')
  const response = await fetch(url, { signal, redirect: 'manual', headers: sameOrigin ? headers(c) : {} }).catch(() => { throw pluginError('PLUGIN_DOWNLOAD_FAILED') })
  if (!response.ok) { await response.body?.cancel(); throw pluginError('PLUGIN_DOWNLOAD_FAILED') }
  const bytes = await boundedBytes(response)
  if (!bytes.length) throw pluginError('PLUGIN_EMPTY_RESULT')
  return { bytes, mediaType: actualMediaType(bytes) }
}
export function base64(data: string): Buffer {
  if (data.length > MAX_MEDIA_BYTES * 1.4 || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(data)) throw pluginError('PLUGIN_PROTOCOL_ERROR')
  const result = Buffer.from(data, 'base64')
  if (!result.length || result.length > MAX_MEDIA_BYTES) throw pluginError('PLUGIN_RESPONSE_TOO_LARGE')
  return result
}
export function wav(pcm: Buffer, rate = 24000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
