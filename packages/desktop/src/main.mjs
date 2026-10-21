import { app, BrowserWindow, ipcMain, protocol, net, Menu, dialog, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { readFile, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { desktopDataDirectory, saveDesktopDataDirectory, assertDesktopDataReady, desktopServiceMessage } from './data-directory.mjs';
if (process.env.PULSE_DESKTOP_USER_DATA)
    app.setPath('userData', resolve(process.env.PULSE_DESKTOP_USER_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'pulse', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (!app.requestSingleInstanceLock())
    app.quit();
else {
    let directory;
    let window, reader, cookie = '', base = '', serviceError = '', ownedPid;
    const pendingReads = new Map(), pendingChat = new Map(), subscriptions = new Map(), nativeSockets = new Map();
    const send = (channel, value) => { if (window && !window.isDestroyed())
        window.webContents.send(channel, value); };
    const allowedPath = path => { if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//') || path.includes('\\') || path.length > 4096)
        throw new Error('API_PATH_INVALID'); return path; };
    const localQuery = path => /^\/api\/(approval-policy$|assistant(?:\?|$)|conversations(?:\?|$|\/[^/]+$)|projects$|data\/conversations\/[^/]+\/(?:messages|body|search)(?:\?|$)|runs\/[^/]+\/state$)/.test(path);
    function query(path) { return new Promise((resolveQuery, reject) => { if (pendingReads.size >= 64) {
        reject(new Error('LOCAL_QUERY_QUEUE_FULL'));
        return;
    } const id = randomUUID(), timer = setTimeout(() => { pendingReads.delete(id); reject(new Error('LOCAL_QUERY_TIMEOUT')); }, 5000); pendingReads.set(id, { resolve: resolveQuery, reject, timer }); reader.postMessage({ id, path }); }); }
    async function http(path, init = {}) {
        if (!base)
            throw new Error(serviceError || 'PULSE_SERVICE_UNAVAILABLE');
        const headers = { 'Origin': base, 'Cookie': cookie, ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
        const response = await fetch(base + allowedPath(path), { method: init.method ?? 'GET', headers, ...(typeof init.body === 'string' ? { body: init.body } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie)
            cookie = setCookie.split(';')[0];
        return response;
    }
    let chat, chatConnecting, retry;
    async function connectChat() {
        if (chat?.readyState === WebSocket.OPEN)
            return chat;
        if (chatConnecting)
            return chatConnecting;
        if (!base)
            throw new Error('PULSE_SERVICE_UNAVAILABLE');
        chatConnecting = new Promise((resolveChat, reject) => {
            const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Origin: base, Cookie: cookie } });
            chat = socket;
            socket.once('open', () => { send('pulse:connection', true); for (const sub of subscriptions.values())
                if (sub.kind === 'chat')
                    socket.send(JSON.stringify({ type: 'subscribe', runId: sub.runId, after: sub.after })); resolveChat(socket); });
            socket.on('message', raw => {
                let frame;
                try {
                    frame = JSON.parse(raw.toString());
                }
                catch {
                    return;
                }
                if (frame.type === 'response') {
                    const request = pendingChat.get(frame.id);
                    if (request) {
                        pendingChat.delete(frame.id);
                        clearTimeout(request.timer);
                        request.resolve({ status: frame.status, body: frame.body });
                    }
                }
                if (frame.type === 'event')
                    for (const [id, sub] of subscriptions)
                        if (sub.kind === 'chat' && sub.runId === frame.event.runId && (frame.event.type === 'resync' || (frame.event.seq ?? 0) > sub.after)) {
                            sub.after = frame.event.seq ?? 0;
                            send('pulse:event', { id, event: frame.event });
                        }
                if (frame.type === 'changed')
                    send('pulse:changed', frame.revision);
            });
            socket.on('error', reject);
            socket.on('close', () => { send('pulse:connection', false); chatConnecting = undefined; for (const p of pendingChat.values()) {
                clearTimeout(p.timer);
                p.reject(new Error('CHAT_DISCONNECTED'));
            } pendingChat.clear(); reject(new Error('CHAT_DISCONNECTED')); clearTimeout(retry); if (!app.isQuitting)
                retry = setTimeout(() => void connectChat().catch(() => { }), 1500); });
        }).finally(() => { chatConnecting = undefined; });
        return chatConnecting;
    }
    async function chatRequest(path, init) { const socket = await connectChat(); return new Promise((resolveRequest, reject) => { if (pendingChat.size >= 32) {
        reject(new Error('CHAT_QUEUE_FULL'));
        return;
    } const id = randomUUID(), timer = setTimeout(() => { pendingChat.delete(id); reject(new Error('CHAT_REQUEST_TIMEOUT')); }, 10000); pendingChat.set(id, { resolve: resolveRequest, reject, timer }); socket.send(JSON.stringify({ type: 'request', id, path, method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(init.body) } : {}) })); }); }
    async function ensureService() {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await assertDesktopDataReady(directory);
        const saved = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (saved?.pid) {
            try {
                process.kill(saved.pid, 0);
                if (saved.protocol !== 1 || !Number.isInteger(saved.port))
                    throw new Error('SERVICE_INCOMPATIBLE');
                base = `http://127.0.0.1:${saved.port}`;
            }
            catch (error) {
                if (error.code !== 'ESRCH')
                    throw error;
                else
                    base = '';
            }
        }
        if (!base) {
            const entry = app.isPackaged ? join(process.resourcesPath, 'runtime/app/node_modules/@hunterzhu/pulse-cli/dist/bin.js') : fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
            const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;
            const child = spawn(runtime, [entry, 'h5', 'start', '--port', '0', '--data-dir', directory], { detached: true, stdio: 'ignore', cwd: homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PULSE_DATA_DIR: directory, PULSE_H5_HOST: '127.0.0.1' } });
            child.unref();
            child.on('error', () => { });
            for (let i = 0; i < 160; i++) {
                const descriptor = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse).catch(() => undefined);
                if (descriptor?.protocol === 1 && descriptor.pid === child.pid) {
                    base = `http://127.0.0.1:${descriptor.port}`;
                    ownedPid = child.pid;
                    break;
                }
                await new Promise(resolveWait => setTimeout(resolveWait, 50));
            }
            if (!base)
                throw new Error('PULSE_SERVICE_START_FAILED');
        }
        const session = await http('/api/session/local', { method: 'POST' });
        if (!session.ok) { base = ''; throw new Error('PULSE_SERVICE_AUTH_FAILED'); }
        void connectChat().catch(() => { });
    }
    async function chooseDataDirectory() {
        const selected = await dialog.showOpenDialog(window, {
            title: '选择 Pulse 数据目录', defaultPath: directory,
            message: '选择包含 pulse.sqlite 的数据目录。切换将重启桌面窗口，后台任务会继续运行。',
            properties: ['openDirectory', 'showHiddenFiles'], buttonLabel: '使用此目录',
        });
        if (selected.canceled || !selected.filePaths[0]) return;
        const next = resolve(selected.filePaths[0]);
        try {
            await assertDesktopDataReady(next);
            await saveDesktopDataDirectory(app.getPath('userData'), next);
        } catch (error) {
            await dialog.showMessageBox(window, { type: 'warning', message: desktopServiceMessage(error.message), detail: `数据目录：${next}` });
            return;
        }
        // A directory explicitly chosen in the UI replaces a one-off launch override.
        delete process.env.PULSE_DESKTOP_DATA_DIR;
        delete process.env.PULSE_DATA_DIR;
        app.relaunch();
        app.quit();
    }
    function trusted(event) { if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame || !event.senderFrame?.url.startsWith('pulse://app/'))
        throw new Error('IPC_SENDER_INVALID'); }
    app.whenReady().then(async () => {
        directory = await desktopDataDirectory(app.getPath('userData'), process.env, homedir());
        reader = new Worker(new URL('./read-worker.mjs', import.meta.url), { workerData: { directory } });
        reader.on('message', value => { const item = pendingReads.get(value.id); if (item) {
            clearTimeout(item.timer);
            pendingReads.delete(value.id);
            item.resolve(value);
        } });
        reader.on('error', error => { for (const item of pendingReads.values()) {
            clearTimeout(item.timer);
            item.reject(error);
        } pendingReads.clear(); });
        try {
            await ensureService();
        }
        catch (error) {
            base = '';
            serviceError = error.message;
        }
        protocol.handle('pulse', async (request) => {
            const url = new URL(request.url);
            if (url.host !== 'app')
                return new Response('Forbidden', { status: 403 });
            if (url.pathname.startsWith('/api/')) {
                try {
                    const response = await http(url.pathname + url.search);
                    return new Response(await response.arrayBuffer(), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', 'Content-Disposition': response.headers.get('content-disposition') ?? 'inline' } });
                }
                catch {
                    return new Response('Service unavailable', { status: 503 });
                }
            }
            const web = app.isPackaged ? join(process.resourcesPath, 'web') : fileURLToPath(new URL('../../web/dist', import.meta.url));
            const resource = url.pathname.startsWith('/assets/') ? resolve(web, '.' + decodeURIComponent(url.pathname)) : join(web, 'index.html');
            if (!resource.startsWith(web + (process.platform === 'win32' ? '\\' : '/')))
                return new Response('Forbidden', { status: 403 });
            const response = await net.fetch(pathToFileURL(resource).href);
            const headers = new Headers(response.headers);
            headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'");
            return new Response(response.body, { status: response.status, headers });
        });
        ipcMain.handle('pulse:request', async (event, path, init = {}) => {
            trusted(event);
            allowedPath(path);
            if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(init.method ?? 'GET') || init.body && typeof init.body !== 'string')
                throw new Error('API_REQUEST_INVALID');
            if ((init.method ?? 'GET') === 'GET' && localQuery(path))
                return query(path);
            if (path === '/api/desktop/reconnect') {
                base = '';
                serviceError = '';
                try {
                    await ensureService();
                    return { status: 200, body: { ok: true } };
                }
                catch (error) {
                    serviceError = error.message;
                    return { status: 503, body: { error: serviceError } };
                }
            }
            if (path === '/api/session' || path === '/api/session/local') {
                try {
                    const response = await http(path, init);
                    return { status: response.status, body: { ...await response.json(), connected: true } };
                }
                catch {
                    return { status: 200, body: { connected: false, localAdmin: false, canUseTerminal: false, canBrowseHostPaths: false, canRegisterProject: false } };
                }
            }
            if (path.startsWith('/api/assistant'))
                return chatRequest(path, init);
            const response = await http(path, init);
            const headers = { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', ...(response.headers.get('content-disposition') ? { 'Content-Disposition': response.headers.get('content-disposition') } : {}) };
            if (headers['Content-Type'].includes('application/json')) {
                const body = await response.json();
                if (/^\/api\/projects\/[^/]+\/preview-ticket$/.test(path) && typeof body.url === 'string' && /^\/preview\/[0-9a-f-]{36}\/$/.test(body.url)) body.url = base + body.url;
                return { status: response.status, body, headers };
            }
            return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), headers };
        });
        ipcMain.handle('pulse:socket-open', (event, id, path) => {
            trusted(event);
            if (typeof id !== 'string' || id.length > 80 || nativeSockets.size >= 8 || !(/^\/api\/terminals\/[0-9a-f-]{36}\/socket$/.test(path) || path === '/api/automation/socket'))
                throw new Error('SOCKET_PATH_INVALID');
            const socket = new WebSocket(base.replace('http:', 'ws:') + path, { headers: { Origin: base, Cookie: cookie }, maxPayload: 2 * 1024 * 1024 });
            nativeSockets.set(id, socket);
            socket.on('open', () => send('pulse:socket', { id, type: 'open' }));
            socket.on('message', raw => send('pulse:socket', { id, type: 'message', data: raw.toString() }));
            socket.on('error', () => send('pulse:socket', { id, type: 'error' }));
            socket.on('close', () => { nativeSockets.delete(id); send('pulse:socket', { id, type: 'close' }); });
        });
        ipcMain.handle('pulse:socket-send', (event, id, value) => { trusted(event); if (typeof value !== 'string' || value.length > 16384)
            throw new Error('SOCKET_INPUT_INVALID'); const socket = nativeSockets.get(id); if (socket?.readyState === WebSocket.OPEN)
            socket.send(value); });
        ipcMain.handle('pulse:socket-close', (event, id) => { trusted(event); nativeSockets.get(id)?.close(); nativeSockets.delete(id); });
        ipcMain.handle('pulse:service', event => { trusted(event); return { connected: Boolean(base), error: serviceError }; });
        ipcMain.handle('pulse:stop-service', async (event) => { trusted(event); const confirmation = await dialog.showMessageBox(window, { type: 'question', message: '停止后台服务？正在执行的任务会中断。', buttons: ['保留运行', '停止服务'], defaultId: 0, cancelId: 0 }); if (confirmation.response === 1) {
            const descriptor = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse);
            process.kill(descriptor.pid, 'SIGTERM');
            base = '';
            chat?.close();
        } });
        ipcMain.handle('pulse:subscribe', async (event, kind, runId, after) => {
            trusted(event);
            if (!['chat', 'work'].includes(kind) || !/^run-[a-zA-Z0-9-]+$/.test(runId) || !Number.isFinite(after) || subscriptions.size >= 16)
                throw new Error('SUBSCRIPTION_INVALID');
            const id = randomUUID(), sub = { kind, runId, after, controller: new AbortController() };
            subscriptions.set(id, sub);
            if (kind === 'chat') {
                const open = chat?.readyState === WebSocket.OPEN;
                const socket = await connectChat();
                if (open)
                    socket.send(JSON.stringify({ type: 'subscribe', runId, after }));
            }
            else
                void (async () => { let delay = 300; while (!sub.controller.signal.aborted) {
                    try {
                        const response = await fetch(base + `/api/runs/${encodeURIComponent(runId)}/events?after=${sub.after}`, { headers: { Origin: base, Cookie: cookie }, signal: sub.controller.signal });
                        if (!response.ok)
                            throw new Error('STREAM_UNAVAILABLE');
                        const stream = response.body.getReader(), decoder = new TextDecoder();
                        let buffer = '';
                        while (!sub.controller.signal.aborted) {
                            const chunk = await stream.read();
                            if (chunk.done)
                                break;
                            buffer += decoder.decode(chunk.value, { stream: true });
                            let newline;
                            while ((newline = buffer.indexOf('\n\n')) >= 0) {
                                const frame = buffer.slice(0, newline);
                                buffer = buffer.slice(newline + 2);
                                for (const line of frame.split('\n'))
                                    if (line.startsWith('data:')) {
                                        const value = JSON.parse(line.slice(5));
                                        if (value.type === 'resync' || (value.seq ?? 0) > sub.after) {
                                            sub.after = value.seq;
                                            send('pulse:event', { id, event: value });
                                        }
                                        if (value.type === 'run_finished')
                                            return;
                                    }
                            }
                        }
                        delay = 300;
                    }
                    catch { }
                    if (!sub.controller.signal.aborted) {
                        await new Promise(r => setTimeout(r, delay));
                        delay = Math.min(delay * 2, 10000);
                    }
                } })();
            return id;
        });
        ipcMain.handle('pulse:unsubscribe', (event, id) => { trusted(event); const sub = subscriptions.get(id); sub?.controller.abort(); subscriptions.delete(id); if (sub?.kind === 'chat' && chat?.readyState === WebSocket.OPEN)
            chat.send(JSON.stringify({ type: 'unsubscribe', runId: sub.runId })); });
        function createWindow() {
            window = new BrowserWindow({ width: 1200, height: 850, minWidth: 390, minHeight: 600, title: 'Pulse', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
            window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url))
                void shell.openExternal(url); return { action: 'deny' }; });
            window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('pulse://app/'))
                event.preventDefault(); });
            window.on('closed', () => { window = undefined; for (const socket of nativeSockets.values())
                socket.close(); nativeSockets.clear(); for (const sub of subscriptions.values())
                sub.controller.abort(); subscriptions.clear(); });
            void window.loadURL('pulse://app/chat');
        }
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Pulse', submenu: [{ label: '数据目录…', click: () => void chooseDataDirectory() }, { label: '后台服务状态', click: () => void dialog.showMessageBox(window, { message: base ? '后台服务运行中' : desktopServiceMessage(serviceError), detail: `数据目录：${directory}${base ? `\n服务地址：${base}` : ''}` }) }, { label: '停止后台服务…', click: async () => { const result = await dialog.showMessageBox(window, { message: '停止后台服务会中断执行中的任务。', buttons: ['取消', '停止'], defaultId: 0, cancelId: 0 }); if (result.response === 1 && base) {
                            const descriptor = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
                            process.kill(descriptor.pid, 'SIGTERM');
                            base = '';
                        } } }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
        createWindow();
        if (serviceError === 'DATA_MIGRATION_REQUIRED' || serviceError === 'DATA_MIGRATION_IN_PROGRESS') {
            void dialog.showMessageBox(window, { type: 'warning', message: desktopServiceMessage(serviceError), detail: `数据目录：${directory}`, buttons: ['选择数据目录…', '稍后'], defaultId: 0, cancelId: 1 })
                .then(result => { if (result.response === 0) return chooseDataDirectory(); });
        }
        app.on('activate', () => { if (!BrowserWindow.getAllWindows().length)
            createWindow(); });
        app.on('second-instance', () => { if (window) {
            if (window.isMinimized())
                window.restore();
            window.focus();
        }
        else
            createWindow(); });
        app.on('window-all-closed', () => app.quit());
        app.on('before-quit', () => { app.isQuitting = true; clearTimeout(retry); chat?.close(); for (const sub of subscriptions.values())
            sub.controller.abort(); void reader.terminate(); });
    }).catch(error => { console.error('Pulse desktop startup failed:', error.message); app.quit(); });
}
