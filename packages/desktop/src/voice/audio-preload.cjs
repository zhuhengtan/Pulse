const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceAudio', Object.freeze({
  send: value => ipcRenderer.send('pulse:voice-audio', value),
  receive: listener => ipcRenderer.on('pulse:voice-command', (_event, value) => listener(value)),
}));
