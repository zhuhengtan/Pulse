import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function fixture(extra = {}) {
  let command!: (value: unknown) => Promise<void>
  const send = vi.fn(), players: any[] = []
  class Audio {
    onended: (() => void) | null = null
    src: string
    reject!: (error: Error) => void
    constructor(src: string) { this.src = src; players.push(this) }
    play() { return new Promise((_resolve, reject) => { this.reject = reject }) }
    pause = vi.fn(() => this.reject?.(Object.assign(new Error('playback canceled'), { name: 'AbortError' })))
  }
  runInNewContext(readFileSync(new URL('../packages/desktop/src/voice/audio.js', import.meta.url), 'utf8'), {
    window: { voiceAudio: { receive: callback => { command = callback }, send } },
    Audio, Blob, atob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: vi.fn() },
    ...extra,
  })
  send.mockClear()
  const play = () => command({ type: 'play', audio: 'AA==', mime: 'audio/wav' })
  return { command, play, send, players }
}
it('treats intentional stop during play startup as cancellation, without stopping the microphone', async () => {
  const f = fixture(), playing = f.play()
  await f.command({ type: 'stop' }); await playing
  expect(f.send).not.toHaveBeenCalled()
  expect(f.players[0].pause).toHaveBeenCalledOnce()
})
it('ignores stale playback completion and cancellation when a new reply replaces it', async () => {
  const f = fixture(), first = f.play(), oldEnd = f.players[0].onended
  const second = f.play(); await first; oldEnd()
  expect(f.players[1].pause).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
  await f.command({ type: 'stop' }); await second
})
it('still surfaces a failure of the active playback device', async () => {
  const f = fixture(), playing = f.play()
  f.players[0].reject(new Error('audio device disconnected')); await playing
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.send).toHaveBeenCalledWith({ type: 'playback-error', id: 'legacy', error: 'audio device disconnected' })
})

it('plays complete sentences in FIFO order and opens follow-up only after the entire stream drains', async () => {
 const f = fixture()
 await f.command({ type: 'speech-start', id: 'one' })
 await f.command({ type: 'speech-chunk', id: 'one', sequence: 0, audio: 'AA==', mime: 'audio/wav' })
 await f.command({ type: 'speech-chunk', id: 'one', sequence: 1, audio: 'AA==', mime: 'audio/wav' })
 await f.command({ type: 'speech-end', id: 'one' })
 expect(f.players).toHaveLength(1)
 f.players[0].onended(); await Promise.resolve()
 expect(f.players).toHaveLength(2)
 expect(f.send).toHaveBeenCalledWith({ type: 'chunk-played', id: 'one', sequence: 0 })
 expect(f.send).not.toHaveBeenCalledWith({ type: 'played', id: 'one' })
 f.players[1].onended(); await Promise.resolve()
 expect(f.send).toHaveBeenCalledWith({ type: 'played', id: 'one' })
})
it('clears queued sentences on stop and ignores chunks from canceled streams', async () => {
 const f = fixture(); await f.command({ type: 'speech-start', id: 'old' })
 await f.command({ type: 'speech-chunk', id: 'old', sequence: 0, audio: 'AA==', mime: 'audio/wav' })
 await f.command({ type: 'speech-chunk', id: 'old', sequence: 1, audio: 'AA==', mime: 'audio/wav' })
 const oldEnded = f.players[0].onended
 await f.command({ type: 'stop' }); oldEnded()
 await f.command({ type: 'speech-chunk', id: 'old', sequence: 2, audio: 'AA==', mime: 'audio/wav' })
 await f.command({ type: 'speech-end', id: 'old' })
 expect(f.players).toHaveLength(1); expect(f.send).not.toHaveBeenCalled()
})
it('reports asynchronous media errors and discards the rest of that reply without failing microphone capture', async () => {
 const f = fixture(); await f.command({ type: 'speech-start', id: 'broken' })
 await f.command({ type: 'speech-chunk', id: 'broken', sequence: 0, audio: 'AA==', mime: 'audio/wav' })
 await f.command({ type: 'speech-chunk', id: 'broken', sequence: 1, audio: 'AA==', mime: 'audio/wav' })
 f.players[0].error = { message: 'device disconnected' }; f.players[0].onerror(); await Promise.resolve()
 expect(f.send).toHaveBeenCalledOnce()
 expect(f.send).toHaveBeenCalledWith({ type: 'playback-error', id: 'broken', error: 'device disconnected' })
 await f.command({ type: 'speech-end', id: 'broken' }); expect(f.players).toHaveLength(1)
})
it.each(['granted','denied'])('ignores a stale microphone permission result (%s) after dictation takes over',async result=>{
 let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void
 const getUserMedia=vi.fn(()=>new Promise((done,fail)=>{resolve=done;reject=fail})),stop=vi.fn()
 const f=fixture({navigator:{mediaDevices:{getUserMedia}}}),starting=f.command({type:'start'})
 await vi.waitFor(()=>expect(getUserMedia).toHaveBeenCalledOnce());await f.command({type:'close'})
 if(result==='granted')resolve({getTracks:()=>[{stop}]});else reject(new Error('permission denied'))
 await starting;expect(f.send).not.toHaveBeenCalled();if(result==='granted')expect(stop).toHaveBeenCalledOnce()
})
