import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VoiceService } from '../packages/server/src/voice/service.js'
import { encodeWav } from '../packages/desktop/src/voice/engine.mjs'
const roots:string[]=[],servers:Server[]=[]
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function setup(){const root=await mkdtemp(join(tmpdir(),'pulse-voice-test-'));roots.push(root);return {root,voice:new VoiceService(root)}}
it('defaults wake off for existing configs and persists opt-in and opt-out across restart',async()=>{
 const {root,voice}=await setup();expect((await voice.config()).wakeEnabled).toBe(false)
 const original=await voice.save({enabled:true,name:'Pulse'});expect(original.wakeEnabled).toBe(false)
 await voice.save({...original,wakeEnabled:true});expect((await new VoiceService(root).config()).wakeEnabled).toBe(true)
 await voice.save({...original,wakeEnabled:false});expect((await new VoiceService(root).config()).wakeEnabled).toBe(false)
})
it('is disabled by default, persists service configuration and keeps keys out of settings',async()=>{
 const {root,voice}=await setup();expect((await voice.config()).enabled).toBe(false)
 const config=await voice.save({enabled:true,asr:{baseURL:'http://127.0.0.1:8000/v1',model:'whisper'},asrKey:'fixture-secret'})
 expect(JSON.stringify(config)).not.toContain('fixture-secret');expect(await voice.credentials.get(config.asr.credentialRef!)).toBe('fixture-secret')
 expect(await readFile(join(root,'voice/config.json'),'utf8')).not.toContain('fixture-secret')
 expect((await new VoiceService(root).config()).enabled).toBe(true)
 await expect(voice.save({asr:{baseURL:'http://remote.example/v1'}})).rejects.toThrow('REQUIRES_HTTPS')
})
it('uses compatible multipart ASR and authenticated TTS and rejects malformed recordings',async()=>{
 const requests:Array<{url?:string;auth?:string;body:string}>=[];const wav=encodeWav(new Float32Array(1600))
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push({url:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});if(req.url?.endsWith('transcriptions'))res.end(JSON.stringify({text:'你好 Pulse'}));else if(req.url?.endsWith('speech'))res.end(Buffer.from(wav,'base64'));else res.end(JSON.stringify({data:[{id:'fixture'}]}))});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const baseURL=`http://127.0.0.1:${(server.address() as any).port}/v1`
 const {voice}=await setup();await voice.save({asr:{baseURL,model:'whisper'},tts:{baseURL,model:'kokoro',voice:'zf_xiaobei'},ttsKey:'fixture-key'})
 expect(await voice.transcribe(wav)).toEqual({text:'你好 Pulse'});expect(requests[0]?.body).toContain('name="model"');expect(requests[0]?.body).toContain('speech.wav')
 expect(await voice.speech('你好')).toMatchObject({audio:wav,mime:'audio/wav'});expect(requests[1]?.auth).toBe('Bearer fixture-key');expect(JSON.parse(requests[1]!.body)).toMatchObject({input:'你好',voice:'zf_xiaobei'})
 await expect(voice.transcribe('not-wav')).rejects.toThrow('VOICE_AUDIO_INVALID');expect(await voice.test('asr')).toEqual({ok:true,models:['fixture']})
 const saved = await voice.config()
 await voice.save({...saved,asr:{...saved.asr,language:'auto'}})
 await voice.transcribe(wav);expect(requests.at(-1)?.body).not.toContain('name="language"')
 await voice.save({...saved,asr:{...saved.asr,language:'zh-Hant'}})
 await voice.transcribe(wav);expect(requests.at(-1)?.body).toMatch(/name="language"\r\n\r\nzh\r\n/)
})
it('keeps a saved key when the field is blank and deletes it only for an explicit null', async () => {
 const { voice } = await setup()
 const saved = await voice.save({ asr: { baseURL: 'http://127.0.0.1:8000/v1', model: 'whisper' }, tts: { baseURL: 'http://127.0.0.1:8000/v1', model: 'kokoro' }, asrKey: 'asr-secret', ttsKey: 'tts-secret' })
 const asrRef = saved.asr.credentialRef, ttsRef = saved.tts.credentialRef
 const kept = await voice.save({ ...saved, name: 'Pulse', asrKey: '', ttsKey: '   ' })
 expect(kept.asr.credentialRef).toBe(asrRef)
 expect(kept.tts.credentialRef).toBe(ttsRef)
 expect(await voice.credentials.get(asrRef!)).toBe('asr-secret')
 expect(await voice.credentials.get(ttsRef!)).toBe('tts-secret')
 const removedAsr = await voice.save({ ...kept, asrKey: null })
 expect(removedAsr.asr.credentialRef).toBeUndefined()
 expect(removedAsr.tts.credentialRef).toBe(ttsRef)
 const removedTts = await voice.save({ ...removedAsr, ttsKey: null })
 expect(removedTts.tts.credentialRef).toBeUndefined()
 expect(JSON.stringify(await voice.config())).not.toContain('asr-secret')
 expect(JSON.stringify(await voice.config())).not.toContain('tts-secret')
})
it('selects local ASR and TTS atomically, preserves credentials and prevents remote fallback', async () => {
 const { root, voice } = await setup()
 const original = await voice.save({ enabled: true, name: '小助手', followupSeconds: 45, asr: { baseURL: 'http://127.0.0.1:9000/v1', model: 'remote-asr', language: 'zh' }, tts: { baseURL: 'http://127.0.0.1:9001/v1', model: 'remote-tts', speed: 1.2 }, asrKey: 'kept-key' })
 const [asr, tts] = await Promise.all([voice.useLocal('asr'), voice.useLocal('tts')])
 expect(asr).toMatchObject({ backend: 'local', model: 'pulse-sensevoice-small', language: 'zh', credentialRef: original.asr.credentialRef })
 expect(tts).toMatchObject({ backend: 'local', model: 'pulse-kokoro-zh-en', voice: '45', speed: 1.2 })
 const saved = await new VoiceService(root).config()
 expect(saved).toMatchObject({ enabled: true, name: '小助手', followupSeconds: 45, asr, tts })
 expect(await voice.credentials.get(asr.credentialRef!)).toBe('kept-key')
 await expect(voice.test('asr')).rejects.toThrow('VOICE_DESKTOP_REQUIRED')
 await expect(voice.speech('测试')).rejects.toThrow('VOICE_DESKTOP_REQUIRED')
 // Returning to a compatible service remains supported without removing its key.
 const external = await voice.save({ ...saved, asr: { ...asr, backend: 'external', model: 'remote-asr' } })
 expect(external.asr.baseURL).toBe(original.asr.baseURL)
 expect(external.asr.credentialRef).toBe(original.asr.credentialRef)
})
it('defaults old configurations to automatic speech and persists an explicit opt-out', async () => {
 const { root, voice } = await setup()
 expect((await voice.config()).autoSpeak).toBe(true)
 const config = await voice.save({ enabled: true, name: 'Pulse', asrKey: 'kept-key' })
 expect(config.autoSpeak).toBe(true)
 await voice.save({ ...config, autoSpeak: false })
 const restarted = await new VoiceService(root).config()
 expect(restarted.autoSpeak).toBe(false)
 expect(restarted.asr.credentialRef).toBe(config.asr.credentialRef)
})
it('preserves a selected local voice when upgrading the TTS model', async () => {
 const { voice } = await setup()
 const config = await voice.save({ tts: { backend: 'local', model: 'pulse-kokoro-zh-en', voice: '47', speed: 1.1 } })
 expect(await voice.useLocal('tts')).toMatchObject({ voice: config.tts.voice, speed: 1.1 })
})
