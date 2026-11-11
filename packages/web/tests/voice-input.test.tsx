import { afterEach, expect, it, vi } from 'vitest'
import { VoiceInputSession, dictationWave, dictationError } from '../src/voice-input.js'
import { dictationAudio } from './fixtures/dictation-audio.js'
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
it('explains a stale desktop separately from an invalid dictation session',()=>{
 expect(dictationError(new Error('VOICE_ACTION_INVALID'))).toContain('桌面主进程尚未加载')
 expect(dictationError(new Error('VOICE_DICTATION_INVALID'))).toContain('松开后重新按住')
 expect(dictationError(new Error('VOICE_DICTATION_BUSY'))).toContain('另一个语音输入')
})
function fixture(desktop=false){
 const audio=dictationAudio(),onText=vi.fn(),onPhase=vi.fn(),onError=vi.fn()
 const request=vi.fn(async(path:string)=>Response.json(path==='/api/voice/config'?{microphoneId:'chosen-mic',asr:{model:'fixture'}}:path==='/api/voice/transcribe'?{text:'识别内容'}:{ok:true}))
 const session=new VoiceInputSession({transport:{request,subscribe:()=>()=>{}},desktop,onText,onPhase,onError})
 return{audio,session,request,onText,onPhase,onError}
}
it('starts interim recognition within 1.3 seconds and releases capture before slow ASR finishes',async()=>{
 const f=fixture();let finish!:(value:Response)=>void
 f.request.mockImplementation(async path=>path.endsWith('transcribe')?new Promise(done=>{finish=done}):Response.json({microphoneId:'',asr:{model:'fixture'}}))
 await f.session.start();f.audio.speech(4)
 expect(f.request.mock.calls.filter(([path])=>path.endsWith('transcribe'))).toHaveLength(0)
 f.audio.speech(1);await vi.waitFor(()=>expect(finish).toBeDefined())
 f.session.stop();expect(f.audio.stop).toHaveBeenCalledOnce();expect(f.onText).not.toHaveBeenCalled()
 finish(Response.json({text:'完整一句'}));await vi.waitFor(()=>expect(f.onPhase).toHaveBeenLastCalledWith('idle'))
 expect(f.onText).toHaveBeenCalledWith({segment:0,text:'完整一句'})
 expect(f.request.mock.calls.filter(([path])=>path.endsWith('transcribe'))).toHaveLength(1)
})
it('writes valid bounded mono WAV and progressively replaces a segment before release',async()=>{
 const f=fixture();await f.session.start();f.audio.speech(5)
 await vi.waitFor(()=>expect(f.onText).toHaveBeenCalledWith({segment:0,text:'识别内容'}))
 f.audio.speech(2);f.session.stop()
 await vi.waitFor(()=>expect(f.onPhase).toHaveBeenLastCalledWith('idle'))
 expect(f.onText).toHaveBeenCalledTimes(2);expect(f.onText.mock.calls.map(([value])=>value.segment)).toEqual([0,0])
 expect(f.request.mock.calls.every(([path])=>!path.includes('assistant'))).toBe(true)
 expect(f.audio.stop).toHaveBeenCalledOnce();expect(f.audio.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({audio:expect.objectContaining({deviceId:{exact:'chosen-mic'}})}))
 const wav=Uint8Array.from(atob(dictationWave(Float32Array.of(0,.5,-.5))),ch=>ch.charCodeAt(0)),header=new DataView(wav.buffer)
 expect(header.getUint32(24,true)).toBe(16000);expect(header.getUint16(22,true)).toBe(1);expect(header.getInt16(46,true)).toBeCloseTo(16384,0)
})
it('finalizes paused speech while still held and does not transcribe silence',async()=>{
 const f=fixture();await f.session.start();f.audio.emit(new Float32Array(16000));expect(f.request).toHaveBeenCalledOnce()
 f.audio.speech(2);for(let i=0;i<3;i++)f.audio.emit(new Float32Array(4096))
 await vi.waitFor(()=>expect(f.onText).toHaveBeenCalledOnce());expect(f.onPhase).toHaveBeenLastCalledWith('recording')
 f.session.stop();await vi.waitFor(()=>expect(f.onPhase).toHaveBeenLastCalledWith('idle'));expect(f.onText).toHaveBeenCalledOnce()
})
it('releases a microphone granted after the hold was released, without transcribing it',async()=>{
 const f=fixture();let grant!:(value:any)=>void;f.audio.getUserMedia.mockReturnValue(new Promise(resolve=>{grant=resolve}))
 const starting=f.session.start();await vi.waitFor(()=>expect(f.audio.getUserMedia).toHaveBeenCalledOnce());f.session.stop();grant(f.audio.stream);await starting
 expect(f.audio.stop).toHaveBeenCalledOnce();expect(f.onText).not.toHaveBeenCalled();expect(f.request).toHaveBeenCalledOnce()
})
it('does not append canceled in-flight transcription and releases its desktop lease',async()=>{
 const f=fixture(true);let finish!:(value:Response)=>void
 f.request.mockImplementation(async path=>path==='/api/voice/transcribe'?new Promise(resolve=>{finish=resolve}):Response.json(path==='/api/voice/config'?{microphoneId:'',asr:{model:'fixture'}}:{ok:true}))
 await f.session.start();f.audio.speech(2);f.session.stop();await vi.waitFor(()=>expect(f.request.mock.calls.some(([path])=>path.endsWith('/transcribe'))).toBe(true))
 f.session.cancel();finish(Response.json({text:'late response'}));await vi.waitFor(()=>expect(f.request.mock.calls.some(([path])=>path.endsWith('/dictation-end'))).toBe(true))
 expect(f.onText).not.toHaveBeenCalled();expect(f.audio.stop).toHaveBeenCalledOnce()
})
it('cleans up after permission denial and releases even a late desktop start acknowledgment',async()=>{
 const f=fixture(true);f.audio.getUserMedia.mockRejectedValue(new DOMException('denied','NotAllowedError'))
 await f.session.start();await vi.waitFor(()=>expect(f.onPhase).toHaveBeenLastCalledWith('idle'))
 expect(f.onError).toHaveBeenCalledWith(expect.stringContaining('权限被拒绝'))
 expect(f.request.mock.calls.map(([path])=>path)).toEqual(['/api/voice/config','/api/desktop/voice/dictation-start','/api/desktop/voice/dictation-end'])
 const late=fixture(true);let resolve!:(value:Response)=>void
 late.request.mockImplementation(async path=>path.endsWith('dictation-start')?new Promise(done=>{resolve=done}):Response.json(path.endsWith('config')?{microphoneId:'',asr:{model:'fixture'}}:{ok:true}))
 const started=late.session.start();await vi.waitFor(()=>expect(resolve).toBeDefined());late.session.cancel();resolve(Response.json({ok:true}));await started
 await vi.waitFor(()=>expect(late.request.mock.calls.at(-1)?.[0]).toBe('/api/desktop/voice/dictation-end'))
 expect(late.audio.getUserMedia).not.toHaveBeenCalled()
})
it('bounds slow recognition by stopping capture and draining every already queued segment in order',async()=>{
 const f=fixture(),finish:Array<(value:Response)=>void>=[]
 f.request.mockImplementation(async path=>path.endsWith('transcribe')?new Promise(done=>finish.push(done)):Response.json({microphoneId:'',asr:{model:'fixture'}}))
 await f.session.start()
 for(let segment=0;segment<3;segment++){f.audio.speech(2);for(let i=0;i<3;i++)f.audio.emit(new Float32Array(4096))}
 expect(f.audio.stop).toHaveBeenCalledOnce();expect(f.onPhase).toHaveBeenLastCalledWith('transcribing')
 for(let index=0;index<3;index++){await vi.waitFor(()=>expect(finish.length).toBe(index+1));finish[index]!(Response.json({text:`第${index}段`}))}
 await vi.waitFor(()=>expect(f.onPhase).toHaveBeenLastCalledWith('idle'))
 expect(f.onText.mock.calls.map(([value])=>value.segment)).toEqual([0,1,2]);expect(f.onError).toHaveBeenCalledWith(expect.stringContaining('识别速度较慢'))
})
