import { expect, it } from 'vitest'
import { desktopServiceJson } from '../packages/desktop/src/service-http.mjs'

it('identifies the empty response returned by older voice routers before downloading', async () => {
  for (const status of [400, 404, 405]) {
    await expect(desktopServiceJson(new Response(null, { status }), '/api/voice/local')).rejects.toThrow('VOICE_LOCAL_BACKEND_UPDATE_REQUIRED')
  }
})
it('preserves specific voice errors instead of labeling every failed installation as an upgrade issue', async () => {
  await expect(desktopServiceJson(Response.json({ error: 'VOICE_CONFIGURATION_OR_SERVICE_FAILED' }, { status: 400 }), '/api/voice/local')).rejects.toThrow('VOICE_CONFIGURATION_OR_SERVICE_FAILED')
  await expect(desktopServiceJson(Response.json({ error: 'VOICE_ASR_HTTP_401' }, { status: 400 }), '/api/voice/test')).rejects.toThrow('VOICE_ASR_HTTP_401')
})
it('keeps authentication failures and unrelated bad requests distinct', async () => {
  await expect(desktopServiceJson(new Response(null, { status: 403 }), '/api/voice/local')).rejects.toThrow('API_403')
  await expect(desktopServiceJson(new Response(null, { status: 400 }), '/api/voice/config')).rejects.toThrow('API_400')
})
it('does not expose unstructured backend text through desktop errors', async () => {
  await expect(desktopServiceJson(Response.json({ error: 'upstream private response' }, { status: 500 }), '/api/voice/speech')).rejects.toThrow('API_500')
})
it('returns successful structured data unchanged', async () => {
  await expect(desktopServiceJson(Response.json({ backend: 'local', model: 'pulse-whisper-base' }), '/api/voice/local')).resolves.toEqual({ backend: 'local', model: 'pulse-whisper-base' })
})
