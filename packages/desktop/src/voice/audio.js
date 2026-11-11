let stream, context, processor, source, player, playbackUrl;
let captureGeneration = 0;
let outputDeviceId = '', outputGeneration = 0;
async function reportDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  window.voiceAudio.send({ type: 'devices', devices: devices.filter(device => device.kind === 'audioinput').map(device => ({ id: device.deviceId, label: device.label })) });
  const outputs = devices.filter(device => device.kind === 'audiooutput').map(device => ({ id: device.deviceId, label: device.label }));
  window.voiceAudio.send({ type: 'output-devices', devices: outputs });
  if (outputDeviceId && !outputs.some(device => device.id === outputDeviceId)) {
    stopPlayback();
    window.voiceAudio.send({ type: 'output-state', deviceId: outputDeviceId, state: 'unavailable' });
  } else window.voiceAudio.send({ type: 'output-state', deviceId: outputDeviceId, state: 'ready' });
}
async function selectOutput(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length > 500) throw new Error('VOICE_OUTPUT_INVALID');
  if (deviceId !== outputDeviceId) { outputGeneration++; stopPlayback(); }
  outputDeviceId = deviceId;
  await reportDevices();
}
let speechId, receiving = false, queue = [], nextSequence = 0, legacy = false;
function releasePlayer() { if (player) { const previous = player; player = undefined; previous.onended = previous.onerror = null; previous.pause(); previous.src = ''; } if (playbackUrl) URL.revokeObjectURL(playbackUrl); playbackUrl = undefined; }
function stopPlayback() { speechId = undefined; receiving = false; queue = []; nextSequence = 0; releasePlayer(); }
function drained() { if (speechId && !receiving && !player && !queue.length) { const id = speechId, wasLegacy = legacy; speechId = undefined; window.voiceAudio.send(wasLegacy ? { type: 'played' } : { type: 'played', id }); } }
async function playNext() {
  if (player || !queue.length) { drained(); return; }
  const chunk = queue.shift(), id = speechId;
  try {
    const bytes = Uint8Array.from(atob(chunk.audio), ch => ch.charCodeAt(0));
    playbackUrl = URL.createObjectURL(new Blob([bytes], { type: chunk.mime }));
    const current = player = new Audio(playbackUrl);
    current.onended = () => { if (player !== current || speechId !== id) return; releasePlayer(); window.voiceAudio.send({ type: 'chunk-played', id, sequence: chunk.sequence }); void playNext(); };
    current.onerror = () => { if (player !== current || speechId !== id) return; const error = current.error?.message || '音频播放失败'; stopPlayback(); window.voiceAudio.send({ type: 'playback-error', id, error }); };
    const routeGeneration = outputGeneration;
    if (outputDeviceId) {
      if (typeof current.setSinkId !== 'function') throw new Error('VOICE_OUTPUT_UNSUPPORTED');
      await current.setSinkId(outputDeviceId);
    }
    if (player !== current || speechId !== id || routeGeneration !== outputGeneration) return;
    try { await current.play(); } catch (error) { if (player === current && speechId === id) throw error; }
  } catch (error) { if (speechId === id) { stopPlayback(); window.voiceAudio.send({ type: 'playback-error', id, error: error.message }); } }
}
async function closeAudio() {
  captureGeneration++;
  const previousStream = stream, previousContext = context, previousProcessor = processor, previousSource = source;
  stream = context = processor = source = undefined; stopPlayback();
  previousStream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); previousProcessor?.disconnect(); previousSource?.disconnect();
  await previousContext?.close();
}
window.voiceAudio.receive(async command => {
  let operationGeneration;
  try {
    if (command.type === 'start') {
      const closing = closeAudio(), generation = captureGeneration; operationGeneration = generation; await closing;
      if (generation !== captureGeneration) return;
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { ...(command.deviceId ? { deviceId: { exact: command.deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== captureGeneration) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      if (generation !== captureGeneration) return;
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = event => {
        if (generation !== captureGeneration) return;
        const input = event.inputBuffer.getChannelData(0), ratio = context.sampleRate / 16000;
        const output = new Float32Array(Math.floor(input.length / ratio));
        for (let i = 0; i < output.length; i++) { const start = Math.floor(i*ratio), end = Math.max(start+1, Math.floor((i+1)*ratio)); let total = 0; for(let j=start;j<end;j++) total += input[j] ?? 0; output[i]=total/(end-start); }
        window.voiceAudio.send({ type: 'samples', samples: Array.from(output), peak: Math.max(...Array.from(output, Math.abs)) });
      };
      source.connect(processor); processor.connect(context.destination);
      stream.getAudioTracks()[0].onended = () => { if (generation === captureGeneration) window.voiceAudio.send({ type: 'error', error: '麦克风已断开，请重新选择设备并恢复语音助手' }); };
      await reportDevices();
    } else if (command.type === 'select-output') await selectOutput(command.deviceId ?? '');
    else if (command.type === 'enumerate-devices') await reportDevices();
    else if (command.type === 'stop') stopPlayback();
    else if (command.type === 'close') await closeAudio();
    else if (command.type === 'speech-start') { stopPlayback(); speechId = command.id; receiving = true; legacy = false; }
    else if (command.type === 'speech-chunk') {
      if (!receiving || speechId !== command.id || command.sequence !== nextSequence) return;
      if (queue.length >= 2 || typeof command.audio !== 'string' || command.audio.length > 32_000_000) { const id = speechId; stopPlayback(); window.voiceAudio.send({ type: 'playback-error', id, error: 'VOICE_PLAYBACK_QUEUE_INVALID' }); return; }
      nextSequence++; queue.push(command); void playNext();
    }
    else if (command.type === 'speech-end') { if (speechId === command.id) { receiving = false; drained(); } }
    else if (command.type === 'play') { stopPlayback(); speechId = 'legacy'; legacy = true; queue.push({ ...command, sequence: 0 }); void playNext(); }

  } catch (error) { if (operationGeneration === undefined || operationGeneration === captureGeneration) window.voiceAudio.send({ type: 'error', error: error.message }); }
});
if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => { void reportDevices().catch(error => window.voiceAudio.send({ type: 'output-state', deviceId: outputDeviceId, state: 'error', error: error.message })); });
}
window.voiceAudio.send({ type: 'ready' });
