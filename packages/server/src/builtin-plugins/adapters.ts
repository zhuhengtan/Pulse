import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { type MediaKind, type ResolvedConnection } from './config.js'
import { base64, guardPluginNetwork, headers, MAX_MEDIA_BYTES, pluginError, request, wav, type MediaAsset } from './http.js'

export interface MediaInput { prompt: string; parameters?: Record<string, unknown> | undefined; referenceImages?: string[] | undefined }
export interface ReferenceImage { bytes: Buffer; mediaType: string }
export interface RemoteTicket { id: string; provider: ResolvedConnection['adapter'] }
export interface RemoteResult { ticket?: RemoteTicket; asset?: MediaAsset; state?: 'queued' | 'running' }
const dataURL = (ref: ReferenceImage) => 'data:' + ref.mediaType + ';base64,' + ref.bytes.toString('base64')
const segment = (id: string) => encodeURIComponent(id)
const minimaxVideo = (c: ResolvedConnection): ResolvedConnection => ({ ...c, baseURL: c.baseURL.replace(/\/v1$/, '/v2') })

function inline(value: any, kind: MediaKind, depth = 0): MediaAsset | undefined {
  if (!value || typeof value !== 'object' || depth > 20) return undefined
  const mime = value.mimeType ?? value.mime_type ?? value.mediaType
  if (typeof value.data === 'string' && typeof mime === 'string' && /^(image|audio|video)\//.test(mime)) {
    const bytes = base64(value.data)
    return /^audio\/(?:L16|pcm)/i.test(mime) ? { bytes: wav(bytes, Number(mime.match(/rate=(\d+)/)?.[1]) || 24000), mediaType: 'audio/wav' } : { bytes, mediaType: mime.split(';')[0]! }
  }
  for (const child of Object.values(value)) { const found = inline(child, kind, depth + 1); if (found) return found }
  return undefined
}
function imageAsset(value: any): MediaAsset {
  const row = value.data?.[0] ?? value.data
  const b64 = row?.b64_json ?? row?.image_base64?.[0] ?? row?.image_base64
  if (typeof b64 === 'string') return { bytes: base64(b64), mediaType: 'image/png' }
  const url = row?.url ?? row?.image_urls?.[0] ?? value.output?.results?.[0]?.url ?? value.output?.choices?.[0]?.message?.content?.find((p: any) => p.image)?.image
  if (typeof url !== 'string') throw pluginError('PLUGIN_EMPTY_RESULT')
  return { url, mediaType: 'image/png' }
}
function customResult(value: any, c: ResolvedConnection): RemoteResult {
  if (value.status === 'failed' || value.status === 'cancelled') throw pluginError('PLUGIN_PROVIDER_REJECTED')
  if (value.status === 'succeeded') {
    const row = value.outputs?.[0]
    if (!row || typeof row.mediaType !== 'string' || !/^(image|audio|video)\//.test(row.mediaType)) throw pluginError('PLUGIN_PROTOCOL_ERROR')
    return { asset: typeof row.dataBase64 === 'string' ? { bytes: base64(row.dataBase64), mediaType: row.mediaType } : typeof row.url === 'string' ? { url: row.url, mediaType: row.mediaType } : (() => { throw pluginError('PLUGIN_PROTOCOL_ERROR') })() }
  }
  if (!['queued', 'running'].includes(value.status) || typeof value.id !== 'string' || !value.id || value.id.length > 500) throw pluginError('PLUGIN_PROTOCOL_ERROR')
  return { ticket: { id: value.id, provider: c.adapter }, state: value.status }
}

export async function startGeneration(c: ResolvedConnection, kind: MediaKind, input: MediaInput, images: ReferenceImage[], signal: AbortSignal): Promise<RemoteResult> {
  const p = { ...c.defaults, ...input.parameters } as Record<string, any>
  // No transport or credential fields are ever taken from model parameters.
  for (const key of ['url', 'baseURL', 'apiKey', 'authorization', 'headers', 'model', 'workflow']) if (key in p) throw pluginError('PLUGIN_PARAMETER_FORBIDDEN')
  if (c.adapter === 'custom') return customResult(await request(c, '/generate', signal, { kind, model: c.model, prompt: input.prompt, parameters: p, inputs: images.map(r => ({ mediaType: r.mediaType, dataBase64: r.bytes.toString('base64') })) }), c)
  if (c.adapter === 'comfyui') {
    if (!c.workflow || !c.mappings) throw pluginError('PLUGIN_WORKFLOW_REQUIRED')
    const workflow = structuredClone(c.workflow) as Record<string, any>
    const assign = (m: { node: string; input: string } | undefined, value: unknown) => { if (!m || !Object.hasOwn(workflow, m.node) || !workflow[m.node]?.inputs || ['__proto__', 'constructor', 'prototype'].includes(m.input)) throw pluginError('PLUGIN_WORKFLOW_MAPPING_INVALID'); workflow[m.node].inputs[m.input] = value }
    assign(c.mappings.prompt, input.prompt)
    if (c.mappings.model) assign(c.mappings.model, c.model)
    if (images.length) {
      if (!c.mappings.image || images.length !== 1) throw pluginError('PLUGIN_REFERENCE_UNSUPPORTED')
      const form = new FormData(); form.set('image', new Blob([new Uint8Array(images[0]!.bytes)], { type: images[0]!.mediaType }), randomUUID() + '.png'); form.set('overwrite', 'false')
      const uploaded = await request(c, '/upload/image', signal, form)
      if (typeof uploaded.name !== 'string' || uploaded.name.includes('..') || uploaded.name.includes('/')) throw pluginError('PLUGIN_PROTOCOL_ERROR')
      assign(c.mappings.image, uploaded.name)
    }
    const body = await request(c, '/prompt', signal, { prompt: workflow, client_id: randomUUID() })
    if (typeof body.prompt_id !== 'string') throw pluginError('PLUGIN_PROTOCOL_ERROR')
    return { ticket: { id: body.prompt_id, provider: c.adapter }, state: 'queued' }
  }
  if (kind === 'image') {
    if (c.adapter === 'google') {
      if (/^imagen/.test(c.model)) {
        if (images.length) throw pluginError('PLUGIN_REFERENCE_UNSUPPORTED')
        const body = await request(c, '/models/' + segment(c.model) + ':predict', signal, { instances: [{ prompt: input.prompt }], parameters: { sampleCount: 1, ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}) } })
        const row = body.predictions?.[0]
        if (typeof row?.bytesBase64Encoded !== 'string') throw pluginError('PLUGIN_EMPTY_RESULT')
        return { asset: { bytes: base64(row.bytesBase64Encoded), mediaType: row.mimeType ?? 'image/png' } }
      }
      const body = await request(c, '/models/' + segment(c.model) + ':generateContent', signal, { contents: [{ parts: [{ text: input.prompt }, ...images.map(r => ({ inlineData: { mimeType: r.mediaType, data: r.bytes.toString('base64') } }))] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(p.aspectRatio || p.imageSize ? { imageConfig: { ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}), ...(p.imageSize ? { imageSize: p.imageSize } : {}) } } : {}) } })
      const asset = inline(body, kind); if (!asset) throw pluginError('PLUGIN_EMPTY_RESULT'); return { asset }
    }
    if (c.adapter === 'bailian') {
      const body = await request(c, '/services/aigc/multimodal-generation/generation', signal, { model: c.model, input: { messages: [{ role: 'user', content: [...images.map(r => ({ image: dataURL(r) })), { text: input.prompt }] }] }, parameters: { n: 1, ...(p.size ? { size: p.size } : {}), ...(p.seed !== undefined ? { seed: p.seed } : {}) } })
      return { asset: imageAsset(body) }
    }
    if (c.adapter === 'minimax') return { asset: imageAsset(await request(c, '/image_generation', signal, { model: c.model, prompt: input.prompt, n: 1, response_format: 'base64', ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}), ...(images.length ? { subject_reference: images.map(r => ({ type: 'character', image_file: dataURL(r) })) } : {}) })) }
    if (c.adapter === 'volcengine') return { asset: imageAsset(await request(c, '/images/generations', signal, { model: c.model, prompt: input.prompt, response_format: 'b64_json', ...(p.size ? { size: p.size } : {}), ...(p.seed !== undefined ? { seed: p.seed } : {}), ...(images.length ? { image: images.map(dataURL) } : {}) })) }
    if (images.length) {
      const form = new FormData(); form.set('model', c.model); form.set('prompt', input.prompt); form.set('n', '1')
      if (p.size) form.set('size', String(p.size))
      images.forEach((r, i) => form.append('image[]', new Blob([new Uint8Array(r.bytes)], { type: r.mediaType }), 'reference-' + i + '.png'))
      return { asset: imageAsset(await request(c, '/images/edits', signal, form)) }
    }
    return { asset: imageAsset(await request(c, '/images/generations', signal, { model: c.model, prompt: input.prompt, n: 1, ...(p.size ? { size: p.size } : {}), ...(p.quality ? { quality: p.quality } : {}) })) }
  }
  if (kind === 'video') {
    let body: any
    if (c.adapter === 'google') {
      body = await request(c, '/models/' + segment(c.model) + ':predictLongRunning', signal, { instances: [{ prompt: input.prompt, ...(images[0] ? { image: { bytesBase64Encoded: images[0].bytes.toString('base64'), mimeType: images[0].mediaType } } : {}) }], parameters: { ...(p.duration ? { durationSeconds: p.duration } : {}), ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}), sampleCount: 1 } })
      if (typeof body.name !== 'string' || !/^operations\/[A-Za-z0-9_.-]+$/.test(body.name)) throw pluginError('PLUGIN_PROTOCOL_ERROR')
      return { ticket: { id: body.name.slice(11), provider: c.adapter }, state: 'queued' }
    }
    if (c.adapter === 'volcengine') body = await request(c, '/contents/generations/tasks', signal, { model: c.model, content: [{ type: 'text', text: input.prompt }, ...images.map(r => ({ type: 'image_url', image_url: { url: dataURL(r) }, role: 'first_frame' }))], ...(p.duration ? { duration: p.duration } : {}), ...(p.aspectRatio ? { ratio: p.aspectRatio } : {}) })
    else if (c.adapter === 'bailian') {
      // DashScope async creation requires this protocol header.
      body = await dashscopeVideo(c, input, images, p, signal)
    } else if (c.adapter === 'minimax') body = await request(minimaxVideo(c), '/video_generation', signal, { model: c.model, content: [{ type: 'text', text: input.prompt }, ...images.map(r => ({ type: 'image_url', image_url: { url: dataURL(r) }, role: 'first_frame' }))], ...(p.duration ? { duration: p.duration } : {}), ...(p.resolution ? { resolution: p.resolution } : {}) })
    else {
      const form = new FormData(); form.set('model', c.model); form.set('prompt', input.prompt)
      if (p.duration) form.set('seconds', String(p.duration)); if (p.size) form.set('size', String(p.size))
      if (images[0]) form.set('input_reference', new Blob([new Uint8Array(images[0].bytes)], { type: images[0].mediaType }), 'reference.png')
      body = await request(c, '/videos', signal, form)
    }
    const id = body.id ?? body.task_id ?? body.output?.task_id
    if (typeof id !== 'string') throw pluginError('PLUGIN_PROTOCOL_ERROR')
    return { ticket: { id, provider: c.adapter }, state: 'queued' }
  }
  if (images.length) throw pluginError('PLUGIN_REFERENCE_UNSUPPORTED')
  if (c.adapter === 'elevenlabs') {
    const route = kind === 'speech' ? '/text-to-speech/' + segment(String(p.voice ?? '')) : kind === 'music' ? '/music' : '/sound-generation'
    if (kind === 'speech' && !p.voice) throw pluginError('PLUGIN_VOICE_REQUIRED')
    const body = kind === 'speech' ? { model_id: c.model, text: input.prompt, ...(p.speed ? { voice_settings: { speed: p.speed } } : {}) } : kind === 'music' ? { model_id: c.model, prompt: input.prompt, ...(p.duration ? { music_length_ms: p.duration * 1000 } : {}), force_instrumental: p.instrumental === true } : { model_id: c.model, text: input.prompt, ...(p.duration ? { duration_seconds: p.duration } : {}), loop: p.loop === true }
    return { asset: await request(c, route, signal, body, 'POST', true) }
  }
  if (c.adapter === 'google') {
    const body = kind === 'music'
      ? await request(c, '/interactions', signal, { model: c.model, input: input.prompt, response_format: { type: 'audio' } })
      : await request(c, '/models/' + segment(c.model) + ':generateContent', signal, { contents: [{ parts: [{ text: input.prompt }] }], generationConfig: { responseModalities: ['AUDIO'], ...(p.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } } } : {}) } })
    const asset = inline(body, kind); if (!asset) throw pluginError('PLUGIN_EMPTY_RESULT'); return { asset }
  }
  if (c.adapter === 'minimax') {
    const body = kind === 'music' ? await request(c, '/music_generation', signal, { model: c.model, prompt: input.prompt, lyrics: p.lyrics ?? '', output_format: 'hex', audio_setting: { format: 'mp3' } }) : await request(c, '/t2a_v2', signal, { model: c.model, text: input.prompt, stream: false, output_format: 'hex', voice_setting: { voice_id: p.voice ?? 'English_Graceful_Lady', speed: p.speed ?? 1 }, audio_setting: { format: 'mp3' } })
    const hex = body.data?.audio
    if (typeof hex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(hex) || hex.length > MAX_MEDIA_BYTES * 2) throw pluginError('PLUGIN_PROTOCOL_ERROR')
    return { asset: { bytes: Buffer.from(hex, 'hex'), mediaType: 'audio/mpeg' } }
  }
  if (c.adapter === 'bailian') {
    const body = await request(c, '/services/audio/tts/SpeechSynthesizer', signal, { model: c.model, input: { text: input.prompt, ...(p.voice ? { voice: p.voice } : {}) }, parameters: { format: 'wav', ...(p.speed ? { speech_rate: p.speed } : {}) } })
    const url = body.output?.audio?.url ?? body.output?.audio_url
    if (typeof url !== 'string') throw pluginError('PLUGIN_EMPTY_RESULT')
    return { asset: { url, mediaType: 'audio/wav' } }
  }
  if (c.adapter === 'openai' && openaiSpeechChannel(c) === 'realtime') return { asset: await realtimeSpeech(c, input.prompt, p.voice ?? 'marin', signal) }
  return { asset: await request(c, '/audio/speech', signal, { model: c.model, input: input.prompt, voice: p.voice ?? 'alloy', response_format: 'mp3', ...(p.speed ? { speed: p.speed } : {}) }, 'POST', true) }
}

async function dashscopeVideo(c: ResolvedConnection, input: MediaInput, images: ReferenceImage[], p: Record<string, any>, signal: AbortSignal) {
  guardPluginNetwork('submit')
  const response = await fetch(c.baseURL + '/services/aigc/video-generation/video-synthesis', { method: 'POST', redirect: 'manual', signal, headers: { ...headers(c), 'content-type': 'application/json', 'X-DashScope-Async': 'enable' }, body: JSON.stringify({ model: c.model, input: { prompt: input.prompt, ...(images[0] ? { img_url: dataURL(images[0]) } : {}) }, parameters: { ...(p.duration ? { duration: p.duration } : {}), ...(p.size ? { size: p.size } : {}) } }) })
  if (!response.ok) { await response.body?.cancel(); throw pluginError(response.status === 401 || response.status === 403 ? 'PLUGIN_AUTH_FAILED' : 'PLUGIN_HTTP_' + response.status) }
  const { boundedBytes } = await import('./http.js')
  try { return JSON.parse((await boundedBytes(response, 1_000_000)).toString()) } catch { throw pluginError('PLUGIN_PROTOCOL_ERROR') }
}

export async function pollGeneration(c: ResolvedConnection, ticket: RemoteTicket, kind: MediaKind, signal: AbortSignal): Promise<RemoteResult> {
  const id = segment(ticket.id)
  if (c.adapter === 'custom') return customResult(await request(c, '/jobs/' + id, signal), c)
  if (c.adapter === 'comfyui') {
    const history = (await request(c, '/history/' + id, signal))[ticket.id]
    if (!history) return { ticket, state: 'running' }
    if (history.status?.status_str === 'error') throw pluginError('PLUGIN_PROVIDER_REJECTED')
    const output = history.outputs?.[c.mappings!.outputNode]
    const file = output?.images?.[0] ?? output?.gifs?.[0] ?? output?.audio?.[0] ?? output?.videos?.[0]
    if (!file) { if (history.status?.completed) throw pluginError('PLUGIN_EMPTY_RESULT'); return { ticket, state: 'running' } }
    if (typeof file.filename !== 'string' || /[/\\]/.test(file.filename) || String(file.subfolder ?? '').split(/[/\\]/).includes('..')) throw pluginError('PLUGIN_PROTOCOL_ERROR')
    return { asset: { url: c.baseURL + '/view?' + new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: 'output' }), mediaType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav' } }
  }
  if (c.adapter === 'google') {
    const body = await request(c, '/operations/' + id, signal)
    if (!body.done) return { ticket, state: 'running' }
    const url = body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ?? body.response?.generatedVideos?.[0]?.video?.uri
    if (typeof url !== 'string') throw pluginError('PLUGIN_EMPTY_RESULT')
    return { asset: { url, mediaType: 'video/mp4' } }
  }
  const route = c.adapter === 'volcengine' ? '/contents/generations/tasks/' + id : c.adapter === 'bailian' ? '/tasks/' + id : c.adapter === 'minimax' ? '/query/video_generation/' + id : '/videos/' + id
  const body = await request(c.adapter === 'minimax' ? minimaxVideo(c) : c, route, signal)
  const state = String(body.status ?? body.output?.task_status ?? '').toLowerCase()
  if (['failed', 'canceled', 'cancelled', 'expired', 'fail'].includes(state)) throw pluginError('PLUGIN_PROVIDER_REJECTED')
  if (!['completed', 'succeeded', 'success'].includes(state)) return { ticket, state: 'running' }
  const url = body.content?.video_url ?? body.content?.url ?? body.output?.video_url
  if (c.adapter === 'openai') return { asset: { ...(await request(c, '/videos/' + id + '/content', signal, undefined, 'GET', true)), mediaType: 'video/mp4' } }
  if (typeof url !== 'string') throw pluginError('PLUGIN_EMPTY_RESULT')
  return { asset: { url, mediaType: 'video/mp4' } }
}

export async function cancelGeneration(c: ResolvedConnection, ticket: RemoteTicket, signal: AbortSignal): Promise<boolean> {
  const id = segment(ticket.id)
  if (c.adapter === 'custom') { await request(c, '/jobs/' + id, signal, undefined, 'DELETE'); return true }
  if (c.adapter === 'volcengine') { await request(c, '/contents/generations/tasks/' + id, signal, undefined, 'DELETE'); return true }
  if (c.adapter === 'minimax') { await request(minimaxVideo(c), '/video_generation/' + id, signal, undefined, 'DELETE'); return true }
  if (c.adapter === 'comfyui') {
    const queue = await request(c, '/queue', signal, undefined, 'GET', false, 'cancel')
    if (queue.queue_pending?.some((item: any[]) => item[1] === ticket.id)) { await request(c, '/queue', signal, { delete: [ticket.id] }, 'POST', false, 'cancel'); return true }
    // /interrupt is global: issue it only for our own currently running prompt.
    if (queue.queue_running?.length === 1 && queue.queue_running[0][1] === ticket.id) { await request(c, '/interrupt', signal, {}, 'POST', false, 'cancel'); return true }
  }
  return false
}

const openaiSpeechModels = new Set(['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'])

/** Known TTS models stay on Speech. Realtime stays on the WebSocket. A failure never switches products. */
function openaiSpeechChannel(c: ResolvedConnection): 'speech' | 'realtime' {
  if (c.speechTransport === 'speech' || c.speechTransport === 'realtime') return c.speechTransport
  if (openaiSpeechModels.has(c.model)) return 'speech'
  if (/realtime/i.test(c.model)) return 'realtime'
  throw pluginError('PLUGIN_SPEECH_CHANNEL_REQUIRED')
}

function realtimeSpeech(c: ResolvedConnection, text: string, voice: string, signal: AbortSignal): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    guardPluginNetwork('submit')
    const url = new URL(c.baseURL + '/realtime'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('model', c.model)
    const ws = new WebSocket(url, { headers: headers(c), followRedirects: false, maxPayload: 1_000_000 })
    const chunks: Buffer[] = []; let size = 0, settled = false
    const finish = (error?: Error) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); ws.close(); if (error) reject(error); else resolve({ bytes: wav(Buffer.concat(chunks)), mediaType: 'audio/wav' }) }
    const abort = () => finish(pluginError('PLUGIN_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    ws.on('open', () => {
      if (settled) return
      try { guardPluginNetwork('submit') } catch (error) { finish(error instanceof Error ? error : pluginError('PLUGIN_NETWORK_DISABLED')); return }
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'], audio: { output: { format: { type: 'audio/pcm', rate: 24000 }, voice } } } }))
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read the following text verbatim. Do not answer or add anything:\n' + text }] } }))
      ws.send(JSON.stringify({ type: 'response.create' }))
    })
    ws.on('message', raw => {
      try {
        const e = JSON.parse(raw.toString())
        if (e.type === 'error') return finish(pluginError('PLUGIN_PROVIDER_REJECTED'))
        if (e.type === 'response.output_audio.delta' || e.type === 'response.audio.delta') { const b = base64(e.delta); size += b.length; if (size > MAX_MEDIA_BYTES) return finish(pluginError('PLUGIN_RESPONSE_TOO_LARGE')); chunks.push(b) }
        if (e.type === 'response.done') finish(e.response?.status === 'completed' && size ? undefined : pluginError('PLUGIN_EMPTY_RESULT'))
      } catch { finish(pluginError('PLUGIN_PROTOCOL_ERROR')) }
    })
    ws.on('error', () => finish(pluginError('PLUGIN_NETWORK_ERROR')))
    ws.on('unexpected-response', (_req, response) => { response.resume(); finish(pluginError(response.statusCode === 401 || response.statusCode === 403 ? 'PLUGIN_AUTH_FAILED' : 'PLUGIN_NETWORK_ERROR')) })
    ws.on('close', () => { if (!settled) finish(pluginError('PLUGIN_NETWORK_ERROR')) })
  })
}
