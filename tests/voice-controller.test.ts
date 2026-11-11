import { expect, it, vi } from 'vitest'
import { VoiceController, spokenText } from '../packages/desktop/src/voice/controller.mjs'
function setup(){const request=vi.fn(),controller=new VoiceController({ipcMain:{on:vi.fn()},root:'/unused',request,changed:vi.fn()});controller.config={name:'Pulse'};controller.worker={postMessage:vi.fn(),kill:vi.fn()};controller.audio={webContents:{send:vi.fn()},destroy:vi.fn()};return {controller,request}}
it('never starts background capture for an enabled legacy config without explicit wake opt-in',async()=>{
 const {controller,request}=setup(),config={enabled:true,name:'Pulse',asr:{},tts:{}}
 const worker=controller.worker,audio=controller.audio;request.mockResolvedValue(config)
 const start=vi.spyOn(controller,'start')
 await controller.sync()
 expect(worker.kill).toHaveBeenCalledOnce();expect(audio.destroy).toHaveBeenCalledOnce();expect(start).not.toHaveBeenCalled()
 expect(controller.status).toContain('麦克风未占用');controller.close()
})
it('does not resume background capture after manual dictation when wake is off',async()=>{
 const {controller}=setup();controller.config.enabled=true;controller.config.wakeEnabled=false
 await controller.action('dictation-start',{id:'manual-only-voice'});await controller.action('dictation-end',{id:'manual-only-voice'})
 expect(controller.audio.webContents.send.mock.calls.some(([,v])=>v.type==='start')).toBe(false)
 expect(controller.status).toContain('麦克风未占用');controller.close()
})
it('persists wake opt-out using current settings and destroys capture without stopping ASR',async()=>{
 const {controller,request}=setup(),config={enabled:true,wakeEnabled:true,name:'Latest name',asr:{},tts:{}}
 const audio=controller.audio,worker=controller.worker,close=vi.spyOn(controller.localSpeech,'close')
 request.mockResolvedValueOnce(config).mockResolvedValue({...config,wakeEnabled:false})
 await controller.action('wake-settings',{enabled:false})
 expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({name:'Latest name',wakeEnabled:false})
 expect(audio.destroy).toHaveBeenCalledOnce();expect(worker.kill).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled()
 expect((await controller.snapshot()).wakeEnabled).toBe(false);controller.close()
})
it('submits a verified voice utterance once to the ordinary assistant queue',async()=>{
 const {controller,request}=setup();request.mockResolvedValueOnce({text:'Pulse，你好'}).mockResolvedValueOnce({runId:'run-one'})
 await controller.receive({type:'utterance',wake:true,audio:'fixture'});await controller.tail
 expect(request.mock.calls[1]?.[0]).toBe('/api/assistant/messages');expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({text:'你好',delivery:'immediate',inputMode:'voice'})
 expect(controller.pending.runId).toBe('run-one')
})
it('speaks only the correlated final reply and never replays it after stop',async()=>{
 const {controller,request}=setup();controller.pending={requestId:'voice-one',runId:'r',generation:0,started:Date.now()}
 request.mockResolvedValueOnce({receipts:[{messageId:'voice-one',state:'completed'}],messages:[{role:'assistant',text:'wrong',replyToId:'msg-text-one'},{role:'assistant',messageKind:'pre_reply',text:'preview',replyToId:'msg-voice-one'},{role:'assistant',messageKind:'reply',text:'正确回复',replyToId:'msg-voice-one'}]}).mockResolvedValueOnce({audio:'wav',mime:'audio/wav'})
 await controller.checkReply();expect(JSON.parse(request.mock.calls[1]![1].body).text).toBe('正确回复');expect(controller.pending).toBeUndefined()
 controller.stopPlayback();expect(controller.audio.webContents.send).toHaveBeenLastCalledWith('pulse:voice-command',{type:'stop'})
 expect(spokenText('回答\n```js\nsecret()\n```')).toBe('回答')
})
it('drops in-flight transcription after pause without submitting or cancelling a task',async()=>{
 const {controller,request}=setup();let resolve!:(value:unknown)=>void;request.mockReturnValueOnce(new Promise(done=>{resolve=done}))
 await controller.receive({type:'utterance',audio:'fixture'});await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());controller.stop();resolve({text:'old transcript'});await controller.tail
 expect(request).toHaveBeenCalledOnce();expect(controller.worker).toBeUndefined()
})
it('routes only the selected local speech requests to desktop inference with persisted voice settings', async () => {
 const { controller, request } = setup()
 request.mockResolvedValue({ asr: { backend: 'local', language: 'zh' }, tts: { backend: 'external', voice: '45', speed: 1.1 } })
 const infer = vi.spyOn(controller.localSpeech, 'request').mockResolvedValue({ text: '你好' })
 expect(await controller.localRequest('/api/assistant/messages', { method: 'POST', body: '{}' })).toBeUndefined()
 expect(await controller.localRequest('/api/voice/transcribe', { method: 'POST', body: JSON.stringify({ audio: 'wave' }) })).toEqual({ text: '你好' })
 expect(infer).toHaveBeenLastCalledWith('transcribe', { audio: 'wave', language: 'zh', voice: '45', speed: 1.1 })
 expect(await controller.localRequest('/api/voice/speech', { method: 'POST', body: JSON.stringify({ text: 'hello' }) })).toBeUndefined()
 expect(infer).toHaveBeenCalledOnce(); controller.close()
 await expect(controller.localRequest('/api/voice/transcribe', { method: 'POST', body: '{}' })).rejects.toThrow('PROCESS_STOPPED')
})
it('selects a local connection before launching its asynchronous installation and keeps status responsive', async () => {
 const { controller, request } = setup()
 request.mockResolvedValue({ backend: 'local', model: 'pulse-whisper-base' })
 const install = vi.spyOn(controller.localSpeech, 'install').mockImplementation(() => {})
 expect(await controller.action('install-asr')).toMatchObject({ connection: { backend: 'local', model: 'pulse-whisper-base' }, localSpeech: { asr: { installing: false } } })
 expect(request).toHaveBeenCalledWith('/api/voice/local', { method: 'POST', body: JSON.stringify({ kind: 'asr' }) })
 expect(install).toHaveBeenCalledWith('asr'); controller.close()
 await expect(controller.action('install-tts')).rejects.toThrow('PROCESS_STOPPED')
})
it('does not start or retry a download when the backend cannot select a local model', async () => {
 const { controller, request } = setup()
 request.mockRejectedValue(new Error('VOICE_LOCAL_BACKEND_UPDATE_REQUIRED'))
 const install = vi.spyOn(controller.localSpeech, 'install')
 await expect(controller.action('install-asr')).rejects.toThrow('VOICE_LOCAL_BACKEND_UPDATE_REQUIRED')
 expect(install).not.toHaveBeenCalled()
 expect(controller.localSpeech.snapshot().asr.installing).toBe(false)
 controller.close()
})
it('keeps voice replies in chat and opens follow-up without synthesizing when automatic speech is off', async () => {
 const { controller, request } = setup(); controller.config.autoSpeak = false
 controller.pending = { requestId: 'voice-silent', generation: 0, started: Date.now() }
 request.mockResolvedValueOnce({ receipts: [{ messageId: 'voice-silent', state: 'completed' }], messages: [{ role: 'assistant', messageKind: 'reply', text: '文字回复', replyToId: 'msg-voice-silent' }] })
 await controller.checkReply()
 expect(request).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledWith('/api/assistant')
 expect(controller.worker.postMessage).toHaveBeenCalledWith({ type: 'followup' })
 expect(controller.audio.webContents.send).not.toHaveBeenCalled(); expect(controller.pending).toBeUndefined()
 controller.close()
})
it('stops in-flight playback when muting and never plays that reply after re-enabling', async () => {
 const { controller, request } = setup()
 controller.pending = { requestId: 'voice-playing', generation: 0, started: Date.now() }
 let resolveSpeech!: (value: unknown) => void
 request.mockResolvedValueOnce({ receipts: [{ messageId: 'voice-playing', state: 'completed' }], messages: [{ role: 'assistant', messageKind: 'reply', text: '旧回复', replyToId: 'msg-voice-playing' }] }).mockReturnValueOnce(new Promise(resolve => { resolveSpeech = resolve }))
 const reply = controller.checkReply(); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
 request.mockResolvedValueOnce({ autoSpeak: false }); await controller.action('speech-settings')
 expect(controller.audio.webContents.send).toHaveBeenCalledWith('pulse:voice-command', { type: 'stop' })
 expect(controller.worker.kill).not.toHaveBeenCalled(); expect(controller.audio.destroy).not.toHaveBeenCalled()
 request.mockResolvedValueOnce({ autoSpeak: true }); await controller.action('speech-settings')
 resolveSpeech({ audio: 'old-audio', mime: 'audio/wav' }); await reply; await controller.speechTask
 expect(controller.audio.webContents.send.mock.calls.some(call => ['play', 'speech-chunk'].includes(call[1].type))).toBe(false)
 controller.close()
})
it('applies saved speech preferences during sync without restarting microphone capture', async () => {
 const { controller, request } = setup()
 const config = { enabled: true, wakeEnabled: true, name: 'Pulse', asr: {}, tts: {} }
 controller.config = { ...config, autoSpeak: true }; controller.signature = JSON.stringify(config); controller.ready = true
 request.mockResolvedValue({ ...config, autoSpeak: false })
 await controller.sync()
 expect(controller.config.autoSpeak).toBe(false)
 expect(controller.worker.kill).not.toHaveBeenCalled(); expect(controller.audio.destroy).not.toHaveBeenCalled()
 controller.close()
})
it('does not let an older config read overwrite an immediate speech preference change', async () => {
 const { controller, request } = setup()
 const config = { enabled: true, wakeEnabled: true, name: 'Pulse', asr: {}, tts: {} }
 controller.config = { ...config, autoSpeak: true }; controller.signature = JSON.stringify(config); controller.ready = true
 let resolveConfig!: (value: unknown) => void
 request.mockReturnValueOnce(new Promise(resolve => { resolveConfig = resolve })).mockResolvedValueOnce({ ...config, autoSpeak: false })
 const syncing = controller.sync(); await controller.action('speech-settings')
 resolveConfig({ ...config, autoSpeak: true }); await syncing
 expect(controller.config.autoSpeak).toBe(false); expect(controller.worker.kill).not.toHaveBeenCalled()
 controller.close()
})

it('sends the first complete sentence while the next one is still synthesizing', async () => {
 const { controller, request } = setup()
 controller.pending = { requestId: 'voice-stream', generation: 0, started: Date.now() }
 let finishSecond!: (value: unknown) => void
 request.mockResolvedValueOnce({ receipts: [{ messageId: 'voice-stream', state: 'completed' }], messages: [{ role: 'assistant', messageKind: 'reply', text: '第一句。第二句！', replyToId: 'msg-voice-stream' }] }).mockResolvedValueOnce({ audio: 'one', mime: 'audio/wav' }).mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve }))
 await controller.checkReply(); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
 const id = controller.speechSession.id
 expect(JSON.parse(request.mock.calls[1][1].body).text).toBe('第一句。')
 expect(JSON.parse(request.mock.calls[2][1].body).text).toBe('第二句！')
 expect(controller.audio.webContents.send).toHaveBeenCalledWith('pulse:voice-command', { type: 'speech-chunk', id, sequence: 0, audio: 'one', mime: 'audio/wav' })
 expect(controller.audio.webContents.send.mock.calls.some(call => call[1].type === 'speech-end')).toBe(false)
 finishSecond({ audio: 'two', mime: 'audio/wav' }); await controller.speechTask
 expect(controller.audio.webContents.send).toHaveBeenLastCalledWith('pulse:voice-command', { type: 'speech-end', id })
 controller.close()
})
it('prefetches at most one sentence ahead and releases backpressure on cancel', async () => {
 const { controller, request } = setup(); const pending = { requestId: 'voice-buffer', generation: 0 }
 request.mockResolvedValue({ audio: 'sentence', mime: 'audio/wav' })
 const task = controller.speakReply('第一句。第二句。第三句。第四句。', pending)
 await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
 const id = controller.speechSession.id
 controller.chunkPlayed({ id: 'stale', sequence: 0 }); expect(request).toHaveBeenCalledTimes(2)
 controller.chunkPlayed({ id, sequence: 0 }); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
 controller.stopPlayback(); await task; expect(request).toHaveBeenCalledTimes(3)
 controller.close()
})
it('does not strip legitimate message content again after audio wake removal', async () => {
 const { controller, request } = setup(); request.mockResolvedValueOnce({ text: 'Pulse 是你的名字吗？' }).mockResolvedValueOnce({ runId: 'run-body' })
 await controller.receive({ type: 'utterance', wake: true, wakeTrimmed: true, audio: 'trimmed-command' }); await controller.tail
 expect(JSON.parse(request.mock.calls[1][1].body).text).toBe('Pulse 是你的名字吗？')
 controller.close()
})
it('does not submit a chat request for a wake-only event', async () => {
 const { controller, request } = setup(); await controller.receive({ type: 'wake' })
 expect(request).not.toHaveBeenCalled(); expect(controller.status).toBe('已唤醒，请说')
 controller.close()
})
it('leases background audio for explicit dictation, ignores wake submissions and restores listening',async()=>{
 const{controller,request}=setup();controller.config.enabled=true;controller.config.wakeEnabled=true;controller.config.microphoneId='selected';controller.speaker=[1,0]
 await controller.action('dictation-start',{id:'dictation-one'})
 expect(controller.audio.webContents.send).toHaveBeenCalledWith('pulse:voice-command',{type:'close'})
 expect(controller.worker.postMessage).toHaveBeenCalledWith({type:'reset'})
 await controller.receive({type:'utterance',audio:'must not submit'});await controller.tail;expect(request).not.toHaveBeenCalled()
 await expect(controller.action('dictation-start',{id:'another-dictation'})).rejects.toThrow('BUSY')
 await controller.action('dictation-end',{id:'stale-dictation'});expect(controller.dictation).toBe('dictation-one')
 await controller.action('dictation-end',{id:'dictation-one'})
 expect(controller.dictation).toBeUndefined();expect(controller.audio.webContents.send).toHaveBeenLastCalledWith('pulse:voice-command',{type:'start',deviceId:'selected'})
 expect(controller.status).toBe('等待名字唤醒');controller.close()
})
it('expires a lost dictation lease and respects a user pause made during dictation',async()=>{
 const{controller}=setup();controller.config.enabled=true;vi.useFakeTimers()
 try{
  await controller.action('dictation-start',{id:'leased-dictation'});await vi.advanceTimersByTimeAsync(20000)
  await controller.action('dictation-start',{id:'leased-dictation'});await vi.advanceTimersByTimeAsync(20000);expect(controller.dictation).toBe('leased-dictation')
  const contents=controller.audio.webContents;controller.paused=true;await vi.advanceTimersByTimeAsync(10001)
  expect(controller.dictation).toBeUndefined();expect(controller.status).toBe('已暂停')
  expect(contents.send.mock.calls.some(([,value])=>value.type==='start')).toBe(false)
 }finally{controller.close();vi.useRealTimers()}
})
it('keeps local ASR alive for explicit dictation while the background assistant is disabled',async()=>{
 const{controller,request}=setup();const config={name:'Pulse',enabled:false,asr:{backend:'local'},tts:{}}
 controller.config=config;controller.signature=JSON.stringify(config);request.mockResolvedValue(config)
 const close=vi.spyOn(controller.localSpeech,'close');await controller.action('dictation-start',{id:'manual-input-off'})
 await controller.sync();expect(close).not.toHaveBeenCalled();expect(controller.status).toBe('聊天语音输入中')
 await controller.action('dictation-end',{id:'manual-input-off'});await controller.sync();expect(close).toHaveBeenCalledOnce();controller.close()
})
it('does not reopen background capture when model startup finishes after dictation begins',async()=>{
 const{controller,request}=setup(),config={name:'Pulse',enabled:true,asr:{backend:'local'},tts:{}}
 controller.config=config;controller.signature=JSON.stringify(config);controller.worker=undefined;controller.ready=true;request.mockResolvedValue(config)
 let ready!:()=>void;vi.spyOn(controller.localSpeech,'start').mockReturnValue(new Promise<void>(done=>{ready=done}))
 const start=vi.spyOn(controller,'start').mockResolvedValue(undefined),sync=controller.sync()
 await vi.waitFor(()=>expect(controller.localSpeech.start).toHaveBeenCalledOnce());await controller.action('dictation-start',{id:'manual-during-start'})
 ready();await sync;expect(start).not.toHaveBeenCalled();controller.close()
})
it('discards background transcription already in flight when explicit dictation starts',async()=>{
 const{controller,request}=setup();let finish!:(value:unknown)=>void
 request.mockReturnValueOnce(new Promise(done=>{finish=done}))
 await controller.receive({type:'utterance',audio:'old-background-audio'});await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce())
 await controller.action('dictation-start',{id:'manual-takes-over'});finish({text:'must not auto-submit'});await controller.tail
 expect(request).toHaveBeenCalledOnce();expect(controller.worker.kill).not.toHaveBeenCalled();controller.close()
})


it.each(['stop', 'end'])('discards an unsubmitted transcript after the owner says %s without cancelling accepted work', async type => {
 const { controller, request } = setup(); let finish!: (value: unknown) => void
 request.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
 await controller.receive({ type: 'utterance', audio: 'old-owner-command' })
 await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
 await controller.receive({ type }); const status = controller.status
 finish({ text: 'do not submit after conversation control' }); await controller.tail
 expect(request).toHaveBeenCalledOnce(); expect(controller.status).toBe(status)
 expect(controller.worker.kill).not.toHaveBeenCalled(); expect(controller.audio.destroy).not.toHaveBeenCalled()
 controller.close()
})
it('drops queued transcripts on end but accepts a fresh wake and utterance afterward', async () => {
 const { controller, request } = setup(); let finish!: (value: unknown) => void
 request.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
 await controller.receive({ type: 'utterance', audio: 'in-flight' })
 await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
 await controller.receive({ type: 'utterance', audio: 'queued' }); await controller.receive({ type: 'end' })
 finish({ text: 'old transcript' }); await controller.tail
 expect(request).toHaveBeenCalledOnce()
 request.mockResolvedValueOnce({ text: 'fresh instruction' }).mockResolvedValueOnce({ runId: 'fresh-run' })
 await controller.receive({ type: 'wake' }); await controller.receive({ type: 'utterance', audio: 'fresh' }); await controller.tail
 expect(request).toHaveBeenCalledTimes(3)
 expect(JSON.parse(request.mock.calls[2][1].body).text).toBe('fresh instruction')
 expect(controller.pending.runId).toBe('fresh-run'); controller.close()
})
it('does not let canceled transcription failure overwrite a newer listening status', async () => {
 const { controller, request } = setup(); let fail!: (error: Error) => void
 request.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
 await controller.receive({ type: 'utterance', audio: 'failing' }); await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
 await controller.receive({ type: 'end' }); await controller.receive({ type: 'wake' })
 fail(new Error('late ASR error')); await controller.tail
 expect(controller.status).toBe('已唤醒，请说'); expect(request).toHaveBeenCalledOnce(); controller.close()
})
it('keeps both ordinary owner utterances in order when a second arrives during transcription', async () => {
 const { controller, request } = setup(); let finish!: (value: unknown) => void
 request.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ runId: 'one' }).mockResolvedValueOnce({ text: 'second' }).mockResolvedValueOnce({ runId: 'two' })
 await controller.receive({ type: 'utterance', audio: 'first' }); await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
 await controller.receive({ type: 'utterance', audio: 'second' }); finish({ text: 'first' }); await controller.tail
 expect(request.mock.calls.filter(([path]) => path === '/api/assistant/messages').map(([, init]) => JSON.parse(init.body).text)).toEqual(['first', 'second'])
 expect(controller.pending.runId).toBe('two'); controller.close()
})

it('keeps barge-in enabled only for the current speech session and disables it on cancel', async () => {
 const { controller, request } = setup(); request.mockResolvedValue({ audio: 'sentence', mime: 'audio/wav' })
 await controller.speakReply('一段长回复。', { generation: 0 })
 expect(controller.worker.postMessage).toHaveBeenCalledWith({ type: 'playback', active: true })
 controller.stopPlayback()
 expect(controller.worker.postMessage).toHaveBeenLastCalledWith({ type: 'playback', active: false })
 controller.close()
})
it('ends playback barge-in mode before starting the ordinary follow-up window', async () => {
 let receive!: (event: any, value: any) => void
 const controller = new VoiceController({ ipcMain: { on: (_channel, callback) => { receive = callback } }, root: '/unused', request: vi.fn().mockResolvedValue({ audio: 'speech', mime: 'audio/wav' }) })
 controller.config = { autoSpeak: true }; controller.worker = { postMessage: vi.fn(), kill: vi.fn() }
 const frame = {}; const contents = { mainFrame: frame, send: vi.fn() }; controller.audio = { webContents: contents, destroy: vi.fn() }
 await controller.speakReply('回复。', { generation: 0 }); const id = controller.speechSession.id
 receive({ sender: contents, senderFrame: frame }, { type: 'played', id: 'stale' })
 expect(controller.speechSession.id).toBe(id)
 receive({ sender: contents, senderFrame: frame }, { type: 'played', id })
 expect(controller.speechSession).toBeUndefined()
 expect(controller.worker.postMessage.mock.calls.map(([value]) => value)).toEqual([{ type: 'playback', active: true }, { type: 'playback', active: false }, { type: 'followup' }])
 controller.close()
})
it('stops playback mode after synthesis failure but leaves the worker available for a new wake', async () => {
 const { controller, request } = setup(); controller.pending = { requestId: 'failing-speech', generation: 0, started: Date.now() }
 request.mockResolvedValueOnce({ receipts: [{ messageId: 'failing-speech', state: 'completed' }], messages: [{ role: 'assistant', messageKind: 'reply', text: '要播报的回复。', replyToId: 'msg-failing-speech' }] }).mockRejectedValueOnce(new Error('synthesis failed'))
 await controller.checkReply(); await controller.speechTask
 expect(controller.worker.postMessage).toHaveBeenLastCalledWith({ type: 'playback', active: false })
 expect(controller.worker.kill).not.toHaveBeenCalled(); expect(controller.status).toContain('播报失败')
 await controller.receive({ type: 'wake' }); expect(controller.status).toBe('已唤醒，请说'); controller.close()
})

it('does not cancel an accepted chat request or restore pending speech when end arrives before its receipt', async () => {
 const { controller, request } = setup(); let receipt!: (value: unknown) => void
 request.mockResolvedValueOnce({ text: 'already submitted command' }).mockReturnValueOnce(new Promise(resolve => { receipt = resolve }))
 await controller.receive({ type: 'utterance', audio: 'accepted' }); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
 await controller.receive({ type: 'end' }); receipt({ runId: 'accepted-run' }); await controller.tail
 expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/voice/transcribe', '/api/assistant/messages'])
 expect(controller.pending).toBeUndefined(); expect(controller.status).toBe('等待名字唤醒')
 expect(controller.worker.kill).not.toHaveBeenCalled(); controller.close()
})

it.each(['missing-chunk-end', 'missing-stream-end'])('bounds a final playback with %s without claiming success or cancelling chat', async missing => {
 const { controller, request } = setup(); vi.useFakeTimers()
 try {
  request.mockResolvedValue({ audio: 'fixture', mime: 'audio/wav' })
  await controller.speakReply('已经合成的回复。', { generation: 0 })
  const id = controller.speechSession.id
  expect(controller.audio.webContents.send).toHaveBeenLastCalledWith('pulse:voice-command', { type: 'speech-end', id })
  expect(controller.speechSession).toBeDefined() // synthesis is not playback completion
  if (missing === 'missing-stream-end') controller.chunkPlayed({ id, sequence: 0 })
  await vi.advanceTimersByTimeAsync(180001)
  expect(controller.speechSession).toBeUndefined(); expect(controller.status).toContain('播放完成未确认')
  expect(controller.worker.postMessage).toHaveBeenLastCalledWith({ type: 'playback', active: false })
  expect(controller.worker.postMessage.mock.calls.some(([event]) => event.type === 'followup')).toBe(false)
  expect(controller.worker.kill).not.toHaveBeenCalled()
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/voice/speech'])
  await controller.receive({ type: 'wake' }); expect(controller.status).toBe('已唤醒，请说')
 } finally { controller.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() }
})
it('clears completion deadlines on real playback completion and rejects idless or stale completion', async () => {
 let receive!: (event: any, value: any) => void; vi.useFakeTimers()
 const controller = new VoiceController({ ipcMain: { on: (_channel, callback) => { receive = callback } }, root: '/unused', request: vi.fn().mockResolvedValue({ audio: 'fixture', mime: 'audio/wav' }) })
 const frame = {}, contents = { mainFrame: frame, send: vi.fn() }; controller.config = { autoSpeak: true }; controller.worker = { postMessage: vi.fn(), kill: vi.fn() }; controller.audio = { webContents: contents, destroy: vi.fn() }
 try {
  await controller.speakReply('第一轮。', { generation: 0 }); const stale = controller.speechSession.id
  await vi.advanceTimersByTimeAsync(100000); controller.stopPlayback()
  await controller.speakReply('第二轮。', { generation: controller.generation }); const id = controller.speechSession.id
  receive({ sender: contents, senderFrame: frame }, { type: 'played' })
  receive({ sender: contents, senderFrame: frame }, { type: 'played', id: stale })
  await vi.advanceTimersByTimeAsync(80001); expect(controller.speechSession.id).toBe(id)
  receive({ sender: contents, senderFrame: frame }, { type: 'played', id })
  expect(controller.status).toBe('可继续追问'); expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(180001); expect(controller.status).toBe('可继续追问')
 } finally { controller.close(); vi.useRealTimers() }
})
it('times out final playback even after earlier progress and drops synthesis completing after the timeout', async () => {
 const { controller, request } = setup(); vi.useFakeTimers(); let finish!: (value: unknown) => void
 try {
  request.mockResolvedValueOnce({ audio: 'first', mime: 'audio/wav' }).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const synthesis = controller.speakReply('第一句。第二句。', { generation: 0 })
  await Promise.resolve(); await Promise.resolve(); const id = controller.speechSession.id
  await vi.advanceTimersByTimeAsync(100000); controller.chunkPlayed({ id, sequence: 0 })
  await vi.advanceTimersByTimeAsync(80001); expect(controller.speechSession.id).toBe(id)
  await vi.advanceTimersByTimeAsync(100000); expect(controller.speechSession).toBeUndefined()
  finish({ audio: 'late', mime: 'audio/wav' }); await synthesis
  expect(controller.audio.webContents.send.mock.calls.filter(([, event]) => event.type === 'speech-chunk')).toHaveLength(1)
 } finally { controller.close(); vi.useRealTimers() }
})

it.each(['resolve', 'reject'])('bounds a hung first synthesis and isolates its late %s from a newer wake', async outcome => {
 const { controller, request } = setup(); vi.useFakeTimers()
 let resolve!: (value: unknown) => void, reject!: (error: Error) => void
 try {
  controller.pending = { requestId: 'hung-first', generation: 0, started: Date.now() }
  request.mockResolvedValueOnce({ receipts: [{ messageId: 'hung-first', state: 'completed' }], messages: [{ role: 'assistant', messageKind: 'reply', text: '首句。', replyToId: 'msg-hung-first' }] }).mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail }))
  await controller.checkReply(); await Promise.resolve()
  expect(controller.status).toBe('正在合成语音')
  await vi.advanceTimersByTimeAsync(180001); expect(controller.speechSession).toBeUndefined()
  await controller.receive({ type: 'wake' })
  if (outcome === 'resolve') resolve({ audio: 'late', mime: 'audio/wav' }); else reject(new Error('late synthesis failed'))
  await controller.speechTask
  expect(controller.status).toBe('已唤醒，请说')
  expect(controller.audio.webContents.send.mock.calls.some(([, event]) => event.type === 'speech-chunk')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
 } finally { controller.close(); vi.useRealTimers() }
})
