import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { localModelReady, localModels, localVoices, compactTtsInstalled, whisperAsrInstalled } from './local-models.mjs';
const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');
const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' });
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });
export function asrLanguage(language = '') {
  const value = language.trim() || 'zh';
  if (!['zh', 'zh-Hant', 'auto', 'en', 'yue', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar', 'hi'].includes(value)) throw new Error('VOICE_LOCAL_LANGUAGE_INVALID');
  return value;
}
export function transcriptText(text, language) {
  return (language === 'zh' ? toSimplified(text) : language === 'zh-Hant' ? toTraditional(text) : text).trim();
}
export function pcmWave(samples, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples.length > 12_000_000) throw new Error('VOICE_AUDIO_TOO_LARGE');
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
  return wav.toString('base64');
}
export function readPcmWave(audio) {
  if (typeof audio !== 'string' || audio.length > 3_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) throw new Error('VOICE_AUDIO_INVALID');
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VOICE_WAV_REQUIRED');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw new Error('VOICE_AUDIO_INVALID');
    if (id === 'fmt ' && size >= 16) format = { type: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (id === 'data') data = bytes.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  if (!format || !data?.length || format.type !== 1 || format.bits !== 16 || format.channels !== 1 || format.sampleRate < 8000 || format.sampleRate > 48000 || data.length % 2 || data.length / 2 > format.sampleRate * 30) throw new Error('VOICE_PCM_MONO_REQUIRED');
  const samples = new Float32Array(data.length / 2); for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: format.sampleRate };
}
export class LocalSpeechEngine {
  constructor(root) { this.root = root; this.models = {}; this.loading = {}; this.tail = Promise.resolve(); }
  load(kind, language = 'zh') {
    if (kind === 'asr') language = asrLanguage(language);
    if (kind === 'asr' && language !== this.language) { delete this.loading.asr; delete this.models.asr; this.language = language; }
    if (!['asr', 'tts'].includes(kind)) return Promise.reject(new Error('VOICE_LOCAL_MODEL_INVALID'));
    return this.loading[kind] ??= this.loadModel(kind).catch(error => { delete this.loading[kind]; throw error; });
  }
  async loadModel(kind) {
    if (this.models[kind]) return this.models[kind];
    if (!await localModelReady(this.root, kind)) throw new Error('VOICE_LOCAL_MODEL_NOT_INSTALLED');
    const sherpa = require('sherpa-onnx-node'), root = join(this.root, kind);
    if (kind === 'asr') {
      const legacy = await whisperAsrInstalled(this.root), language = this.language === 'zh-Hant' ? 'zh' : this.language;
      if (!legacy && !['zh', 'en', 'yue', 'ja', 'ko', 'auto'].includes(language)) throw new Error('VOICE_LOCAL_LANGUAGE_INVALID');
      this.asrModel = legacy ? 'pulse-whisper-base' : localModels.asr.id;
      this.models.asr = await sherpa.OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
        ...(legacy ? { whisper: { encoder: join(root, 'base-encoder.int8.onnx'), decoder: join(root, 'base-decoder.int8.onnx'), language: language === 'auto' ? '' : language, task: 'transcribe', tailPaddings: -1 } } : { senseVoice: { model: join(root, 'model.int8.onnx'), language, useInverseTextNormalization: 1 } }),
        tokens: join(root, legacy ? 'base-tokens.txt' : 'tokens.txt'), numThreads: 2, provider: 'cpu' } });
    }
    else this.models.tts = await sherpa.OfflineTts.createAsync({ model: { kokoro: { model: join(root, await compactTtsInstalled(this.root) ? 'model.int8.onnx' : 'model.onnx'), voices: join(root, 'voices.bin'), tokens: join(root, 'tokens.txt'), dictDir: join(root, 'dict'), lexicon: [join(root, 'lexicon-us-en.txt'), join(root, 'lexicon-zh.txt')].join(','), lang: '' }, numThreads: Math.min(4, availableParallelism()), provider: 'cpu', debug: false }, ruleFsts: ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'].map(file => join(root, file)).join(','), maxNumSentences: 1 });
    return this.models[kind];
  }
  request(method, input) {
    const work = this.tail.catch(() => undefined).then(async () => {
      if (method === 'reload') { delete this.models[input.kind]; delete this.loading[input.kind]; await this.load(input.kind); return { ready: true }; }
      if (method === 'test') { await this.load(input.kind, input.kind === 'asr' ? input.language ?? '' : ''); return { models: [input.kind === 'asr' ? this.asrModel : 'pulse-kokoro-zh-en'] }; }
      if (method === 'transcribe') {
        const language = asrLanguage(input.language);
        const wave = readPcmWave(input.audio), recognizer = await this.load('asr', language), stream = recognizer.createStream();
        stream.acceptWaveform(wave);
        const result = await recognizer.decodeAsync(stream); return { text: transcriptText(result.text, language) };
      }
      if (method !== 'speech' || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12000) throw new Error('VOICE_TEXT_INVALID');
      const voice = input.voice ?? '45'; if (!localVoices.some(item => item.id === voice)) throw new Error('VOICE_LOCAL_VOICE_INVALID');
      const speed = input.speed ?? 1; if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('VOICE_SPEED_INVALID');
      const tts = await this.load('tts'), result = await tts.generateAsync({ text: input.text, sid: Number(voice), speed, enableExternalBuffer: false });
      return { audio: pcmWave(cleanSpeech(result.samples, result.sampleRate ?? tts.sampleRate), result.sampleRate ?? tts.sampleRate), mime: 'audio/wav' };
    }); this.tail = work; return work;
  }
}

/** Remove DC/edge clicks without low-passing speech or changing its pitch. */
export function cleanSpeech(samples, sampleRate) {
  const output = new Float32Array(samples.length), pole = Math.exp(-2 * Math.PI * 20 / sampleRate);
  let previous = 0, filtered = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]; if (!Number.isFinite(sample)) throw new Error('VOICE_AUDIO_INVALID');
    filtered = sample - previous + pole * filtered; previous = sample;
    output[i] = filtered; peak = Math.max(peak, Math.abs(filtered));
  }
  const gain = peak > 0.98 ? 0.98 / peak : 1, fade = Math.min(Math.round(sampleRate * 0.005), Math.floor(samples.length / 2));
  for (let i = 0; i < output.length; i++) output[i] *= gain * Math.min(1, fade ? i / fade : 1, fade ? (output.length - 1 - i) / fade : 1);
  return output;
}
