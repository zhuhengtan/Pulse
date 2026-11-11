import { VoiceController } from './controller.mjs';
import { fileURLToPath } from 'node:url';

// Keep device routing separate from the existing wake/ASR/TTS state machine.
export class DeviceVoiceController extends VoiceController {
  constructor(options) {
    super(options);
    const request = this.request;
    this.request = async (path, init) => {
      const value = await request(path, init);
      if (this.syncing && path === '/api/voice/config' && !init?.method && this.signature) {
        const previous = JSON.parse(this.signature);
        const { autoSpeak, ...captureConfig } = value;
        const { speakerId: oldSpeaker, ...oldCapture } = previous;
        const { speakerId: newSpeaker, ...newCapture } = captureConfig;
        // The inherited controller includes every config field in its capture
        // signature. Output-only changes must not reopen a microphone.
        if (JSON.stringify(oldCapture) === JSON.stringify(newCapture)) this.signature = JSON.stringify(captureConfig);
      }
      return value;
    };
    this.outputDevices = [];
    this.outputState = { state: 'unavailable', deviceId: '' };
    this.onDeviceAudio = (event, data) => {
      const live = this.audio && event.sender === this.audio.webContents;
      const probe = this.deviceProbe && event.sender === this.deviceProbe.webContents;
      const preview = this.outputPreview && event.sender === this.outputPreview.webContents;
      if ((!live && !probe && !preview) || event.senderFrame !== event.sender.mainFrame) return;
      if (data?.type === 'ready') {
        if (live) this.applyOutput();
        else if (preview) event.sender.send('pulse:voice-command', { type: 'select-output', deviceId: this.previewDeviceId });
        else event.sender.send('pulse:voice-command', { type: 'enumerate-devices' });
      } else if (probe && data?.type === 'devices' && Array.isArray(data.devices)) {
        this.devices = data.devices.slice(0, 256).filter(device => device && typeof device.id === 'string' && typeof device.label === 'string').map(device => ({ id: device.id.slice(0, 500), label: device.label.slice(0, 500) }));
      } else if (data?.type === 'output-devices' && Array.isArray(data.devices)) {
        this.outputDevices = data.devices.slice(0, 256).filter(device => device && typeof device.id === 'string' && typeof device.label === 'string').map(device => ({ id: device.id.slice(0, 500), label: device.label.slice(0, 500) }));
        if (probe) {
          const deviceId = this.config?.speakerId ?? '';
          this.outputState = { deviceId, state: !deviceId || this.outputDevices.some(device => device.id === deviceId) ? 'ready' : 'unavailable' };
          this.finishDeviceProbe?.();
        }
        this.changed?.();
      } else if (preview && data?.type === 'output-state') {
        if (data.state !== 'ready') this.finishOutputPreview?.(new Error('VOICE_OUTPUT_UNAVAILABLE'));
        else if (!this.previewStarted) { this.previewStarted = true; event.sender.send('pulse:voice-command', { type: 'play', ...this.previewAudio }); }
      } else if (preview && data?.type === 'played') this.finishOutputPreview?.();
      else if (preview && ['playback-error', 'error'].includes(data?.type)) this.finishOutputPreview?.(new Error(String(data.error ?? 'VOICE_OUTPUT_FAILED')));
      else if (data?.type === 'output-state' && live && ['ready', 'unavailable', 'error'].includes(data.state)) {
        this.outputState = { state: data.state, deviceId: String(data.deviceId ?? '').slice(0, 500) };
        // A lost output discards playback, never the existing background task.
        if (data.state !== 'ready') { this.stopPlayback(); this.setStatus('播报设备不可用，请重新连接或选择输出；聊天任务继续运行'); }
        this.changed?.();
      }
    };
    this.ipcMain.on('pulse:voice-audio', this.onDeviceAudio);
  }
  applyOutput() {
    if (!this.audio) return;
    this.audio.webContents.send('pulse:voice-command', { type: 'select-output', deviceId: this.config?.speakerId ?? '' });
  }
  async sync() {
    const speakerId = this.config?.speakerId;
    await super.sync();
    if (this.config?.speakerId !== speakerId) { this.stopOutputPreview(); this.stopPlayback(); this.applyOutput(); }
  }
  async snapshot() { return { ...await super.snapshot(), outputDevices: this.outputDevices, outputState: this.outputState }; }
  async listDevices() {
    if (this.audio) { this.audio.webContents.send('pulse:voice-command', { type: 'enumerate-devices' }); return this.snapshot(); }
    if (this.probingDevices) return this.probingDevices;
    this.probingDevices = (async () => {
      const partition = this.session.fromPartition('pulse-voice');
      // Enumeration does not open a microphone or request permission.
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      const probe = this.deviceProbe = new this.BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { preload: fileURLToPath(new URL('./audio-preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, session: partition } });
      probe.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      probe.webContents.on('will-navigate', event => event.preventDefault());
      let timeout;
      try {
        const devices = new Promise((resolve, reject) => { this.finishDeviceProbe = resolve; timeout = setTimeout(() => reject(new Error('VOICE_AUDIO_DEVICES_TIMEOUT')), 3000); });
        await Promise.all([devices, probe.loadFile(fileURLToPath(new URL('./audio.html', import.meta.url)))]);
      } finally { clearTimeout(timeout); this.finishDeviceProbe = undefined; if (!probe.isDestroyed()) probe.destroy(); if (this.deviceProbe === probe) this.deviceProbe = undefined; }
      return this.snapshot();
    })().finally(() => { this.probingDevices = undefined; });
    return this.probingDevices;
  }
  stopOutputPreview() { this.outputPreviewGeneration = (this.outputPreviewGeneration ?? 0) + 1; this.finishOutputPreview?.(new Error('VOICE_OUTPUT_PREVIEW_CANCELLED')); }
  async previewOutput(input) {
    if (typeof input.audio !== 'string' || !input.audio.length || input.audio.length > 32_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.audio) || input.mime !== 'audio/wav') throw new Error('VOICE_OUTPUT_PREVIEW_INVALID');
    if (this.outputPreview) throw new Error('VOICE_OUTPUT_PREVIEW_BUSY');
    const generation = this.outputPreviewGeneration ?? 0;
    const config = await this.request('/api/voice/config');
    if (this.closed || generation !== (this.outputPreviewGeneration ?? 0)) throw new Error('VOICE_OUTPUT_PREVIEW_CANCELLED');
    if (this.outputPreview) throw new Error('VOICE_OUTPUT_PREVIEW_BUSY');
    // Media IDs are partition/origin scoped. Preview in the same audio host,
    // never by giving its saved ID to the main UI's different origin.
    const partition = this.session.fromPartition('pulse-voice');
    if (!this.audio) {
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
    }
    const preview = this.outputPreview = new this.BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { preload: fileURLToPath(new URL('./audio-preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, session: partition } });
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    preview.webContents.on('will-navigate', event => event.preventDefault());
    this.previewDeviceId = config.speakerId ?? '';
    this.previewAudio = { audio: input.audio, mime: input.mime }; this.previewStarted = false;
    let timeout;
    try {
      const finished = new Promise((resolve, reject) => { this.finishOutputPreview = error => error ? reject(error) : resolve({ ok: true }); timeout = setTimeout(() => reject(new Error('VOICE_OUTPUT_PREVIEW_TIMEOUT')), 30_000); });
      // Attach the rejection handler immediately, including before loadFile.
      const loaded = preview.loadFile(fileURLToPath(new URL('./audio.html', import.meta.url)));
      return await Promise.all([finished, loaded]).then(([result]) => result);
    } finally {
      clearTimeout(timeout); if (!preview.isDestroyed()) preview.destroy();
      if (this.outputPreview === preview) { this.outputPreview = undefined; this.finishOutputPreview = undefined; this.previewAudio = undefined; }
    }
  }
  async action(action, input = {}) {
    if (action === 'preview-stop') { this.stopOutputPreview(); return { ok: true }; }
    if (action === 'preview-output') { if (this.closed) throw new Error('VOICE_LOCAL_PROCESS_STOPPED'); return this.previewOutput(input); }
    if (action === 'stop' || action === 'pause') this.stopOutputPreview();
    if (action === 'list-devices') { if (this.closed) throw new Error('VOICE_LOCAL_PROCESS_STOPPED'); return this.listDevices(); }
    return super.action(action, input);
  }
  close() { this.stopOutputPreview(); this.finishDeviceProbe?.(); if (this.deviceProbe && !this.deviceProbe.isDestroyed()) this.deviceProbe.destroy(); this.deviceProbe = undefined; this.ipcMain.removeListener?.('pulse:voice-audio', this.onDeviceAudio); super.close(); }
}
