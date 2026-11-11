import { expect, it, vi } from 'vitest'
import { VoiceEngine, encodeWav, trimWakeAudio } from '../packages/desktop/src/voice/engine.mjs'
function engine() {
 const target=Object.create(VoiceEngine.prototype)
 Object.assign(target,{config:{speakerThreshold:.6,followupSeconds:30},speaker:[1,0],activeUntil:0,keyword:'',enrolling:false,emit:vi.fn(),embedding:()=>[1,0],stream:{acceptWaveform:vi.fn()},kws:{isReady:()=>false},vad:{acceptWaveform:vi.fn(),isEmpty:()=>true}})
 target.detectKeyword=()=>target.keyword?{keyword:target.keyword,timestamps:[.1]}:undefined
 return target
}
it('does not transcribe ambient speech without wake and rejects non-owner speech after wake',()=>{
 const target=engine();let segments:any[]=[];target.vad.isEmpty=()=>!segments.length;target.vad.front=()=>segments[0];target.vad.pop=()=>segments.shift()
 segments.push({samples:new Float32Array(40000).fill(.1)});target.accept(new Float32Array(4096));expect(target.emit).not.toHaveBeenCalled()
 target.keyword='wake';target.embedding=()=>[0,1];segments.push({samples:new Float32Array(40000).fill(.1)});target.accept(new Float32Array(4096));expect(target.emit).not.toHaveBeenCalledWith(expect.objectContaining({type:'utterance'}))
 target.keyword='wake';target.embedding=()=>[1,0];segments.push({samples:new Float32Array(40000).fill(.1)});target.accept(new Float32Array(4096));expect(target.emit).toHaveBeenCalledWith(expect.objectContaining({type:'utterance',wake:true}))
})
it('ends the follow-up window locally and ignores invalid sample packets',()=>{
 const target=engine();target.activeUntil=Date.now()-1;target.accept(new Float32Array([NaN]));expect(target.vad.acceptWaveform).not.toHaveBeenCalled()
 expect(target.matches([1,0])).toBe(true);expect(target.matches([0,1])).toBe(false)
 const wav=Buffer.from(encodeWav(new Float32Array([1,-1])), 'base64');expect(wav.toString('ascii',8,12)).toBe('WAVE');expect(wav.readUInt32LE(24)).toBe(16000)
})

it('removes the wake audio at a quiet phoneme boundary instead of relying on its ASR spelling', () => {
 const samples = new Float32Array(16000).fill(.1); samples.fill(0, 8000, 8320)
 const trimmed = trimWakeAudio(samples, { timestamps: [.1, .4] })
 expect(trimmed.length).toBe(16000 - 8160)
 expect(trimWakeAudio(samples, { timestamps: [Infinity] })).toBeUndefined()
 expect(trimWakeAudio(samples, { timestamps: [2] })).toBeUndefined()
})
it('emits wake-only rather than transcribing the assistant name as a chat message', () => {
 const target = engine(), samples = new Float32Array(12000).fill(.1); samples.fill(0, 11000)
 target.detectKeyword = () => ({ keyword: 'wake', timestamps: [.2, .6] })
 let pending = true; target.vad.isEmpty=()=>!pending; target.vad.front=()=>({samples}); target.vad.pop=()=>{pending=false}
 target.accept(new Float32Array(4096))
 expect(target.emit).toHaveBeenCalledWith({ type: 'wake' })
 expect(target.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'utterance' }))
 expect(target.activeUntil).toBeGreaterThan(Date.now())
})
it('keeps local stop/end commands after the name and retains the first wake boundary for ordinary speech', () => {
 const wake = { keyword: 'wake', timestamps: [.2] }
 function detect(results) {
  let available = results.slice()
  const kws = { createStream:()=>({acceptWaveform:()=>{}}),isReady:()=>available.length>0,decode:()=>{},getResult:()=>available.shift(),reset:vi.fn() }
  return VoiceEngine.prototype.detectKeyword.call({kws},new Float32Array(16000))
 }
 expect(detect([wake,{keyword:'stop'}])).toMatchObject({keyword:'stop'})
 expect(detect([wake,{keyword:'end'}])).toMatchObject({keyword:'end'})
 expect(detect([wake,{keyword:'wake',timestamps:[1.2]}])).toBe(wake)
})
it('checks the isolated command for stop before sending it to transcription', () => {
 const target = engine(); target.detectKeyword = vi.fn().mockReturnValueOnce({keyword:'wake',timestamps:[.1]}).mockReturnValueOnce({keyword:'stop'})
 let pending = true; target.vad.isEmpty=()=>!pending; target.vad.front=()=>({samples:new Float32Array(40000).fill(.1)}); target.vad.pop=()=>{pending=false}
 target.accept(new Float32Array(4096))
 expect(target.emit).toHaveBeenCalledWith({type:'stop'})
 expect(target.emit).not.toHaveBeenCalledWith(expect.objectContaining({type:'utterance'}))
})

it('accepts owner barge-in during long playback after the ordinary follow-up window expired', () => {
 const target = engine(); target.activeUntil = Date.now() - 1; target.playbackActive = true
 let pending = true; target.vad.isEmpty = () => !pending; target.vad.front = () => ({ samples: new Float32Array(40000).fill(.1) }); target.vad.pop = () => { pending = false }
 target.accept(new Float32Array(4096))
 expect(target.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'utterance', wake: false }))
 expect(target.activeUntil).toBeGreaterThan(Date.now())
})
it('still rejects non-owner speech during playback and requires wake after playback and follow-up end', () => {
 const target = engine(); target.activeUntil = Date.now() - 1; target.playbackActive = true
 let pending = true; target.vad.isEmpty = () => !pending; target.vad.front = () => ({ samples: new Float32Array(40000).fill(.1) }); target.vad.pop = () => { pending = false }
 target.embedding = () => [0, 1]; target.accept(new Float32Array(4096)); expect(target.emit).not.toHaveBeenCalled()
 target.embedding = () => [1, 0]; target.playbackActive = false; pending = true
 target.accept(new Float32Array(4096)); expect(target.emit).not.toHaveBeenCalled()
})
it.each(['stop', 'end'])('leaves playback state on local %s without submitting a command', keyword => {
 const target = engine(); target.activeUntil = Date.now() - 1; target.playbackActive = true; target.keyword = keyword
 let pending = true; target.vad.isEmpty = () => !pending; target.vad.front = () => ({ samples: new Float32Array(40000).fill(.1) }); target.vad.pop = () => { pending = false }
 target.accept(new Float32Array(4096)); expect(target.playbackActive).toBe(false)
 expect(target.emit).toHaveBeenCalledWith({ type: keyword }); expect(target.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'utterance' }))
})
