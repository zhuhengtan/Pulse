import { speechSentences } from './sentences.mjs';
import { LocalSpeech } from './local-speech.mjs';
import { fork } from 'node:child_process';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { modelsReady, installModels } from './models.mjs';
import { encodeWav } from './engine.mjs';
export function spokenText(text) { return text.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*_`>]/g, '').trim().slice(0, 12000); }
export class VoiceController {
  constructor({ BrowserWindow, node, ipcMain, session, root, request, changed }) {
    Object.assign(this, { BrowserWindow, node, ipcMain, session, root, request, changed }); this.modelDirectory = join(root, 'models'); this.status = '已关闭'; this.paused = false; this.generation = 0; this.inputGeneration = 0; this.lifecycle = 0; this.devices = []; this.tail = Promise.resolve();
    this.localSpeech = new LocalSpeech({ root: join(root, 'speech-models'), node, changed });
    ipcMain.on('pulse:voice-audio', (event, data) => {
      if (!this.audio || event.sender !== this.audio.webContents || event.senderFrame !== event.sender.mainFrame) return;
      if (data.type === 'ready') { if (!this.dictation && this.config?.enabled && this.config.wakeEnabled === true && !this.paused) this.audio.webContents.send('pulse:voice-command', { type: 'start', deviceId: this.config.microphoneId }); }
      else if (data.type === 'samples' && data.samples?.length <= 32000) {
        this.samplesReceived = (this.samplesReceived ?? 0) + data.samples.length; this.lastAudioAt = Date.now(); this.capturePeak = data.peak; this.maxAudioPeak = Math.max(this.maxAudioPeak ?? 0, ...Array.from(data.samples, Math.abs));
        if (this.recording) { this.recording.push(new Float32Array(data.samples)); if (this.recording.reduce((n,x)=>n+x.length,0) >= 80000) { const chunks=this.recording; this.recording=undefined; const samples=new Float32Array(chunks.reduce((n,x)=>n+x.length,0)); let offset=0; for(const chunk of chunks){ samples.set(chunk,offset);offset+=chunk.length; } void this.request('/api/voice/transcribe',{method:'POST',body:JSON.stringify({audio:encodeWav(samples)})}).then(value=>this.setStatus(`转写测试：${value.text}`)).catch(error=>this.setStatus(error.message)); } }
        else if (!this.dictation) this.worker?.postMessage({ type: 'samples', samples: data.samples });
      } else if (data.type === 'devices') this.devices = data.devices;
      else if (data.type === 'chunk-played') this.chunkPlayed(data);
      else if (data.type === 'played') { if (!this.speechSession || data.id !== this.speechSession.id) return; this.clearSpeechSession(); this.worker?.postMessage({ type: 'followup' }); this.setStatus('可继续追问'); }
      else if (data.type === 'playback-error') { if (data.id && data.id !== this.speechSession?.id) return; this.stopPlayback(); this.setStatus('播放失败：' + data.error); }
      else if (data.type === 'error') { this.stop(); this.failedSignature = this.signature; this.setStatus(data.error); }
    });
  }
  setStatus(status) { this.status = status; this.changed?.(); }
  async snapshot() { return { status: this.status, enabled: this.config?.enabled ?? false, wakeEnabled: this.config?.wakeEnabled === true, paused: this.paused, running: Boolean(this.worker), modelsReady: this.ready ?? false, enrolled: Boolean(this.speaker), devices: this.devices, localSpeech: this.localSpeech.snapshot(), capturePeak: this.capturePeak, maxAudioPeak: this.maxAudioPeak ?? 0, samplesReceived: this.samplesReceived ?? 0, lastAudioAt: this.lastAudioAt }; }
  async sync() {
    if (this.closed || this.syncing) return; this.syncing = true;
    try {
      const preferenceRevision = this.preferenceRevision;
      const config = await this.request('/api/voice/config');
      if (this.closed || preferenceRevision !== this.preferenceRevision) return;
      const { autoSpeak, ...captureConfig } = config;
      const signature = JSON.stringify(captureConfig);
      if (signature !== this.signature) { this.stop(); this.signature = signature; this.failedSignature = undefined; }
      this.applySpeechPreference(autoSpeak !== false); this.config = config;
      if (!config.enabled) { if (!this.dictation && !Object.values(this.localSpeech.state).some(item => item.installing)) this.localSpeech.close(); this.setStatus(this.dictation ? '聊天语音输入中' : '已关闭'); return; }
      if (this.dictation) return;
      if (config.asr.backend === 'local' || config.tts.backend === 'local') await this.localSpeech.start();
      if (this.dictation) return;
      if (config.wakeEnabled !== true) { if (this.worker || this.audio) this.stop(); this.setStatus('仅按住说话，麦克风未占用'); return; }
      if (this.paused || this.downloading || this.failedSignature === signature) return;
      if (this.ready === undefined) this.ready = await modelsReady(this.modelDirectory);
      if (!this.ready) { this.setStatus('请在语音设置中下载本地唤醒和声纹模型'); return; }
      if (!this.worker) { try { await this.start(); } catch(error) { this.stop(); this.failedSignature=this.signature; throw error; } }
      if (this.pending) await this.checkReply();
    } catch (error) { this.setStatus(error.message); } finally { this.syncing = false; }
  }
  async start() {
    const lifecycle = this.lifecycle;
    this.speaker = await readFile(join(this.root, 'speaker.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (this.closed || lifecycle !== this.lifecycle || !this.config.enabled || this.config.wakeEnabled !== true || this.paused || this.dictation) return;
    const partition = this.session.fromPartition('pulse-voice');
    this.audio = new this.BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { preload: fileURLToPath(new URL('./audio-preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, session: partition } });
    partition.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === this.audio?.webContents && permission === 'media' && !details.mediaTypes?.includes('video')));
    partition.setPermissionCheckHandler((contents, permission) => contents === this.audio?.webContents && permission === 'media');
    this.audio.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); this.audio.webContents.on('will-navigate', event => event.preventDefault());
    const executable = this.node();
    if (!executable || executable === process.execPath && process.versions.electron) throw new Error('语音工作进程需要独立 Node，请设置 PULSE_VOICE_NODE 或使用桌面安装包');
    const workerFile = fileURLToPath(new URL('./worker.mjs', import.meta.url)).replace(/app\.asar([\/\\])/, 'app.asar.unpacked$1');
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    this.worker = fork(workerFile, [], { execPath: executable, execArgv: [], serialization: 'json', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment });
    this.worker.postMessage = value => this.worker?.connected && this.worker.send(value, error => { if(error)this.setStatus('语音工作进程连接已断开'); });
    const worker = this.worker; let diagnostic = ''; worker.stdout?.resume(); worker.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    worker.on('error', error => { if(this.worker === worker){this.stop();this.failedSignature=this.signature;this.setStatus(error.message);} });
    worker.on('message', value => { if (this.worker === worker) void this.receive(value).catch(error => this.setStatus(error.message)); });
    worker.on('exit', () => { if (this.worker === worker) { this.stop(); this.failedSignature = this.signature; this.setStatus(`语音进程已停止，请在设置中恢复${diagnostic ? '：' + diagnostic : ''}`); } });
    worker.postMessage({ type: 'init', directory: this.modelDirectory, config: this.config, speaker: this.speaker });
    try { await this.audio.loadFile(fileURLToPath(new URL('./audio.html', import.meta.url))); } catch (error) { if (this.worker === worker) { this.stop(); this.failedSignature = this.signature; throw error; } }
  }
  async receive(value) {
    if (this.dictation && ['utterance', 'wake', 'stop', 'end'].includes(value.type)) return;
    if (value.type === 'ready') this.setStatus(this.dictation ? '聊天语音输入中' : this.speaker ? '等待名字唤醒' : '请先录入主人声纹');
    else if (value.type === 'enrolled') { await mkdir(this.root, { recursive: true, mode: 0o700 }); const temp=join(this.root,'speaker.tmp'); await writeFile(temp,JSON.stringify(value.vector),{mode:0o600}); await rename(temp,join(this.root,'speaker.json')); this.speaker=value.vector; this.setStatus('声纹已录入，等待名字唤醒'); }
    else if (value.type === 'status') this.setStatus(value.status);
    else if (value.type === 'error') { this.stop(); this.failedSignature=this.signature; this.setStatus(value.error); }
    else if (value.type === 'stop' || value.type === 'end') { this.inputGeneration++; this.stopPlayback(); this.setStatus(value.type==='end'?'等待名字唤醒':'已停止播报'); }
    else if (value.type === 'wake') { this.stopPlayback(); this.setStatus('已唤醒，请说'); }
    else if (value.type === 'utterance') {
      this.stopPlayback(); const generation = this.generation, lifecycle = this.lifecycle, inputGeneration = this.inputGeneration;
      const currentInput = () => lifecycle === this.lifecycle && inputGeneration === this.inputGeneration && Boolean(this.worker);
      this.tail = this.tail.catch(()=>undefined).then(async () => {
        if (!currentInput()) return;
        this.setStatus('正在识别');
        const { text: recognized } = await this.request('/api/voice/transcribe', { method: 'POST', body: JSON.stringify({ audio: value.audio }) });
        if (!currentInput()) return;
        let text=recognized;
        if (value.wake && !value.wakeTrimmed && text.toLocaleLowerCase().startsWith(this.config.name.toLocaleLowerCase())) text=text.slice(this.config.name.length).replace(/^[\s，,。.!！:：]+/, '');
        if (!text) { this.setStatus('已唤醒，请说'); return; }
        const requestId = `voice-${randomUUID()}`;
        const receipt = await this.request('/api/assistant/messages', { method: 'POST', body: JSON.stringify({ text, requestId, delivery: 'immediate', inputMode: 'voice' }) });
        if (currentInput() && generation === this.generation) { this.pending = { requestId, runId: receipt.runId, generation, started: Date.now() }; this.setStatus('正在回复'); }
      }).catch(error=>{ if (currentInput()) this.setStatus(error.message); });
    }
  }
  async checkReply() {
    const pending=this.pending; if (!pending) return;
    if (Date.now()-pending.started>600000) { this.pending=undefined; this.setStatus('回复仍在聊天中继续，已停止等待播报'); return; }
    const view=await this.request('/api/assistant'); if(this.pending!==pending)return;
    const receipt=view.receipts?.find(item=>item.messageId===pending.requestId);
    const messages=view.messages?.filter(item=>item.role==='assistant' && item.messageKind!=='pre_reply' && item.replyToId===`msg-${pending.requestId}`) ?? [];
    if (receipt && ['failed','interrupted'].includes(receipt.state)) { this.pending=undefined; this.setStatus('回复中断，请查看聊天'); return; }
    if (receipt?.state!=='completed' || !messages.length)return;
    this.pending=undefined;
    if (this.config.autoSpeak === false) { this.worker?.postMessage({ type: 'followup' }); this.setStatus('回复已显示，可继续追问'); return; }
    const text=spokenText(messages.map(item=>item.text??'').join('\n')); if(!text)return;
    // Synthesis runs independently of the service monitor and microphone capture.
    this.speechTask = this.speakReply(text, pending).catch(error => {
      if (pending.generation === this.generation) { this.stopPlayback(); this.setStatus('播报失败：' + error.message); }
    });
  }
  async speakReply(text, pending) {
    const active = () => pending.generation === this.generation && this.config.autoSpeak !== false && this.audio && !this.closed;
    if (!active()) return;
    this.clearSpeechSession();
    const session = this.speechSession = { id: randomUUID(), sent: 0, played: 0, waiters: new Set() };
    // Keep owner speech eligible to interrupt even when a long response outlasts
    // the ordinary follow-up window. This does not extend idle listening.
    this.worker?.postMessage({ type: 'playback', active: true });
    this.audio.webContents.send('pulse:voice-command', { type: 'speech-start', id: session.id });
    this.armPlaybackDeadline(session);
    this.setStatus('正在合成语音');
    for (const sentence of speechSentences(text)) {
      if (!active() || this.speechSession !== session) return;
      // At most the playing sentence and one prefetched sentence are outstanding.
      if (session.sent - session.played >= 2) await this.playbackRoom(session);
      if (!active() || this.speechSession !== session) return;
      const speech = await this.request('/api/voice/speech', { method: 'POST', body: JSON.stringify({ text: sentence }) });
      if (!active() || this.speechSession !== session) return;
      this.audio.webContents.send('pulse:voice-command', { type: 'speech-chunk', id: session.id, sequence: session.sent++, ...speech });
      this.armPlaybackDeadline(session);
      this.setStatus('正在播报');
    }
    if (active() && this.speechSession === session) this.audio.webContents.send('pulse:voice-command', { type: 'speech-end', id: session.id });
  }
  armPlaybackDeadline(session) {
    clearTimeout(session.deadline);
    session.deadline = setTimeout(() => {
      if (this.speechSession !== session || this.closed) return;
      this.stopPlayback();
      this.setStatus('播放完成未确认，已停止播报；可重新唤醒，聊天任务继续运行');
    }, 180000);
    session.deadline.unref?.();
  }
  playbackRoom(session) {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); session.waiters.delete(done); resolve(); };
      const timer = setTimeout(() => { session.waiters.delete(done); reject(new Error('VOICE_PLAYBACK_TIMEOUT')); }, 180000);
      session.waiters.add(done);
    });
  }
  chunkPlayed(data) {
    const session = this.speechSession;
    if (!session || data.id !== session.id || !Number.isInteger(data.sequence) || data.sequence !== session.played || data.sequence >= session.sent) return;
    session.played++;
    this.armPlaybackDeadline(session);
    for (const done of session.waiters) done();
  }
  clearSpeechSession() { const session = this.speechSession; this.speechSession = undefined; if (session) { clearTimeout(session.deadline); this.worker?.postMessage({ type: 'playback', active: false }); for (const done of session.waiters) done(); } }
  applySpeechPreference(autoSpeak) {
    const wasEnabled = this.config?.autoSpeak !== false;
    this.config = { ...this.config, autoSpeak };
    if (!autoSpeak && wasEnabled) {
      this.stopPlayback();
      if (this.worker) { this.worker.postMessage({ type: 'followup' }); this.setStatus('自动播报已关闭，可继续追问'); }
    }
  }
  stopPlayback() { this.generation++; this.pending=undefined; this.clearSpeechSession(); this.audio?.webContents.send('pulse:voice-command',{type:'stop'}); }
  stop() { this.lifecycle++; this.stopPlayback(); const worker=this.worker;this.worker=undefined; worker?.kill(); this.audio?.destroy();this.audio=undefined;this.recording=undefined; }
  async localRequest(path, init = {}) {
    if (!['/api/voice/transcribe', '/api/voice/speech', '/api/voice/test'].includes(path) || init.method !== 'POST') return undefined;
    const input = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const kind = path.endsWith('/test') ? input.kind : path.endsWith('/transcribe') ? 'asr' : 'tts';
    if (!['asr', 'tts'].includes(kind)) throw new Error('VOICE_LOCAL_MODEL_INVALID');
    const config = await this.request('/api/voice/config');
    if (config[kind].backend !== 'local') return undefined;
    if (this.closed) throw new Error('VOICE_LOCAL_PROCESS_STOPPED');
    return this.localSpeech.request(path.endsWith('/test') ? 'test' : kind === 'asr' ? 'transcribe' : 'speech', { ...input, voice: config.tts.voice, speed: config.tts.speed, language: config.asr.language });
  }
  beginDictation(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(id)) throw new Error('VOICE_DICTATION_INVALID');
    if (this.dictation && this.dictation !== id) throw new Error('VOICE_DICTATION_BUSY');
    if (!this.dictation) {
      this.dictation = id; this.lifecycle++; this.stopPlayback(); this.recording = undefined;
      this.worker?.postMessage({ type: 'reset' });
      this.audio?.webContents.send('pulse:voice-command', { type: 'close' });
      this.setStatus('聊天语音输入中');
      // Warm the recognizer while the explicit gesture obtains its microphone.
      // Loading a speech model never opens a capture device.
      if (this.config?.asr?.backend === 'local') void this.localSpeech.request('test', { kind: 'asr', language: this.config.asr.language }).catch(() => {});
    }
    clearTimeout(this.dictationTimer);
    this.dictationTimer = setTimeout(() => this.endDictation(id), 30000);
    this.dictationTimer.unref?.();
  }
  endDictation(id = this.dictation) {
    if (!this.dictation || id !== this.dictation) return;
    this.dictation = undefined; clearTimeout(this.dictationTimer);
    this.worker?.postMessage({ type: 'reset' });
    if (this.audio && this.config?.enabled && this.config.wakeEnabled === true && !this.paused && !this.closed) {
      this.audio.webContents.send('pulse:voice-command', { type: 'start', deviceId: this.config.microphoneId });
      this.setStatus(this.speaker ? '等待名字唤醒' : '请先录入主人声纹');
    } else if (!this.closed) this.setStatus(this.paused ? '已暂停' : this.config?.enabled ? '仅按住说话，麦克风未占用' : '已关闭');
  }
  async action(action, input = {}) {
    if (this.closed) throw new Error('VOICE_LOCAL_PROCESS_STOPPED');
    if (action === 'wake-settings') {
      if (typeof input.enabled !== 'boolean') throw new Error('VOICE_WAKE_SETTING_INVALID');
      const latest = await this.request('/api/voice/config');
      const saved = await this.request('/api/voice/config', { method: 'POST', body: JSON.stringify({ ...latest, wakeEnabled: input.enabled }) });
      if (saved.wakeEnabled !== input.enabled) throw new Error('VOICE_WAKE_SETTING_UPDATE_REQUIRED');
      this.preferenceRevision = (this.preferenceRevision ?? 0) + 1;
      this.stop(); this.config = saved; this.signature = undefined; this.paused = false;
      await this.sync();
      return this.snapshot();
    }
    if (action === 'dictation-start') { this.beginDictation(input.id); return { ok: true }; }
    if (action === 'dictation-end') { if (typeof input.id !== 'string') throw new Error('VOICE_DICTATION_INVALID'); this.endDictation(input.id); return { ok: true }; }
    if (action === 'install-asr' || action === 'install-tts') {
      const kind = action.slice('install-'.length);
      const connection = await this.request('/api/voice/local', { method: 'POST', body: JSON.stringify({ kind }) });
      this.localSpeech.install(kind);
      return { ...await this.snapshot(), connection };
    }
    if(action==='speech-settings') { const config = await this.request('/api/voice/config'); this.preferenceRevision = (this.preferenceRevision ?? 0) + 1; this.applySpeechPreference(config.autoSpeak !== false); }
    else if(action==='models') { if(this.downloading)return this.snapshot();this.stop();this.ready=false;this.downloading=true;this.downloadAbort=new AbortController();this.setStatus('准备本地模型…');void installModels(this.modelDirectory,status=>this.setStatus(status),this.downloadAbort.signal).then(()=>{this.ready=true;this.failedSignature=undefined;}).catch(error=>this.setStatus(error.message)).finally(()=>{this.downloading=false;void this.sync();}); }
    else if(action==='pause'){this.paused=true;this.stop();this.setStatus('已暂停');}
    else if(action==='resume'){this.paused=false;this.failedSignature=undefined;await this.sync();}
    else if(action==='stop')this.stopPlayback();
    else if(action==='enroll'){if(!this.worker)throw new Error('请先开启语音助手并准备本地模型');this.stopPlayback();this.worker.postMessage({type:'enroll'});}
    else if(action==='forget'){this.stop();await rm(join(this.root,'speaker.json'),{force:true});this.speaker=undefined;await this.sync();}
    else if(action==='record-test'){if(!this.worker)throw new Error('请先开启语音助手');this.stopPlayback();this.recording=[];this.setStatus('录音测试中，请说话，五秒后转写');}
    else if(action!=='status')throw new Error('VOICE_ACTION_INVALID');
    return this.snapshot();
  }
  close(){this.closed=true;clearTimeout(this.dictationTimer);this.dictation=undefined;this.localSpeech.close();this.downloadAbort?.abort();this.stop();}
}
