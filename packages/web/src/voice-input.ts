import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

export type DictationPhase = 'preparing' | 'recording' | 'transcribing' | 'idle'
export type DictationText = { segment: number; text: string }

export function dictationError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/NotAllowedError|PermissionDenied/.test((error as Error)?.name ?? '') || /permission denied/i.test(text)) return '麦克风权限被拒绝，请在系统或浏览器设置中允许 Pulse 使用麦克风。'
  if (/NotFoundError|NotReadableError/.test((error as Error)?.name ?? '')) return '麦克风不可用，请检查设备连接和系统输入设备。'
  if (/VOICE_(ASR_MODEL_REQUIRED|LOCAL_MODEL_NOT_INSTALLED)/.test(text)) return '请先到设置 → 语音助手安装或配置语音识别模型。'
  if (/VOICE_DESKTOP_REQUIRED/.test(text)) return '本地识别模型需要在 Pulse 桌面客户端使用。'
  if (/VOICE_DICTATION_BUSY/.test(text)) return '另一个语音输入仍在使用麦克风，请结束后再试。'
  if (/VOICE_ACTION_INVALID/.test(text)) return '当前桌面主进程尚未加载语音输入功能。请先从应用菜单或托盘选择“彻底退出 Pulse（保留后台服务）”，再运行 restart-dev；macOS 开发版的应用菜单在屏幕左上角，名称为 Electron。新版 restart-dev 会自动重启桌面，仅关闭窗口或重启后台无效。'
  if (/VOICE_DICTATION/.test(text)) return '语音输入会话无效，请松开后重新按住说话。'
  if (/VOICE_ASR_HTTP_401/.test(text)) return '语音识别服务认证失败，请检查语音设置中的 API Key。'
  if (/VOICE_ASR_HTTP_|VOICE_LOCAL_|HTTP_/.test(text)) return '语音识别失败，请检查模型或服务连接；已识别的草稿仍保留。'
  return text
}

/** Mono 16 kHz PCM is accepted by both bundled Whisper and external ASR. */
export function dictationWave(samples: Float32Array): string {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer)
  const word = (offset: number, text: string) => { for (let i=0;i<text.length;i++) bytes[offset+i]=text.charCodeAt(i) }
  word(0,'RIFF');view.setUint32(4,bytes.length-8,true);word(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true)
  view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,samples.length*2,true)
  for(let i=0;i<samples.length;i++) view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]!))*32767),true)
  let binary='';for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192))
  return btoa(binary)
}

/** One explicit hold gesture. No wake word, speaker gate, chat submit or TTS. */
export class VoiceInputSession {
  private readonly abort = new AbortController()
  private readonly id = globalThis.crypto?.randomUUID?.() ?? `dictation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  private cancelled = false
  private released = false
  private stream: MediaStream | undefined
  private context: AudioContext | undefined
  private processor: ScriptProcessorNode | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private leased = false
  private buffers: Float32Array[] = []
  private count = 0
  private voiced = 0
  private quiet = 0
  private segment = 0
  private partialAt = 0
  private pending = 0
  private tail: Promise<void> = Promise.resolve()
  private startTask: Promise<void> | undefined
  private leaseTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: {
    transport: PulseWebTransport
    desktop: boolean
    onText: (value: DictationText) => void
    onPhase: (phase: DictationPhase) => void
    onError: (message: string) => void
  }) {}

  start(): Promise<void> { return this.startTask ??= this.prepare() }
  private async prepare() {
    try {
      this.options.onPhase('preparing')
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法使用麦克风，请使用桌面客户端、localhost 或 HTTPS 页面。')
      const config = await apiJson<{ microphoneId: string; asr: { model: string } }>(this.options.transport,'/api/voice/config',{signal:this.abort.signal})
      if (this.cancelled || this.released) return
      if (!config.asr.model) throw new Error('VOICE_ASR_MODEL_REQUIRED')
      if (this.options.desktop) {
        await this.lease('start'); this.leased = true
        if (this.cancelled || this.released) { await this.releaseLease(); return }
        this.heartbeat=setInterval(()=>{ void this.lease('start').catch(error=>this.fail(error)) },10000)
      }
      const acquired=await navigator.mediaDevices.getUserMedia({audio:{...(config.microphoneId?{deviceId:{exact:config.microphoneId}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})
      if(this.cancelled || this.released){acquired.getTracks().forEach(track=>track.stop());return}
      this.stream=acquired;const context=this.context=new AudioContext({sampleRate:16000});await context.resume()
      if(this.cancelled || this.released)return
      this.source=context.createMediaStreamSource(acquired);this.processor=context.createScriptProcessor(1024,1,1)
      this.processor.onaudioprocess=event=>{
        if(this.cancelled || this.released)return
        const input=event.inputBuffer.getChannelData(0),ratio=context.sampleRate/16000,pcm=new Float32Array(Math.floor(input.length/ratio))
        for(let i=0;i<pcm.length;i++){const from=Math.floor(i*ratio),to=Math.min(input.length,Math.max(from+1,Math.floor((i+1)*ratio)));let sum=0;for(let j=from;j<to;j++)sum+=input[j]!;pcm[i]=sum/(to-from)}
        this.accept(pcm)
      }
      acquired.getAudioTracks().forEach(track=>{track.onended=()=>this.fail(new Error('麦克风已断开，已识别的草稿仍保留。'))})
      this.source.connect(this.processor);this.processor.connect(context.destination);this.options.onPhase('recording')
    } catch(error){if(!this.cancelled && !this.released)this.fail(error)}
    finally {if(this.cancelled || this.released){this.closeAudio();if(!this.pending)await this.finish()}}
  }
  /** Silence finalizes an utterance; a growing interim snapshot updates long speech. */
  private accept(samples: Float32Array) {
    let energy=0;for(const sample of samples)energy+=sample*sample
    const speech=Math.sqrt(energy/Math.max(1,samples.length))>=.008
    this.buffers.push(samples);this.count+=samples.length
    if(speech){this.voiced+=samples.length;this.quiet=0}else this.quiet+=samples.length
    if(!this.voiced && this.count>4096){const lead=samples.subarray(Math.max(0,samples.length-4096));this.buffers=[lead];this.count=lead.length;return}
    if(this.voiced>=3200 && (this.quiet>=10400 || this.count>=25*16000))this.flush()
    else if(speech && this.voiced>=6400 && this.count-this.partialAt>=1.2*16000 && this.pending===0){this.partialAt=this.count;this.enqueue(this.snapshot(),this.segment)}
  }
  private snapshot() {const pcm=new Float32Array(this.count);let at=0;for(const part of this.buffers){pcm.set(part,at);at+=part.length}return pcm}
  private flush() {
    const samples=this.voiced>=3200 && this.count!==this.partialAt?this.snapshot():undefined,segment=this.segment
    this.buffers=[];this.count=this.voiced=this.quiet=this.partialAt=0;this.segment++
    if(samples)this.enqueue(samples,segment)
  }
  private enqueue(samples: Float32Array, segment: number) {
    this.pending++
    this.tail=this.tail.then(async()=>{
      if(this.cancelled)return
      const value=await apiJson<{text:string}>(this.options.transport,'/api/voice/transcribe',{...jsonRequest('POST',{audio:dictationWave(samples)}),signal:this.abort.signal})
      if(typeof value?.text!=='string')throw new Error('语音识别返回了无效内容，请检查模型或服务。')
      if(!this.cancelled && typeof value.text==='string' && value.text.trim())this.options.onText({segment,text:value.text.trim()})
    }).catch(error=>{if(!this.cancelled)this.fail(error)}).finally(()=>{this.pending--;if(this.released && !this.pending)void this.finish()})
    if(this.pending>=3 && !this.released){this.options.onError('识别速度较慢，录音已停止，正在处理已有内容。');this.stop()}
  }
  stop() {if(this.released)return;this.released=true;this.closeAudio();this.flush();if(this.pending)this.options.onPhase('transcribing');else if(this.startTask)void this.startTask.then(()=>this.finish())}
  cancel() {this.cancelled=true;this.released=true;this.abort.abort();this.buffers=[];this.closeAudio();void this.finish()}
  private fail(error: unknown){this.options.onError(dictationError(error));this.cancel()}
  private closeAudio(){this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop()});this.stream=undefined;if(this.processor)this.processor.onaudioprocess=null;this.processor?.disconnect();this.source?.disconnect();this.processor=undefined;this.source=undefined;const context=this.context;this.context=undefined;void context?.close().catch(()=>{})}
  private lease(action:'start'|'end'){const work=this.leaseTail.catch(()=>{}).then(()=>apiJson(this.options.transport,`/api/desktop/voice/dictation-${action}`,jsonRequest('POST',{id:this.id})));this.leaseTail=work;return work}
  private async releaseLease(){if(!this.leased)return;this.leased=false;await this.lease('end').catch(()=>{})}
  private async finish(){clearInterval(this.heartbeat);await this.releaseLease();this.options.onPhase('idle')}
}
