import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keywordDirectory } from './models.mjs';
import { keywordPronunciations } from './keywords.mjs';
const require = createRequire(import.meta.url);
export function encodeWav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return bytes.toString('base64');
}
export class VoiceEngine {
  constructor(directory, config, speaker, emit) {
    const sherpa = require('sherpa-onnx-node'), root = join(directory, keywordDirectory);
    const lexicon = new Map(readFileSync(join(root, 'en.phone'), 'utf8').trim().split('\n').map(line => { const [word, ...phones] = line.trim().split(/\s+/); return [word, phones]; }));
    const tokens = new Set(readFileSync(join(root, 'tokens.txt'), 'utf8').split('\n').map(line => line.split(' ')[0]));
    const words = [[config.name, 'wake'], ['停止', 'stop'], ['结束对话', 'end'], ['stop', 'stop'], ['goodbye', 'end']];
    const keywordsFile = join(directory, 'keywords.txt');
    writeFileSync(keywordsFile, words.flatMap(([word, label]) => keywordPronunciations(word, lexicon, tokens).map(pronunciation => `${pronunciation} @${label}`)).join('\n') + '\n', { mode: 0o600 });
    const suffix = 'epoch-13-avg-2-chunk-16-left-64';
    this.kws = new sherpa.KeywordSpotter({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: join(root, `encoder-${suffix}.int8.onnx`), decoder: join(root, `decoder-${suffix}.onnx`), joiner: join(root, `joiner-${suffix}.int8.onnx`) }, tokens: join(root, 'tokens.txt'), numThreads: 1, provider: 'cpu', modelType: 'zipformer2' }, keywordsFile, keywordsThreshold: config.wakeThreshold, keywordsScore: 1.5 });
    this.vad = new sherpa.Vad({ sileroVad: { model: join(directory, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.65, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu' }, 35);
    this.extractor = new sherpa.SpeakerEmbeddingExtractor({ model: join(directory, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'), numThreads: 1, provider: 'cpu' });
    Object.assign(this, { config, speaker, emit }); this.activeUntil = 0; this.playbackActive = false; this.enrolling = false;
  }
  embedding(samples) { const stream = this.extractor.createStream(); stream.acceptWaveform({ samples, sampleRate: 16000 }); stream.inputFinished(); return this.extractor.isReady(stream) ? Array.from(this.extractor.compute(stream)) : undefined; }
  matches(vector) {
    if (!vector || !this.speaker || vector.length !== this.speaker.length) return false;
    let dot = 0, a = 0, b = 0; vector.forEach((v, i) => { dot += v * this.speaker[i]; a += v*v; b += this.speaker[i] ** 2; });
    return dot / Math.sqrt(a*b) >= this.config.speakerThreshold;
  }
  rememberAudio(samples) {
    this.history ??= new Float32Array(35 * 16000); this.historySamples ??= 0;
    const start = this.historySamples % this.history.length, first = Math.min(samples.length, this.history.length - start);
    this.history.set(samples.subarray(0, first), start); if (first < samples.length) this.history.set(samples.subarray(first), 0);
    this.historySamples += samples.length;
  }
  segmentAudio(segment) {
    if (!Number.isInteger(segment.start)) return segment.samples;
    const start = Math.max(0, segment.start - 3200), end = segment.start + segment.samples.length;
    if (start < this.historySamples - this.history.length || end > this.historySamples) return segment.samples;
    const samples = new Float32Array(end - start), at = start % this.history.length, first = Math.min(samples.length, this.history.length - at);
    samples.set(this.history.subarray(at, at + first)); if (first < samples.length) samples.set(this.history.subarray(0, samples.length - first), first);
    return samples;
  }
  detectKeyword(samples) {
    // VAD segments have a fresh time origin: keyword timestamps stay aligned even
    // after long idle periods or native keyword resets.
    const stream = this.kws.createStream(); let wake;
    const padded = new Float32Array(samples.length + 16000); padded.set(samples);
    for (let i = 0; i < padded.length; i += 4096) {
      stream.acceptWaveform({ samples: padded.subarray(i, i + 4096), sampleRate: 16000 });
      while (this.kws.isReady(stream)) {
        this.kws.decode(stream); const result = this.kws.getResult(stream);
        if (result.keyword === 'stop' || result.keyword === 'end') return result;
        if (result.keyword) { wake ??= result; this.kws.reset(stream); }
      }
    }
    return wake;
  }
  accept(samples) {
    if (!(samples instanceof Float32Array) || samples.length > 32000 || samples.some(v => !Number.isFinite(v))) return;
    this.rememberAudio(samples); this.vad.acceptWaveform(samples);
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false); this.vad.pop();
      if (this.enrolling) {
        const vector = this.embedding(segment.samples);
        if (segment.samples.length >= 32000 && vector) { this.enrolling = false; this.speaker = vector; this.emit({ type: 'enrolled', vector }); }
        continue;
      }
      const utterance = this.segmentAudio(segment);
      const detection = this.detectKeyword(utterance), keyword = detection?.keyword;
      if (!keyword && !this.playbackActive && Date.now() >= this.activeUntil) continue;
      if (!this.matches(this.embedding(segment.samples))) { if (keyword) this.emit({ type: 'status', status: '未匹配主人声纹，未发送语音' }); continue; }
      if (keyword === 'stop' || keyword === 'end') { this.playbackActive = false; if (keyword === 'end') this.activeUntil = 0; this.emit({ type: keyword }); continue; }
      if (keyword === 'wake' || this.playbackActive || Date.now() < this.activeUntil) {
        let command = utterance;
        if (keyword === 'wake') {
          command = trimWakeAudio(utterance, detection);
          if (!command) { this.emit({ type: 'status', status: '唤醒词定位失败，请重新叫名字' }); continue; }
          if (command.length < 4000 || rms(command) < 0.006) { this.activeUntil = Date.now() + this.config.followupSeconds * 1000; this.emit({ type: 'wake' }); continue; }
          // A wake decoder reset can consume the beginning of an immediately
          // following control word. Recheck the isolated command before ASR.
          const control = this.detectKeyword(command)?.keyword;
          if (control === 'stop' || control === 'end') { this.playbackActive = false; if (control === 'end') this.activeUntil = 0; this.emit({ type: control }); continue; }
        }
        this.activeUntil = Date.now() + this.config.followupSeconds * 1000;
        this.emit({ type: 'utterance', audio: encodeWav(command), wake: keyword === 'wake', wakeTrimmed: keyword === 'wake' });
      }
    }
  }
}
function rms(samples) { let energy = 0; for (const value of samples) energy += value * value; return Math.sqrt(energy / Math.max(1, samples.length)); }
export function trimWakeAudio(samples, detection) {
  const last = detection?.timestamps?.at(-1);
  if (!Number.isFinite(last) || last < 0 || last * 16000 >= samples.length) return undefined;
  // Token timestamps mark phoneme emission, not its end. Prefer the first quiet
  // boundary after the last token; never guess/delete characters in ASR output.
  const begin = Math.min(samples.length, Math.round((last + 0.04) * 16000));
  const end = Math.min(samples.length, Math.round((last + 0.32) * 16000));
  let boundary = Math.min(samples.length, Math.round((last + 0.08) * 16000));
  for (let i = begin; i + 160 <= end; i += 80) {
    if (rms(samples.subarray(i, i + 160)) < 0.012) { boundary = i + 160; break; }
  }
  return samples.slice(boundary);
}
