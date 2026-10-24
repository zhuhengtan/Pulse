const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, listener) => { const receive = (_event, value) => listener(value); ipcRenderer.on(channel, receive); return () => ipcRenderer.removeListener(channel, receive); };
contextBridge.exposeInMainWorld('pulseDesktop', {
    installation: true,
    nativeBrowser: true,
    browserLayout: (id, bounds) => ipcRenderer.invoke('pulse:browser-layout', id, bounds),
    browserDispose: id => ipcRenderer.invoke('pulse:browser-dispose', id),
    browserState: id => ipcRenderer.invoke('pulse:browser-state', id),
    browserEvents: listener => subscribe('pulse:native-browser', listener),
    request: (path, init) => ipcRenderer.invoke('pulse:request', path, init),
    connections: listener => subscribe('pulse:connection', listener),
    changes: listener => subscribe('pulse:changed', listener),
    subscribe: (kind, runId, after) => ipcRenderer.invoke('pulse:subscribe', kind, runId, after),
    unsubscribe: id => ipcRenderer.invoke('pulse:unsubscribe', id),
    events: listener => subscribe('pulse:event', listener),
    openSocket: (id, path) => ipcRenderer.invoke('pulse:socket-open', id, path),
    sendSocket: (id, value) => ipcRenderer.invoke('pulse:socket-send', id, value),
    closeSocket: id => ipcRenderer.invoke('pulse:socket-close', id),
    sockets: listener => subscribe('pulse:socket', listener),
    service: () => ipcRenderer.invoke('pulse:service'),
    stopService: () => ipcRenderer.invoke('pulse:stop-service')
});
