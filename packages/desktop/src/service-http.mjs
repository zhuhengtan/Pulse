export function desktopServiceTimeout(method, requestPath) {
  const path = String(requestPath ?? '').split('?')[0]
  if (method === 'POST' && (path === '/api/voice/transcribe' || path === '/api/voice/speech')) return 60_000
  if (method === 'POST' && /^\/api\/conversations\/[^/]+\/messages$/.test(path)) return 25_000
  return 10_000
}

export function desktopServiceFetch(url, init, timeoutMs) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
}

export async function desktopServiceJson(response, requestPath) {
  if (response.ok) return response.json()
  const body = await response.json().catch(() => undefined)
  // Forward bounded server error codes, never raw response bodies or credentials.
  const code = typeof body?.error === 'string' && /^[A-Z][A-Z0-9_]{1,119}$/.test(body.error) ? body.error : undefined
  if (code) throw new Error(code)
  // Older voice routers return an empty 400 for routes they do not recognize.
  if (requestPath === '/api/voice/local' && [400, 404, 405].includes(response.status)) throw new Error('VOICE_LOCAL_BACKEND_UPDATE_REQUIRED')
  throw new Error(`API_${response.status}`)
}
