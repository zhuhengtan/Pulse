import { vi } from 'vitest'

export function dictationAudio(){
  const stop=vi.fn(),track={stop,onended:null as null|(()=>void)},stream={getTracks:()=>[track],getAudioTracks:()=>[track]}
  const getUserMedia=vi.fn(async()=>stream)
  const processors:Array<{onaudioprocess:((event:any)=>void)|null;connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}>=[]
  const close=vi.fn(async()=>{}),connect=vi.fn(),disconnect=vi.fn()
  class Context{
    sampleRate=16000;destination={};resume=vi.fn(async()=>{});close=close
    createMediaStreamSource(){return{connect,disconnect}}
    createScriptProcessor(){const processor={onaudioprocess:null,connect:vi.fn(),disconnect:vi.fn()};processors.push(processor);return processor}
  }
  vi.stubGlobal('AudioContext',Context)
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}})
  const emit=(samples:Float32Array)=>processors.at(-1)?.onaudioprocess?.({inputBuffer:{getChannelData:()=>samples}})
  const speech=(blocks=16)=>{for(let i=0;i<blocks;i++)emit(new Float32Array(4096).fill(.08))}
  return{getUserMedia,stop,track,stream,processors,close,emit,speech}
}
