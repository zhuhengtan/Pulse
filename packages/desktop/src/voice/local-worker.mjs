import { installLocalModel, localModelReady, compactTtsInstalled, whisperAsrInstalled } from './local-models.mjs';
import { LocalSpeechEngine } from './local-engine.mjs';
let engine, root;
const jobs = new Map(), abort = new AbortController();
const send = value => { if (process.connected) process.send(value); };
process.on('disconnect', () => { abort.abort(); process.exit(0); });
process.on('message', async message => {
  try {
    if (message.type === 'init') {
      root = message.root; engine = new LocalSpeechEngine(root);
      const ready = { asr: await localModelReady(root, 'asr'), tts: await localModelReady(root, 'tts') };
      send({ type: 'ready', ready, compactTts: ready.tts && await compactTtsInstalled(root), legacyAsr: ready.asr && await whisperAsrInstalled(root) }); return;
    }
    if (!engine) throw new Error('VOICE_LOCAL_NOT_READY');
    let result;
    if (message.method === 'install') {
      const kind = message.input.kind;
      if (!['asr', 'tts'].includes(kind)) throw new Error('VOICE_LOCAL_MODEL_INVALID');
      if (!jobs.has(kind)) {
        const work = installLocalModel(root, kind, (stage, received, total) => send({ type: 'progress', kind, stage, received, total }), abort.signal).then(() => {
          send({ type: 'progress', kind, stage: '正在加载本地模型' });
          return engine.request('reload', { kind });
        });
        jobs.set(kind, work); work.finally(() => jobs.delete(kind)).catch(() => undefined);
      }
      await jobs.get(kind); result = { ready: true };
    } else result = await engine.request(message.method, message.input);
    send({ type: 'result', id: message.id, result });
  } catch (error) { send({ type: 'result', id: message.id, error: error.message }); }
});
