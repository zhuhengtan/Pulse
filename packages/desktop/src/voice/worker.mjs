import { VoiceEngine } from './engine.mjs';
let engine;
const send = value => process.send?.(value);
process.on('disconnect', () => process.exit(0));
process.on('message', data => {
  try {
    if (data.type === 'init') { engine = new VoiceEngine(data.directory, data.config, data.speaker, send); send({ type: 'ready' }); }
    else if (data.type === 'samples') engine?.accept(new Float32Array(data.samples));
    else if (data.type === 'reset' && engine) { engine.vad.reset(); engine.history = undefined; engine.historySamples = 0; engine.activeUntil = 0; engine.playbackActive = false; engine.enrolling = false; }
    else if (data.type === 'enroll') { engine.enrolling = true; send({ type: 'status', status: '请连续说一句至少两秒的话，停顿后保存声纹' }); }
    else if (data.type === 'playback' && engine) engine.playbackActive = data.active === true;
    else if (data.type === 'followup') engine.activeUntil = Date.now() + engine.config.followupSeconds * 1000;
  } catch (error) { send({ type: 'error', error: error.message }); }
});
