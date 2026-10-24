import { NativeBrowser } from './native-browser.mjs';
import { DesktopInstallation } from './installation.mjs';
import { deviceSessionPartition, restoreDeviceCookie, saveDeviceCookie } from './device-session.mjs';
import { app, BrowserWindow, ipcMain, protocol, net, Menu, dialog, shell, session as electronSession } from 'electron';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { readFile, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { desktopDataDirectory, saveDesktopDataDirectory, assertDesktopDataReady, desktopServiceMessage } from './data-directory.mjs';
import { desktopPageUrl, isDesktopPageUrl } from './dev-url.mjs';
const pageUrl = desktopPageUrl(app.isPackaged, process.env.PULSE_DESKTOP_DEV_URL);
if (process.env.PULSE_DESKTOP_USER_DATA)
    app.setPath('userData', resolve(process.env.PULSE_DESKTOP_USER_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'pulse', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (!app.requestSingleInstanceLock())
    app.quit();
else {
    let directory;
    let window, reader, installation, setupPending, backendInfo, cookie = '', apiSession, base = '', serviceError = '', ownedPid;
    const pendingReads = new Map(), pendingChat = new Map(), subscriptions = new Map(), nativeSockets = new Map();
    const send = (channel, value) => { if (window && !window.isDestroyed())
        window.webContents.send(channel, value); };
    const browser = new NativeBrowser({ window: () => window, notify: value => send('pulse:native-browser', value), protectedUrls: () => [pageUrl, ...(base ? [base] : []), 'http://127.0.0.1:7332'] });
    let browserHost, browserRetry;
    const browserRequests = new Map();
    function connectBrowserHost() {
        if (!base || app.isQuitting || browserHost?.readyState === WebSocket.OPEN || browserHost?.readyState === WebSocket.CONNECTING) return;
        const socket = browserHost = new WebSocket(base.replace('http:', 'ws:') + '/api/automation/native-host', { headers: { Origin: base, Cookie: cookie, 'X-Pulse-Client': 'electron' }, maxPayload: 1024 * 1024 });
        socket.on('message', async raw => {
            let frame; try { frame = JSON.parse(raw.toString()); } catch { return; }
            if (frame.method === 'cancel') { const pending = browserRequests.get(frame.params?.requestId); if (pending) { pending.aborted = true; browser.groups.get(pending.groupId)?.active?.webContents.stop(); } return; }
            const operation = { aborted: false, groupId: frame.params?.id }; browserRequests.set(frame.id, operation);
            try { const result = await browser.dispatch(frame.method, frame.params, operation); if (socket.readyState === WebSocket.OPEN && !operation.aborted) socket.send(JSON.stringify({ id: frame.id, result })); }
            catch (error) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: frame.id, error: error.message })); }
            finally { browserRequests.delete(frame.id); }
        });
        socket.on('error', () => {});
        socket.on('close', () => { if (browserHost === socket) browserHost = undefined; browser.disconnect(); clearTimeout(browserRetry); if (!app.isQuitting) browserRetry = setTimeout(connectBrowserHost, 1500); });
    }
    const allowedPath = path => { if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//') || path.includes('\\') || path.length > 4096)
        throw new Error('API_PATH_INVALID'); return path; };
    const localQuery = path => /^\/api\/(approval-policy$|assistant(?:\?|$)|conversations(?:\?|$|\/[^/]+$)|projects$|data\/conversations\/[^/]+\/(?:messages|body|search)(?:\?|$))/.test(path);
    function query(path) { return new Promise((resolveQuery, reject) => { if (pendingReads.size >= 64) {
        reject(new Error('LOCAL_QUERY_QUEUE_FULL'));
        return;
    } const id = randomUUID(), timer = setTimeout(() => { pendingReads.delete(id); reject(new Error('LOCAL_QUERY_TIMEOUT')); }, 5000); pendingReads.set(id, { resolve: resolveQuery, reject, timer }); reader.postMessage({ id, path }); }); }
    async function http(path, init = {}) {
        if (!base)
            throw new Error(serviceError || 'PULSE_SERVICE_UNAVAILABLE');
        const headers = { 'Origin': base, 'Cookie': cookie, 'X-Pulse-Client': 'electron', 'User-Agent': `Pulse Electron/${app.getVersion()} (${process.platform})`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
        const response = await fetch(base + allowedPath(path), { method: init.method ?? 'GET', headers, ...(typeof init.body === 'string' ? { body: init.body } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            cookie = setCookie.split(';')[0];
            if (apiSession) await saveDeviceCookie(apiSession.cookies, base, setCookie);
        }
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
            const entry = installation.entry;
            const runtime = installation.node;
            const child = spawn(runtime, [entry, 'h5', 'start', '--port', '0', '--data-dir', directory], { detached: true, stdio: 'ignore', cwd: homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PULSE_DATA_DIR: directory, PULSE_H5_HOST: '127.0.0.1', ...(installation.source ? { PULSE_HOME: installation.root, PULSE_CONFIG: installation.state.configPath, PULSE_RUNTIME_ID: installation.state.runtimeId, ...(installation.browserExecutable ? { PULSE_BROWSER_EXECUTABLE: installation.browserExecutable } : {}) } : {}) } });
            child.unref();
            child.on('error', () => { });
            for (let i = 0; i < 600; i++) {
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
        apiSession = electronSession.fromPartition(deviceSessionPartition(directory));
        cookie = await restoreDeviceCookie(apiSession.cookies, base);
        const session = await http('/api/session/local', { method: 'POST' });
        if (!session.ok) { base = ''; throw new Error('PULSE_SERVICE_AUTH_FAILED'); }
        const info = await http('/api/session');
        if (!info.ok) throw new Error('PULSE_SERVICE_AUTH_FAILED');
        const sessionInfo = await info.json();
        backendInfo = { connected: true, version: sessionInfo.serverVersion, pid: sessionInfo.serverPid, outdated: Boolean(installation.source && (sessionInfo.serverVersion !== installation.state.version || sessionInfo.runtimeId !== installation.state.runtimeId)) };
        void connectChat().catch(() => { });
        connectBrowserHost();
    }
    function setupSnapshot() { return { ...installation.snapshot(), dataDirectory: directory, service: { ...backendInfo, connected: Boolean(base), error: serviceError } }; }
    async function prepareDesktop(full = false) {
        if (setupPending) return setupPending;
        setupPending = (async () => {
            try {
                await installation.prepare({ full });
                installation.step('server', '启动本机后台', 'running');
                await ensureService(); serviceError = '';
                installation.step('server', '启动本机后台', backendInfo.outdated ? 'warning' : 'ready', backendInfo.outdated ? '当前后台仍在使用之前的版本，已有任务保持运行。可在此应用后台更新。' : '本机服务已连接');
                installation.state.phase = 'ready';
            } catch (error) {
                base = ''; serviceError = error.message; installation.state.phase = 'error';
                if (!installation.state.error) installation.step('server', '启动本机后台', 'error', desktopServiceMessage(serviceError));
            }
            return setupSnapshot();
        })().finally(() => { setupPending = undefined; });
        return setupPending;
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
    function trusted(event) { if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame || !isDesktopPageUrl(event.senderFrame?.url ?? '', pageUrl))
        throw new Error('IPC_SENDER_INVALID'); }
    app.whenReady().then(async () => {
        directory = await desktopDataDirectory(app.getPath('userData'), process.env, homedir());
        const root = resolve(process.env.PULSE_DESKTOP_INSTALL_ROOT ?? process.env.PULSE_HOME ?? join(homedir(), '.pulse'));
        const source = app.isPackaged ? join(process.resourcesPath, 'runtime') : process.env.PULSE_DESKTOP_RUNTIME_DIR;
        installation = new DesktopInstallation({ root, userData: app.getPath('userData'), source, dataDirectory: directory, packaged: app.isPackaged, node: process.execPath, entry: fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url)), shellHome: process.env.PULSE_DESKTOP_SHELL_HOME ?? (source && !app.isPackaged ? join(app.getPath('userData'), 'shell-profile') : homedir()) });
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
        protocol.handle('pulse', async (request) => {
            const url = new URL(request.url);
            if (url.host !== 'app')
                return new Response('Forbidden', { status: 403 });
            if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/file-preview/')) {
                try {
                    const response = url.pathname.startsWith('/file-preview/') ? await fetch(base + url.pathname + url.search, { redirect: 'error', signal: AbortSignal.timeout(10000) }) : await http(url.pathname + url.search);
                    return new Response(await response.arrayBuffer(), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', 'Content-Disposition': response.headers.get('content-disposition') ?? 'inline', ...(response.headers.get('content-security-policy') ? { 'Content-Security-Policy': response.headers.get('content-security-policy') } : {}), 'X-Content-Type-Options': 'nosniff' } });
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
            if (path === '/api/desktop/setup' && (init.method ?? 'GET') === 'GET') return { status: 200, body: setupSnapshot() };
            if (path === '/api/desktop/setup/data-directory' && init.method === 'POST') { void chooseDataDirectory(); return { status: 202, body: setupSnapshot() }; }
            if (path === '/api/desktop/setup/repair' && init.method === 'POST') { void prepareDesktop(true); return { status: 202, body: setupSnapshot() }; }
            if (path === '/api/desktop/setup/complete' && init.method === 'POST') { await installation.complete(); return { status: 200, body: setupSnapshot() }; }
            if (path === '/api/desktop/setup/restart-service' && init.method === 'POST') {
                const confirmation = await dialog.showMessageBox(window, { type: 'question', message: '应用后台更新？', detail: '后台会短暂重启，执行中的任务会被中断；聊天记录和配置会保留。', buttons: ['取消', '重启后台'], defaultId: 0, cancelId: 0 });
                if (confirmation.response !== 1) return { status: 200, body: setupSnapshot() };
                const descriptor = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
                if (!backendInfo?.pid || descriptor.pid !== backendInfo.pid || Number(new URL(base).port) !== descriptor.port) return { status: 409, body: { error: 'SERVICE_IDENTITY_UNVERIFIED' } };
                chat?.close(); process.kill(descriptor.pid, 'SIGTERM');
                for (let i = 0; i < 200; i++) { try { process.kill(descriptor.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; } await new Promise(resolve => setTimeout(resolve, 50)); }
                try { process.kill(descriptor.pid, 0); return { status: 409, body: { error: 'SERVICE_STILL_RUNNING' } }; } catch (error) { if (error.code !== 'ESRCH') throw error; }
                base = ''; void prepareDesktop(); return { status: 202, body: setupSnapshot() };
            }
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
            const headers = { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', ...(response.headers.get('content-length') ? { 'Content-Length': response.headers.get('content-length') } : {}), ...(response.headers.get('content-disposition') ? { 'Content-Disposition': response.headers.get('content-disposition') } : {}) };
            if (headers['Content-Type'].includes('application/json')) {
                const body = await response.json();
                if (/^\/api\/projects\/[^/]+\/preview-ticket$/.test(path) && typeof body.url === 'string' && /^\/preview\/[0-9a-f-]{36}\/$/.test(body.url)) body.url = base + body.url;
                return { status: response.status, body, headers };
            }
            return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), headers };
        });
        ipcMain.handle('pulse:browser-layout', (event, id, bounds) => {
            trusted(event);
            if (typeof id !== 'string' || bounds && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && Math.abs(bounds[key]) < 100000)) throw new Error('BROWSER_LAYOUT_INVALID');
            browser.layout(id, bounds);
        });
        ipcMain.handle('pulse:browser-dispose', (event, id) => { trusted(event); if (typeof id !== 'string') throw new Error('BROWSER_ID_INVALID'); browser.close(id); });
        ipcMain.handle('pulse:browser-state', (event, id) => { trusted(event); const group = browser.groups.get(id); return group ? { id, tabs: browser.tabs(group), error: group.error || '' } : undefined; });
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
            window = new BrowserWindow({ width: pageUrl.startsWith('http:') ? 1440 : 1200, height: pageUrl.startsWith('http:') ? 950 : 850, minWidth: 390, minHeight: 600, title: pageUrl.startsWith('http:') ? 'Pulse · 开发预览' : 'Pulse', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
            window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url))
                void shell.openExternal(url); return { action: 'deny' }; });
            window.webContents.on('did-start-loading', () => browser.hideAll());
            window.webContents.on('render-process-gone', () => browser.hideAll());
            window.on('resize', () => { for (const group of browser.groups.values()) browser.applyLayout(group); });
            window.webContents.on('will-navigate', (event, url) => { if (!isDesktopPageUrl(url, pageUrl))
                event.preventDefault(); });
            window.on('closed', () => { browser.closeAll(); window = undefined; for (const socket of nativeSockets.values())
                socket.close(); nativeSockets.clear(); for (const sub of subscriptions.values())
                sub.controller.abort(); subscriptions.clear(); });
            void window.loadURL(pageUrl);
        }
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Pulse', submenu: [{ label: '环境检查与修复…', click: () => { if (window) void window.loadURL(pageUrl.startsWith('http:') ? new URL('/settings/desktop', pageUrl).href : 'pulse://app/settings/desktop'); } }, { label: '数据目录…', click: () => void chooseDataDirectory() }, { label: '后台服务状态', click: () => void dialog.showMessageBox(window, { message: base ? '后台服务运行中' : desktopServiceMessage(serviceError), detail: `数据目录：${directory}${base ? `\n服务地址：${base}` : ''}` }) }, { label: '停止后台服务…', click: async () => { const result = await dialog.showMessageBox(window, { message: '停止后台服务会中断执行中的任务。', buttons: ['取消', '停止'], defaultId: 0, cancelId: 0 }); if (result.response === 1 && base) {
                            const descriptor = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
                            process.kill(descriptor.pid, 'SIGTERM');
                            base = '';
                        } } }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
        createWindow();
        void prepareDesktop();
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
        app.on('before-quit', () => { app.isQuitting = true; clearTimeout(browserRetry); browserHost?.close(); browser.closeAll(); clearTimeout(retry); chat?.close(); for (const sub of subscriptions.values())
            sub.controller.abort(); void reader.terminate(); });
    }).catch(error => { console.error('Pulse desktop startup failed:', error.message); app.quit(); });
}
