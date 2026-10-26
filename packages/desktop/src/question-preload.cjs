const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pulseQuestion', Object.freeze({
    state: () => ipcRenderer.invoke('pulse:question-state'),
    submit: answers => ipcRenderer.invoke('pulse:question-submit', answers),
    openFull: () => ipcRenderer.invoke('pulse:question-open-full'),
    close: () => ipcRenderer.invoke('pulse:question-close'),
}));
