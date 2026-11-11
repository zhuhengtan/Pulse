import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { x } from 'tar';
const require = createRequire(import.meta.url);
export const keywordDirectory = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';
const keywordFiles = {
  'tokens.txt': '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0',
  'en.phone': 'f7000ec3a90544c0c7c16090d8951779c2b322e14dad5006290f498567d439ea',
  'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx': '408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48',
  'decoder-epoch-13-avg-2-chunk-16-left-64.onnx': '63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21',
  'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx': '190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1',
};
export const voiceModels = [
  { tag: 'kws-models', file: keywordDirectory + '.tar.bz2', size: 32885699, sha256: '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6' },
  { tag: 'speaker-recongition-models', file: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx', size: 39593761, sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b' },
  { tag: 'asr-models', file: 'silero_vad.onnx', size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function modelsReady(directory) {
  try { for (const model of voiceModels) if (digest(await readFile(join(directory, model.file))) !== model.sha256) return false; for (const [file, expected] of Object.entries(keywordFiles)) if (digest(await readFile(join(directory, keywordDirectory, file))) !== expected) return false; return true; } catch { return false; }
}
export const modelDownloadBudgetMs = 30 * 60 * 1000;
export async function installModels(directory, progress, signal, options = {}) {
  const budgetMs = options.budgetMs ?? modelDownloadBudgetMs;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const model of options.models ?? voiceModels) {
    let data = await readFile(join(directory, model.file)).catch(() => undefined);
    if (!data || digest(data) !== model.sha256) {
      progress(`下载 ${model.file}`);
      // One bounded budget covers headers and the whole body; the caller's signal still cancels it.
      const limit = AbortSignal.timeout(budgetMs), combined = signal ? AbortSignal.any([signal, limit]) : limit;
      const chunks = []; let size = 0;
      try {
        const response = await (options.fetch ?? fetch)(`${options.baseUrl ?? 'https://github.com/k2-fsa/sherpa-onnx/releases/download'}/${model.tag}/${model.file}`, { signal: combined });
        if (!response.ok || !response.body) throw new Error('VOICE_MODEL_DOWNLOAD_FAILED');
        for await (const chunk of response.body) { size += chunk.length; if (size > model.size) throw new Error('VOICE_MODEL_SIZE_INVALID'); chunks.push(chunk); }
      } catch (error) {
        if (limit.aborted && !signal?.aborted) throw new Error('VOICE_MODEL_DOWNLOAD_TIMEOUT');
        throw error;
      }
      data = Buffer.concat(chunks);
      if (size !== model.size || digest(data) !== model.sha256) throw new Error('VOICE_MODEL_CHECKSUM_MISMATCH');
      const temporary = join(directory, model.file + '.tmp'); await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, join(directory, model.file));
    }
    if (model.file.endsWith('.bz2')) {
      const temporary = join(directory, 'extract'); await mkdir(temporary, { recursive: true });
      try {
        await pipeline(Readable.from(require('seek-bzip').decode(data)), x({ cwd: temporary, strict: true, filter: (path, entry) => path.startsWith(keywordDirectory + '/') && !path.split('/').includes('..') && ['File', 'Directory'].includes(entry.type) }));
        await rm(join(directory, keywordDirectory), { recursive: true, force: true });
        await rename(join(temporary, keywordDirectory), join(directory, keywordDirectory));
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
  progress('本地模型已就绪');
}
