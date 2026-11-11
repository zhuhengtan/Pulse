import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { localModels, localVoices } from './local-models.mjs';
export class LocalSpeech {
  constructor({ root, node, changed = () => {}, forkProcess = fork }) { Object.assign(this, { root, node, changed, forkProcess }); this.pending = new Map(); this.jobs = {}; this.state = { asr: { ready: false, installing: false }, tts: { ready: false, installing: false } }; }
  snapshot() { return { ...this.state, voices: localVoices, models: { asr: localModels.asr.name, tts: localModels.tts.name } }; }
  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const executable = this.node(); if (!executable || executable === process.execPath && process.versions.electron) { reject(new Error('VOICE_LOCAL_NODE_REQUIRED')); return; }
      const path = fileURLToPath(new URL('./local-worker.mjs', import.meta.url)).replace(/app\.asar([\/\\])/, 'app.asar.unpacked$1');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = this.child = this.forkProcess(path, [], { execPath: executable, execArgv: [], serialization: 'json', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env });
      let diagnostic = '', ready = false;
      this.rejectStart = reject;
      const timer = this.startTimer = setTimeout(() => { reject(new Error('VOICE_LOCAL_START_TIMEOUT')); child.kill(); }, 60000);
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-1000); });
      const stopped = error => {
        clearTimeout(timer); if (this.child !== child) return;
        this.child = undefined; this.starting = undefined; this.rejectStart = undefined; this.startTimer = undefined; if (!ready) reject(error);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear();
        for (const kind of ['asr', 'tts']) if (this.state[kind].installing) this.state[kind] = { ...this.state[kind], installing: false, error: error.message };
        this.changed();
      };
      child.on('error', stopped); child.on('exit', () => stopped(new Error(`VOICE_LOCAL_PROCESS_STOPPED${diagnostic ? ': ' + diagnostic : ''}`)));
      child.on('message', message => {
        if (this.child !== child) return;
        if (message.type === 'ready') { ready = true; clearTimeout(timer); this.rejectStart = undefined; this.startTimer = undefined; for (const kind of ['asr', 'tts']) this.state[kind] = { ...this.state[kind], ready: message.ready[kind] }; this.state.tts = { ...this.state.tts, upgradeAvailable: Boolean(message.compactTts) }; this.state.asr = { ...this.state.asr, upgradeAvailable: Boolean(message.legacyAsr) }; this.changed(); resolve(); }
        else if (message.type === 'progress' && this.state[message.kind]) { this.state[message.kind] = { ...this.state[message.kind], stage: message.stage, ...(message.received === undefined ? {} : { received: message.received }), ...(message.total === undefined ? {} : { total: message.total }) }; this.changed(); }
        else if (message.type === 'result') { const entry = this.pending.get(message.id); if (!entry) return; this.pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); }
      });
      child.send({ type: 'init', root: this.root }, error => { if (error) stopped(error); });
    });
    // A synchronous start failure must also permit retry.
    this.starting.catch(() => { if (!this.child) this.starting = undefined; });
    return this.starting;
  }
  async request(method, input, timeout = 180000) {
    const starting = this.start(); await starting;
    if (starting !== this.starting) throw new Error('VOICE_LOCAL_PROCESS_STOPPED');
    const child = this.child;
    if (!child?.connected) throw new Error('VOICE_LOCAL_PROCESS_STOPPED');
    if (this.pending.size >= 8) throw new Error('VOICE_LOCAL_BUSY');
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { this.pending.delete(id); reject(new Error('VOICE_LOCAL_REQUEST_TIMEOUT')); this.close(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, method, input }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  install(kind) {
    if (!localModels[kind]) throw new Error('VOICE_LOCAL_MODEL_INVALID');
    if (this.state[kind].installing) return;
    const job = this.jobs[kind] = Symbol(kind);
    this.state[kind] = { ...this.state[kind], installing: true, error: undefined, stage: '准备安装', received: 0, total: localModels[kind].size }; this.changed();
    void this.request('install', { kind }, 35 * 60 * 1000).then(() => { if (this.jobs[kind] === job) this.state[kind] = { ...this.state[kind], ready: true, installing: false, upgradeAvailable: false, stage: '安装完成' }; }).catch(error => { if (this.jobs[kind] === job) this.state[kind] = { ...this.state[kind], installing: false, error: error.message }; }).finally(() => this.changed());
  }
  close() {
    const child = this.child; this.child = undefined; this.starting = undefined;
    this.jobs = {};
    clearTimeout(this.startTimer); this.rejectStart?.(new Error('VOICE_LOCAL_PROCESS_STOPPED')); this.rejectStart = undefined; this.startTimer = undefined;
    child?.kill();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('VOICE_LOCAL_PROCESS_STOPPED')); } this.pending.clear();
    for (const kind of ['asr', 'tts']) if (this.state[kind].installing) this.state[kind] = { ...this.state[kind], installing: false, error: '安装已停止，可重试' };
  }
}
