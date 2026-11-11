import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { x } from 'tar';
const require = createRequire(import.meta.url);
export const compactTtsModel = { id: 'pulse-kokoro-zh-en', name: 'Kokoro（紧凑版）', directory: 'kokoro-int8-multi-lang-v1_0', tag: 'tts-models', file: 'kokoro-int8-multi-lang-v1_0.tar.bz2', size: 132353410, sha256: '72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653', required: ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt', 'lexicon-us-en.txt'] };
export const whisperAsrModel = { id: 'pulse-whisper-base', name: 'Whisper Base（多语言）', directory: 'sherpa-onnx-whisper-base', tag: 'asr-models', file: 'sherpa-onnx-whisper-base.tar.bz2', size: 207557382, sha256: '911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de', required: ['base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt', 'Whisper.LICENSE'] };
export const localModels = {
  asr: { id: 'pulse-sensevoice-small', name: 'SenseVoice Small（中英日韩粤）', directory: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', tag: 'asr-models', file: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2', size: 163002883, sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e', required: ['model.int8.onnx', 'tokens.txt', 'LICENSE', 'SenseVoice.MODEL_LICENSE'] },
  tts: { id: 'pulse-kokoro-zh-en', name: 'Kokoro（中英标准音质）', directory: 'kokoro-multi-lang-v1_0', tag: 'tts-models', file: 'kokoro-multi-lang-v1_0.tar.bz2', size: 349886476, sha256: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4', required: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt', 'lexicon-us-en.txt'] },
};
export const localVoices = [{ id: '45', name: '晓北 · 中文女声' }, { id: '46', name: '晓妮 · 中文女声' }, { id: '47', name: '晓晓 · 中文女声' }, { id: '48', name: '晓伊 · 中文女声' }, { id: '49', name: '云健 · 中文男声' }, { id: '50', name: '云希 · 中文男声' }, { id: '51', name: '云夏 · 中文男声' }, { id: '52', name: '云扬 · 中文男声' }, { id: '3', name: 'Heart · 英文女声' }];
export async function fileHash(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function files(root, prefix = '') { const result = []; for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) { const name = prefix + entry.name; if (entry.isDirectory()) result.push(...await files(root, name + '/')); else if (entry.isFile() && name !== 'installation.json') result.push(name); } return result; }
export async function localModelReady(root, kind, catalog = localModels, allowCompact = true) {
  const model = catalog[kind]; if (!model) return false;
  try {
    const directory = join(root, kind), receipt = JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8'));
    if (allowCompact && catalog === localModels && kind === 'tts' && receipt.archiveSha256 === compactTtsModel.sha256) return localModelReady(root, kind, { tts: compactTtsModel }, false);
    if (allowCompact && catalog === localModels && kind === 'asr' && receipt.archiveSha256 === whisperAsrModel.sha256) return localModelReady(root, kind, { asr: whisperAsrModel }, false);
    if (receipt.archiveSha256 !== model.sha256 || model.required.some(name => !receipt.hashes?.[name])) return false;
    for (const [name, hash] of Object.entries(receipt.hashes)) {
      if (name.split('/').some(part => !part || part === '..' || part === '.') || name.includes('\\') || name.startsWith('/') || await fileHash(join(directory, name)) !== hash) return false;
    }
    return true;
  } catch { return false; }
}
export async function compactTtsInstalled(root) { return localModelReady(root, 'tts', { tts: compactTtsModel }, false); }
export async function whisperAsrInstalled(root) { return localModelReady(root, 'asr', { asr: whisperAsrModel }, false); }
export async function installLocalModel(root, kind, progress, signal, options = {}) {
  const catalog = options.catalog ?? localModels, model = catalog[kind]; if (!model) throw new Error('VOICE_LOCAL_MODEL_INVALID');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = join(root, `${kind}.installing`), destination = join(root, kind), backup = join(root, `${kind}.backup`), archive = join(staging, 'model.tar.bz2');
  // Only one installation of each kind is admitted by the host. Recover its previous interrupted swap.
  const destinationExists = await stat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!destinationExists) { try { await rename(backup, destination); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (await localModelReady(root, kind, catalog, false)) { await rm(backup, { recursive: true, force: true }); progress('模型已就绪', model.size, model.size); return; }
  await rm(staging, { recursive: true, force: true }); await mkdir(staging, { mode: 0o700 });
  const budget = AbortSignal.timeout(options.budgetMs ?? 30 * 60 * 1000), combined = signal ? AbortSignal.any([signal, budget]) : budget;
  let backedUp = false;
  try {
    progress('正在下载', 0, model.size);
    const response = await (options.fetch ?? fetch)(options.url ?? `https://github.com/k2-fsa/sherpa-onnx/releases/download/${model.tag}/${model.file}`, { signal: combined });
    if (!response.ok || !response.body) throw new Error('VOICE_MODEL_DOWNLOAD_FAILED');
    let received = 0, last = 0; const hash = createHash('sha256');
    async function* chunks() { for await (const chunk of response.body) { combined.throwIfAborted(); received += chunk.length; if (received > model.size) throw new Error('VOICE_MODEL_SIZE_INVALID'); hash.update(chunk); if (Date.now() - last > 300) { progress('正在下载', received, model.size); last = Date.now(); } yield chunk; } }
    await pipeline(Readable.from(chunks()), createWriteStream(archive, { mode: 0o600 }), { signal: combined });
    if (received !== model.size || hash.digest('hex') !== model.sha256) throw new Error('VOICE_MODEL_CHECKSUM_MISMATCH');
    combined.throwIfAborted(); progress('正在校验并解压', received, model.size);
    const extracted = join(staging, 'extracted'); await mkdir(extracted);
    // Extraction is in the independent Node worker, never on Electron's UI thread.
    const decoded = require('seek-bzip').decode(await readFile(archive));
    await pipeline(Readable.from(decoded), x({ cwd: extracted, strict: true, filter: (path, entry) => path.startsWith(model.directory + '/') && !path.split('/').includes('..') && !path.includes('\\') && ['File', 'Directory'].includes(entry.type) }), { signal: combined });
    const incoming = join(extracted, model.directory), hashes = {};
    if (kind === 'asr' && catalog === localModels) await writeFile(join(incoming, 'SenseVoice.MODEL_LICENSE'), await readFile(new URL('./licenses/SenseVoice.MODEL_LICENSE', import.meta.url)));
    for (const name of await files(incoming)) hashes[name] = await fileHash(join(incoming, name));
    if (model.required.some(name => !hashes[name])) throw new Error('VOICE_MODEL_FILES_MISSING');
    await writeFile(join(incoming, 'installation.json'), JSON.stringify({ archiveSha256: model.sha256, hashes }));
    combined.throwIfAborted();
    await rm(backup, { recursive: true, force: true });
    try { await rename(destination, backup); backedUp = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(incoming, destination); } catch (error) { if (backedUp) await rename(backup, destination); throw error; }
    await rm(backup, { recursive: true, force: true }); progress('模型已就绪', model.size, model.size);
  } catch (error) { if (budget.aborted && !signal?.aborted) throw new Error('VOICE_MODEL_DOWNLOAD_TIMEOUT'); throw error; }
  finally { await rm(staging, { recursive: true, force: true }); }
}
