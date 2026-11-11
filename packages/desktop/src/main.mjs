import { desktopServiceFetch, desktopServiceTimeout, desktopServiceJson } from './service-http.mjs';
import { developmentControl } from './development-control.mjs';
import { loginStartupEnabled, setLoginStartup } from './login-startup.mjs';
import { DeviceVoiceController as VoiceController } from './voice/device-controller.mjs';
import { notificationBadge } from './notification-badge.mjs';
import { windowChrome, configureWindowChrome } from './window-chrome.mjs';
import { createTrayIcon } from './tray-icon.mjs';
import { shouldRevealMain } from './desktop-activation.mjs';
import { QuestionWindows } from './question-windows.mjs';
import { TaskNotifications, readNotificationLaunch, matchTaskNotice } from './task-notifications.mjs';
import { isOwnedService, restoreOwnedService, cliShellCommand, cliWindowsScript, observeServiceStartup, serviceMonitorAction, serviceRuntimeEnvironment } from './background-service.mjs';
import { selectedFrontend, verifySelectedFile } from './update-loader.mjs';
import { controlUpdate } from './update-control.mjs';
import { NativeBrowser } from './native-browser.mjs';
import { DesktopInstallation } from './installation.mjs';
import { deviceSessionPartition, restoreDeviceCookie, saveDeviceCookie } from './device-session.mjs';
import { app, BrowserWindow, ipcMain, protocol, net, Menu, dialog, shell, session as electronSession, Tray, nativeImage, Notification, powerMonitor } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, mkdir, open, rm, writeFile, rename } from 'node:fs/promises';
import { join, resolve, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { desktopDataDirectory, saveDesktopDataDirectory, assertDesktopDataReady, desktopServiceMessage } from './data-directory.mjs';
import { desktopPageUrl, isDesktopPageUrl } from './dev-url.mjs';
let exitRequested = false;
function quitDesktop() { exitRequested = true; app.quit(); }
let notificationLaunch;
app.on('ready', (_event, info) => { notificationLaunch = readNotificationLaunch(info); });
const pageUrl = desktopPageUrl(app.isPackaged, process.env.PULSE_DESKTOP_DEV_URL);
const appIcon = fileURLToPath(new URL('./assets/icon.png', import.meta.url));
if (process.env.PULSE_DESKTOP_USER_DATA)
    app.setPath('userData', resolve(process.env.PULSE_DESKTOP_USER_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'pulse', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (!app.requestSingleInstanceLock())
    quitDesktop();
else {
    let directory;
    let window, reader, installation, setupPending, backendInfo, cookie = '', apiSession, base = '', serviceError = '', ownedPid, serviceStoppedByUser = false, serviceVersionBlocked = false;
    const pendingReads = new Map(), pendingChat = new Map(), subscriptions = new Map(), nativeSockets = new Map();
    const send = (channel, value) => { if (window && !window.isDestroyed())
        window.webContents.send(channel, value); };
    const browser = new NativeBrowser({ window: () => window, notify: value => send('pulse:native-browser', value), protectedUrls: () => [pageUrl, ...(base ? [base] : []), 'http://127.0.0.1:7332'] });
    let browserHost, browserRetry, tray, voice, notifications, questionWindows, trayBusy = false, lastTraySignature = '';
    let showDesktop = () => {}, updateTray = () => {};
    let appMenuReady = false, appPendingSignature = '', activationReady = false;
    let diagnostics, diagnosticLog;
    const diagnosticDirectory = () => join(app.getPath('userData'), 'logs');
    const ownershipFile = () => join(app.getPath('userData'), `owned-service-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.json`);
    const notificationFile = () => join(app.getPath('userData'), 'task-notifications.json');
    const browserRequests = new Map();
    function connectBrowserHost() {
        if (!base || serviceVersionBlocked || app.isQuitting || browserHost?.readyState === WebSocket.OPEN || browserHost?.readyState === WebSocket.CONNECTING) return;
        const socket = browserHost = new WebSocket(base.replace('http:', 'ws:') + '/api/automation/native-host', { headers: { Origin: base, Cookie: cookie, 'X-Pulse-Client': 'electron', 'X-Pulse-Native-Protocol': '1' }, maxPayload: 1024 * 1024 });
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
    async function query(path) { if (serviceVersionBlocked) throw new Error('PREVIEW_BACKEND_VERSION_MISMATCH'); await ensureReader(); return new Promise((resolveQuery, reject) => { if (pendingReads.size >= 64) {
        reject(new Error('LOCAL_QUERY_QUEUE_FULL'));
        return;
    } const id = randomUUID(), timer = setTimeout(() => { pendingReads.delete(id); reject(new Error('LOCAL_QUERY_TIMEOUT')); }, 5000); pendingReads.set(id, { resolve: resolveQuery, reject, timer }); reader.send({ protocol: 1, id, path }); }); }
    async function http(path, init = {}) {
        if (serviceVersionBlocked && !['/api/session', '/api/session/local'].includes(path)) throw new Error('PREVIEW_BACKEND_VERSION_MISMATCH');
        if (!base)
            throw new Error(serviceError || 'PULSE_SERVICE_UNAVAILABLE');
        const headers = { 'Origin': base, 'Cookie': cookie, 'X-Pulse-Client': 'electron', 'X-Pulse-Shell-Version': app.getVersion(), 'X-Pulse-Chromium': process.versions.chrome.split('.')[0], 'User-Agent': `Pulse Electron/${app.getVersion()} (${process.platform})`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
        const method = init.method ?? 'GET';
        const requestPath = allowedPath(path);
        const response = await desktopServiceFetch(base + requestPath, { method, headers, ...(typeof init.body === 'string' ? { body: init.body } : {}) }, desktopServiceTimeout(method, requestPath));
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            cookie = setCookie.split(';')[0];
            if (apiSession) await saveDeviceCookie(apiSession.cookies, base, setCookie);
        }
        return response;
    }
    let chat, chatConnecting, retry;
    async function connectChat() {
        if (serviceVersionBlocked) throw new Error('PREVIEW_BACKEND_VERSION_MISMATCH');
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
        serviceVersionBlocked = false;
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
            const child = spawn(runtime, [entry, 'h5', 'start', '--port', '0', '--data-dir', directory], { windowsHide: true, detached: true, stdio: 'ignore', cwd: homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PULSE_DATA_DIR: directory, PULSE_H5_HOST: '127.0.0.1', PULSE_DESKTOP_DIAGNOSTICS: '1', PULSE_LOG_DIR: diagnosticDirectory(), ...serviceRuntimeEnvironment(installation) } });
            child.unref();
            diagnosticLog?.record('launch', { pid: child.pid, dataDirectory: directory });
            const startupFailure = observeServiceStartup(child, diagnosticLog);
            for (let i = 0; i < 600; i++) {
                const failure = startupFailure();
                if (failure) throw new Error(failure);
                const descriptor = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse).catch(() => undefined);
                if (descriptor?.protocol === 1 && (descriptor.pid === child.pid || descriptor.supervisorPid === child.pid)) {
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
        const descriptor = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (!ownedPid) ownedPid = restoreOwnedService(descriptor, await readFile(ownershipFile(), 'utf8').then(JSON.parse).catch(() => undefined), sessionInfo.serverPid, sessionInfo.serverInstanceId);
        if (isOwnedService(descriptor, ownedPid, sessionInfo.serverPid) && descriptor.instanceId === sessionInfo.serverInstanceId) {
            await mkdir(app.getPath('userData'), { recursive: true });
            const temporary = ownershipFile() + '.tmp';
            await writeFile(temporary, JSON.stringify({ instanceId: descriptor.instanceId, launchedPid: ownedPid, pid: descriptor.pid }), { mode: 0o600 });
            await rename(temporary, ownershipFile());
        }
        if (installation.runtimePolicy === 'bundled' && backendInfo.outdated) {
            serviceVersionBlocked = true; serviceStoppedByUser = true;
            chat?.close(); browserHost?.close();
            throw new Error('PREVIEW_BACKEND_VERSION_MISMATCH');
        }
        await ensureReader();
        void connectChat().catch(() => { });
        connectBrowserHost();
        await notifications?.sync().catch(() => undefined);
        updateTray();
    }
    let readerRuntime;
    async function ensureReader() {
        if (!installation) throw new Error('READER_NOT_READY');
        if (!installation.state.version) await installation.prepare();
        const entry = installation.source ? resolve(dirname(installation.entry), '../../pulse-server/dist/updates/reader.js') : fileURLToPath(new URL('../../server/dist/updates/reader.js', import.meta.url));
        if (reader?.connected && readerRuntime === entry) return;
        if (reader?.connected) reader.disconnect(); reader?.kill('SIGTERM');
        for (const item of pendingReads.values()) { clearTimeout(item.timer); item.reject(new Error('READER_RECONNECTING')); } pendingReads.clear();
        const web = app.isPackaged ? join(process.resourcesPath, 'web') : fileURLToPath(new URL('../../web/dist', import.meta.url));
        readerRuntime = entry;
        reader = spawn(installation.node, [entry, directory, installation.root, web], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        reader.on('message', value => { const item = pendingReads.get(value.id); if (item) { clearTimeout(item.timer); pendingReads.delete(value.id); item.resolve(value); } });
        const failed = () => { for (const item of pendingReads.values()) { clearTimeout(item.timer); item.reject(new Error('READER_DISCONNECTED')); } pendingReads.clear(); };
        reader.on('error', failed); reader.on('exit', failed);
    }
    function setupSnapshot() { return { ...installation.snapshot(), dataDirectory: directory, service: { ...backendInfo, connected: Boolean(base) && !serviceVersionBlocked, error: serviceError } }; }
    async function prepareDesktop(full = false) {
        if (setupPending) return setupPending;
        serviceStoppedByUser = false;
        setupPending = (async () => {
            try {
                await installation.prepare({ full });
                installation.step('server', '启动本机后台', 'running');
                await ensureService(); serviceError = '';
                installation.step('server', '启动本机后台', backendInfo.outdated ? 'warning' : 'ready', backendInfo.outdated ? '当前后台仍在使用之前的版本，已有任务保持运行。可在此应用后台更新。' : '本机服务已连接');
                installation.state.phase = 'ready';
            } catch (error) {
                diagnosticLog?.record('prepare-error', { name: error.name, message: error.message });
                if (error.message !== 'PREVIEW_BACKEND_VERSION_MISMATCH') base = '';
                serviceError = error.message; installation.state.phase = 'error';
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
        quitDesktop();
    }
    async function stopOwnedService() {
        const descriptor = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (!isOwnedService(descriptor, ownedPid, backendInfo?.pid)) {
            await dialog.showMessageBox({ type: 'info', message: '此后台由其他入口启动，托盘不会停止它。请使用原入口停止服务。' }); return false;
        }
        const result = await dialog.showMessageBox({ type: 'question', message: '停止此托盘启动的后台服务？', detail: '执行中的任务会中断，数据保留。', buttons: ['保留运行', '停止服务'], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return false;
        // Invalidate in-flight probes before signalling. Join any setup that
        // already started so it cannot launch a replacement after this stop.
        serviceStoppedByUser = true;
        await setupPending;
        // Recheck after the dialog: the user may have restarted the service elsewhere.
        const current = await readFile(join(directory, 'service.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (!isOwnedService(current, ownedPid, backendInfo?.pid) || current.port !== descriptor.port) throw new Error('SERVICE_IDENTITY_CHANGED');
        const response = await http('/api/session');
        if (!response.ok || (await response.json()).serverPid !== current.pid) throw new Error('SERVICE_IDENTITY_CHANGED');
        process.kill(current.pid, 'SIGTERM');
        let stopped = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            try { process.kill(current.pid, 0); } catch (error) { if (error.code === 'ESRCH') { stopped = true; break; } throw error; }
            await new Promise(resolveWait => setTimeout(resolveWait, 50));
        }
        if (!stopped) throw new Error('SERVICE_STOP_PENDING');
        await rm(ownershipFile(), { force: true });
        base = ''; backendInfo = undefined; ownedPid = undefined; serviceError = '后台服务已停止';
        chat?.close(); browserHost?.close(); updateTray(); return true;
    }
    async function openCli() {
        const command = cliShellCommand(installation.node, installation.entry, { ...(installation.runtimePolicy === 'bundled' ? serviceRuntimeEnvironment(installation) : {}), PULSE_HOME: installation.root, PULSE_DATA_DIR: directory, ...(installation.state.configPath ? { PULSE_CONFIG: installation.state.configPath } : {}) });
        if (process.platform === 'darwin') {
            const child = spawn('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate']);
            child.on('error', () => showDesktop('/settings/desktop'));
        } else {
            // A script opened by the OS retains an interactive terminal and shared data/config.
            const path = join(app.getPath('temp'), `pulse-cli-${process.pid}.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
            const { writeFile } = await import('node:fs/promises');
            const script = process.platform === 'win32' ? cliWindowsScript(installation.node, installation.entry, { ...(installation.runtimePolicy === 'bundled' ? serviceRuntimeEnvironment(installation) : {}), PULSE_HOME: installation.root, PULSE_DATA_DIR: directory, ...(installation.state.configPath ? { PULSE_CONFIG: installation.state.configPath } : {}) }) : `#!/bin/sh\n${command}\n`;
            await writeFile(path, script, { mode: 0o700 });
            if (process.platform === 'win32') await shell.openPath(path);
            else { const child = spawn('x-terminal-emulator', ['-e', 'sh', path]); child.on('error', () => showDesktop('/settings/desktop')); }
        }
    }
    function trusted(event) { if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame || !isDesktopPageUrl(event.senderFrame?.url ?? '', pageUrl))
        throw new Error('IPC_SENDER_INVALID'); }
    app.whenReady().then(async () => {
        if (!app.isPackaged && process.env.PULSE_DESKTOP_DEV_URL && process.env.PULSE_DESKTOP_USER_DATA) {
            const closeControl = await developmentControl({ userData: app.getPath('userData'), appPath: app.getAppPath(), quit: quitDesktop });
            app.once('will-quit', closeControl);
        }
        if (process.platform === 'darwin') app.dock?.setIcon(appIcon);
        directory = await desktopDataDirectory(app.getPath('userData'), process.env, homedir());
        const root = resolve(process.env.PULSE_DESKTOP_INSTALL_ROOT ?? process.env.PULSE_HOME ?? join(homedir(), '.pulse'));
        const source = app.isPackaged ? join(process.resourcesPath, 'runtime') : process.env.PULSE_DESKTOP_RUNTIME_DIR;
        const packageBuild = await readFile(join(app.getAppPath(), 'preview-build.json'), 'utf8').then(JSON.parse).catch(() => ({}));
        const installationEnv = packageBuild.channel === 'preview' ? { ...process.env, PULSE_DESKTOP_RUNTIME_POLICY: 'bundled' } : process.env;
        installation = new DesktopInstallation({ env: installationEnv, root, userData: app.getPath('userData'), source, dataDirectory: directory, packaged: app.isPackaged, node: process.execPath, entry: fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url)), shellVersion: app.getVersion(), chromium: Number(process.versions.chrome.split('.')[0]), shellHome: process.env.PULSE_DESKTOP_SHELL_HOME ?? (source && !app.isPackaged ? join(app.getPath('userData'), 'shell-profile') : homedir()) });
        const diagnosticEntry = source ? join(source, 'app/node_modules/@hunterzhu/pulse-server/dist/diagnostics.js') : fileURLToPath(new URL('../../server/dist/diagnostics.js', import.meta.url));
        diagnostics = await import(pathToFileURL(diagnosticEntry).href).catch(() => undefined);
        try { if (diagnostics) diagnosticLog = new diagnostics.LocalDiagnosticLog(diagnosticDirectory(), 'desktop-launcher.log'); } catch { /* UI can still explain unavailable logs. */ }

        protocol.handle('pulse', async (request) => {
            const url = new URL(request.url);
            if (url.host !== 'app')
                return new Response('Forbidden', { status: 403 });
            if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/file-preview/')) {
                if (serviceVersionBlocked) return Response.json({ error: 'PREVIEW_BACKEND_VERSION_MISMATCH' }, { status: 503 });
                try {
                    const response = url.pathname.startsWith('/file-preview/') ? await fetch(base + url.pathname + url.search, { redirect: 'error', headers: { Cookie: cookie, Origin: base }, signal: AbortSignal.timeout(10000) }) : await http(url.pathname + url.search);
                    return new Response(await response.arrayBuffer(), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', 'Content-Disposition': response.headers.get('content-disposition') ?? 'inline', ...(response.headers.get('content-security-policy') ? { 'Content-Security-Policy': response.headers.get('content-security-policy') } : {}), 'X-Content-Type-Options': 'nosniff' } });
                }
                catch {
                    return new Response('Service unavailable', { status: 503 });
                }
            }
            const versioned = url.pathname.match(/^\/_pulse\/([a-zA-Z0-9.-]+)\/(assets\/.+)$/);
            const page = !url.pathname.startsWith('/assets/') && !versioned;
            // A scoped question window must use the frontend shipped with this shell.
            const requestedId = url.pathname === '/question' ? 'bundled' : versioned?.[1];
            const bundledWeb = app.isPackaged ? join(process.resourcesPath, 'web') : fileURLToPath(new URL('../../web/dist', import.meta.url));
            let selected;
            if (installation.runtimePolicy === 'bundled' && requestedId && requestedId !== 'bundled') return new Response('Preview frontend is pinned to this package', { status: 404 });
            if (installation.runtimePolicy !== 'bundled' && requestedId !== 'bundled') {
                try { selected = await selectedFrontend(installation.root, directory, app.getVersion(), Number(process.versions.chrome.split('.')[0]), requestedId); }
                catch { if (requestedId) return new Response('Frontend unavailable', { status: 404 }); }
            }
            let web = selected?.directory ?? bundledWeb;
            const name = page ? 'index.html' : versioned ? decodeURIComponent(versioned[2]) : decodeURIComponent(url.pathname.slice(1));
            if (selected) {
                try {
                    for (const file of page ? Object.keys(selected.files) : [name]) await verifySelectedFile(selected.directory, selected.files, file);
                }
                catch {
                    if (requestedId) return new Response('Frontend unavailable', { status: 404 });
                    selected = undefined;
                    web = bundledWeb;
                }
            }
            const resource = resolve(web, name);
            if (!resource.startsWith(web + (process.platform === 'win32' ? '\\' : '/'))) return new Response('Forbidden', { status: 403 });
            let response = await net.fetch(pathToFileURL(resource).href);
            if (page) {
                const id = selected?.id ?? 'bundled';
                const prefix = `/_pulse/${id}/`;
                let version = selected?.version;
                if (!version) { try { version = JSON.parse(await readFile(join(web, 'version.json'), 'utf8')).version; } catch { version = undefined; } }
                const safeVersion = /^\d+\.\d+\.\d+$/.test(String(version ?? '')) ? version : undefined;
                const stripped = (await response.text()).replace(/<meta\s+name="pulse-frontend-version"\s+content="[^"]*"\s*\/?>/gi, '');
                const versionTag = safeVersion ? `<meta name="pulse-frontend-version" content="${safeVersion}">` : '';
                const html = stripped.replace('<head>', `<head><base href="${prefix}">${versionTag}<meta name="pulse-frontend" content="${id}">`).replace(/(["'])\/assets\//g, `$1${prefix}assets/`);
                response = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }
            const headers = new Headers(response.headers);
            headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'");
            return new Response(response.body, { status: response.status, headers });
        });
        ipcMain.on('pulse:titlebar-theme', (event, dark) => { trusted(event); if (process.platform === 'win32' && typeof dark === 'boolean') window?.setTitleBarOverlay(windowChrome('win32', dark).titleBarOverlay); });
        ipcMain.handle('pulse:request', async (event, path, init = {}) => {
            trusted(event);
            allowedPath(path);
            if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(init.method ?? 'GET') || init.body && typeof init.body !== 'string')
                throw new Error('API_REQUEST_INVALID');
            if (installation.runtimePolicy === 'bundled' && path.startsWith('/api/updates/') && init.method === 'POST') return { status: 409, body: { error: 'PREVIEW_RUNTIME_PINNED', message: '预览版使用包内构建，请安装新的预览包以更新。' } };
            if (path === '/api/updates' || /^\/api\/updates\/(check|download|apply|rollback|settings)$/.test(path)) {
                try { const response = await http(path, init); if (response.status < 500 && response.status !== 404) return { status: response.status, body: await response.json() }; } catch {}
                return controlUpdate(installation, app.getVersion(), Number(process.versions.chrome.split('.')[0]), path, init);
            }
            if (path === '/api/desktop/diagnostics' && (init.method ?? 'GET') === 'GET') return { status: 200, body: diagnostics?.readLocalDiagnostics(diagnosticDirectory()) ?? { directory: diagnosticDirectory(), text: '当前运行包未提供诊断组件，请更新后重试。' } };
            if (path === '/api/desktop/setup' && (init.method ?? 'GET') === 'GET') return { status: 200, body: setupSnapshot() };
            if (path === '/api/desktop/setup/data-directory' && init.method === 'POST') { void chooseDataDirectory(); return { status: 202, body: setupSnapshot() }; }
            if (path === '/api/desktop/setup/repair' && init.method === 'POST') { void prepareDesktop(true); return { status: 202, body: setupSnapshot() }; }
            if (path === '/api/desktop/setup/complete' && init.method === 'POST') { await installation.complete(); return { status: 200, body: setupSnapshot() }; }
            if (path === '/api/desktop/setup/restart-service' && init.method === 'POST') {
                const confirmation = await dialog.showMessageBox(window, { type: 'question', message: '应用后台更新？', detail: '后台会短暂重启，执行中的任务会被中断；聊天记录和配置会保留。', buttons: ['取消', '重启后台'], defaultId: 0, cancelId: 0 });
                if (confirmation.response !== 1) return { status: 200, body: setupSnapshot() };
                const descriptor = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
                if (!backendInfo?.pid || descriptor.pid !== backendInfo.pid || Number(new URL(base).port) !== descriptor.port) return { status: 409, body: { error: 'SERVICE_IDENTITY_UNVERIFIED' } };
                if (installation.runtimePolicy === 'bundled') {
                    if (!isOwnedService(descriptor, ownedPid, backendInfo.pid)) return { status: 409, body: { error: 'SERVICE_IDENTITY_UNVERIFIED' } };
                    const identity = await http('/api/session');
                    if (!identity.ok) return { status: 409, body: { error: 'SERVICE_IDENTITY_UNVERIFIED' } };
                    const authenticated = await identity.json();
                    if (authenticated.serverPid !== descriptor.pid || authenticated.serverInstanceId !== descriptor.instanceId) return { status: 409, body: { error: 'SERVICE_IDENTITY_CHANGED' } };
                }
                chat?.close(); process.kill(descriptor.pid, 'SIGTERM');
                for (let i = 0; i < 200; i++) { try { process.kill(descriptor.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; } await new Promise(resolve => setTimeout(resolve, 50)); }
                try { process.kill(descriptor.pid, 0); return { status: 409, body: { error: 'SERVICE_STILL_RUNNING' } }; } catch (error) { if (error.code !== 'ESRCH') throw error; }
                base = ''; void prepareDesktop(); return { status: 202, body: setupSnapshot() };
            }
            if (serviceVersionBlocked) return { status: 503, body: { error: 'PREVIEW_BACKEND_VERSION_MISMATCH' } };
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
                    diagnosticLog?.record('reconnect-error', { name: error.name, message: error.message });
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
            if (path.startsWith('/api/desktop/voice/')) {
                try { const action = path.slice('/api/desktop/voice/'.length); if (action !== 'status' && init.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }; return { status: 200, body: await voice.action(action, init.body ? JSON.parse(init.body) : {}) }; }
                catch (error) { return { status: 400, body: { error: error.message } }; }
            }
            if (['/api/voice/transcribe', '/api/voice/speech', '/api/voice/test'].includes(path) && init.method === 'POST') {
                try { const result = await voice.localRequest(path, init); if (result !== undefined) return { status: 200, body: result }; }
                catch (error) { return { status: 400, body: { error: error.message } }; }
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
        ipcMain.handle('pulse:stop-service', async event => { trusted(event); await stopOwnedService(); });
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
        function createWindow(show = true) {
            window = new BrowserWindow({ ...windowChrome(process.platform), show, width: pageUrl.startsWith('http:') ? 1440 : 1200, height: pageUrl.startsWith('http:') ? 950 : 850, minWidth: 390, minHeight: 600, title: pageUrl.startsWith('http:') ? 'Pulse · 开发预览' : 'Pulse', icon: appIcon, webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
            configureWindowChrome(window, process.platform);
            window.on('query-session-end', () => { exitRequested = true; });
            window.on('session-end', () => { exitRequested = true; });
            window.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key?.toLowerCase() === 'q' && (process.platform === 'darwin' ? input.meta : input.control)) { event.preventDefault(); if (tray) { browser.hideAll(); window.hide(); } else quitDesktop(); } });
            window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url))
                void shell.openExternal(url); return { action: 'deny' }; });
            window.webContents.on('did-start-loading', () => { voice?.endDictation(); browser.hideAll(); });
            window.webContents.on('render-process-gone', () => { voice?.endDictation(); browser.hideAll(); });
            window.on('hide', () => voice?.endDictation());
            window.on('resize', () => { for (const group of browser.groups.values()) browser.applyLayout(group); });
            window.webContents.on('will-navigate', (event, url) => { if (!isDesktopPageUrl(url, pageUrl))
                event.preventDefault(); });
            window.on('close', event => { if (!app.isQuitting && tray) { event.preventDefault(); browser.hideAll(); window.hide(); } });
            window.on('closed', () => { if (!tray) quitDesktop(); browser.closeAll(); window = undefined; for (const socket of nativeSockets.values())
                socket.close(); nativeSockets.clear(); for (const sub of subscriptions.values())
                sub.controller.abort(); subscriptions.clear(); });
            void window.loadURL(pageUrl);
        }
        showDesktop = (path) => {
            if (!window || window.isDestroyed()) createWindow();
            if (path) void window.loadURL(pageUrl.startsWith('http:') ? new URL(path, pageUrl).href : `pulse://app${path}`);
            if (window.isMinimized()) window.restore(); window.show(); window.focus();
        };
        const json = async (path, init) => { if (voice) { const local = await voice.localRequest(path, init); if (local !== undefined) return local; } return desktopServiceJson(await http(path, init), path); };
        voice = new VoiceController({ BrowserWindow, node: () => app.isPackaged ? join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.PULSE_VOICE_NODE ?? process.env.npm_node_execpath ?? installation.node, ipcMain, session: electronSession, root: join(app.getPath('userData'), 'voice'), request: json, changed: () => { lastTraySignature = ''; updateTray(); } });
        const openFullNotice = item => showDesktop(`${item.surface === 'chat' ? '/chat' : '/work/' + encodeURIComponent(item.conversationId)}?notification=${encodeURIComponent(item.groupId ?? item.id)}&noticeRevision=${encodeURIComponent(item.revision ?? '')}`);
        // Bundle configuration permits buttons; the OS still decides their visibility.
        const plist = process.platform === 'darwin' ? await readFile(join(dirname(process.execPath), '../Info.plist'), 'utf8').catch(() => '') : '';
        const allowChoiceActions = process.platform === 'darwin' && /<key>NSUserNotificationAlertStyle<\/key>\s*<string>alert<\/string>/.test(plist);
        questionWindows = new QuestionWindows({ BrowserWindow, ipcMain, request: json, answer: (item, answers) => notifications.answer(item, answers), openFull: openFullNotice, pageUrl, isPageUrl: isDesktopPageUrl, icon: appIcon, preload: fileURLToPath(new URL('./question-preload.cjs', import.meta.url)) });
        notifications = new TaskNotifications({ Notification, request: json, allowChoiceActions, open: item => item.kind === 'ask' ? questionWindows.open(item) : openFullNotice(item),
            load: () => readFile(notificationFile(), 'utf8').then(JSON.parse).catch(() => []),
            save: async ids => { const { writeFile, rename } = await import('node:fs/promises'); const temp = notificationFile() + '.tmp'; await mkdir(app.getPath('userData'), { recursive: true }); await writeFile(temp, JSON.stringify(ids), { mode: 0o600 }); await rename(temp, notificationFile()); }, changed: () => updateTray() });
        const runTrayAction = action => { if (trayBusy) return; trayBusy = true; updateTray(); void Promise.resolve().then(action).catch(error => dialog.showMessageBox({ type: 'error', message: '操作未完成', detail: error.message })).finally(() => { trayBusy = false; lastTraySignature = ''; updateTray(); }); };
        updateTray = () => {
            if (!tray || tray.isDestroyed()) return;
            const status = setupPending ? '正在连接后台…' : base ? '后台运行中' : serviceError || '后台未启动';
            const signature = JSON.stringify([status, trayBusy, ownedPid, window?.isVisible(), notifications.disabled, notifications.unread, [...notifications.pending.keys()], notifications.recent.map(item => item.id)]);
            if (signature === lastTraySignature) return;
            lastTraySignature = signature;
            tray.setToolTip(`Pulse · ${status} · ${notifications.unread} 条未读`);
            const badge = notificationBadge(nativeImage, createTrayIcon(nativeImage, process.platform, appIcon, fileURLToPath(new URL('./assets/trayTemplate.png', import.meta.url))));
            tray.setImage(notifications.unread ? badge : createTrayIcon(nativeImage, process.platform, appIcon, fileURLToPath(new URL('./assets/trayTemplate.png', import.meta.url))));
            if (process.platform === 'darwin') app.dock?.setBadge(notifications.unread ? '●' : '');
            else if (process.platform === 'win32') window?.setOverlayIcon(notifications.unread ? badge : null, '未读通知');
            else app.setBadgeCount(notifications.unread);
            const pendingSignature = JSON.stringify([...notifications.pending.keys()]);
            if (appMenuReady && pendingSignature !== appPendingSignature) { appPendingSignature = pendingSignature; Menu.setApplicationMenu(process.platform === 'win32' ? null : buildAppMenu()); }
            tray.setContextMenu(Menu.buildFromTemplate([
                { label: `Pulse · ${status}`, enabled: false },
                { label: '打开聊天', click: () => showDesktop('/chat') },
                { label: `查看通知（${notifications.unread} 条未读）`, click: () => showDesktop('/chat?notices=1') },
                { label: `语音：${voice.status}`, enabled: false },
                { label: '后台名字唤醒（持续使用麦克风）', type: 'checkbox', checked: voice.config?.wakeEnabled === true, enabled: voice.config?.enabled === true, click: () => runTrayAction(() => voice.action('wake-settings', { enabled: voice.config?.wakeEnabled !== true })) },
                { label: '停止语音播报', click: () => voice.stopPlayback() },
                { label: '语音助手设置…', click: () => showDesktop('/settings/voice') },
                { label: '登录时启动 Pulse', type: 'checkbox', checked: loginStartupEnabled(app), click: item => runTrayAction(() => setLoginStartup(app, item.checked)) },
                { label: '打开 H5', enabled: Boolean(base), click: () => void shell.openExternal(base + '/chat') },
                { label: '打开交互式 CLI', enabled: !trayBusy && Boolean(installation.entry && installation.state.phase === 'ready'), click: () => runTrayAction(openCli) },
                { type: 'separator' },
                { label: `待处理问题 / 审批（${notifications.pending.size}）`, submenu: [...notifications.pending.values()].slice(-20).map((item, index) => ({ label: `${index + 1}. ${item.kind === 'approval' ? '需要审批' : '需要回答'}`, click: () => notifications.open(item) })) },
                { label: '最近结束的任务', submenu: notifications.recent.map((item, index) => ({ label: `任务 ${index + 1} · 查看结果`, click: () => notifications.open(item) })) },
                { label: notifications.disabled ? '系统通知不可用 · 查看原因…' : '系统通知已连接（送达依系统设置）', enabled: notifications.disabled, click: () => void dialog.showMessageBox({ type: 'info', message: '系统未能投递通知，待办仍保留', detail: `系统返回：${notifications.deliveryError || '未提供原因'}\n请在有效签名的 Pulse 应用中确认通知设置。此操作不会更改系统权限。` }) },
                { type: 'separator' },
                { label: '启动 / 重新连接后台', enabled: !trayBusy && !base, click: () => runTrayAction(() => prepareDesktop()) },
                { label: '停止本托盘启动的后台…', enabled: !trayBusy && Boolean(base && ownedPid), click: () => runTrayAction(stopOwnedService) },
                { label: '隐藏桌面窗口', enabled: Boolean(window?.isVisible()), click: () => { browser.hideAll(); window?.hide(); } },
                { type: 'separator' },
                { label: '彻底退出 Pulse（保留后台服务）', click: () => quitDesktop() },
                { label: '停止后台并退出…', enabled: !trayBusy && Boolean(base && ownedPid), click: () => runTrayAction(async () => { if (await stopOwnedService()) quitDesktop(); }) },
            ]));
        };
        try { const image = createTrayIcon(nativeImage, process.platform, appIcon, fileURLToPath(new URL('./assets/trayTemplate.png', import.meta.url))); tray = new Tray(image); tray.on('double-click', () => showDesktop()); updateTray(); }
        catch (error) { tray?.destroy(); tray = undefined; console.error('Pulse tray unavailable:', error.message); }
        function buildAppMenu() { return Menu.buildFromTemplate([{ label: 'Pulse', submenu: [
            { label: '显示 Pulse', click: () => showDesktop() },
            { id: 'pulse-pending', label: '待处理问题 / 审批', submenu: [...notifications.pending.values()].slice(-20).map((item, index) => ({ label: `${index + 1}. ${item.kind === 'approval' ? '需要审批' : '需要回答'}`, click: () => notifications.open(item) })) },
            { label: '后台与通知菜单…', click: () => setTimeout(() => tray?.popUpContextMenu(), 0) },
            { label: '检查更新…', click: () => showDesktop('/settings/updates') },
            { label: '环境检查与修复…', click: () => showDesktop('/settings/desktop') },
            { label: '查看后台启动诊断…', click: () => showDesktop('/settings/desktop?diagnostics=1') },
            { label: '数据目录…', click: () => void chooseDataDirectory() },
            { label: '打开 H5', click: () => { if (base) void shell.openExternal(base + '/chat'); } },
            { type: 'separator' }, { label: '退出到托盘', accelerator: 'CommandOrControl+Q', click: () => { if (!tray) quitDesktop(); else { browser.hideAll(); window?.hide(); } } },
            { label: '彻底退出 Pulse（保留后台服务）', click: () => quitDesktop() },
        ] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]); }
        Menu.setApplicationMenu(process.platform === 'win32' ? null : buildAppMenu()); appMenuReady = true;
        createWindow(!tray || (!notificationLaunch && !process.argv.includes('--background')));
        void prepareDesktop().then(async () => {
            updateTray();
            if (notificationLaunch) {
                const launch = notificationLaunch;
                notificationLaunch = undefined;
                const item = matchTaskNotice(notifications.pending, notifications.recent, launch.identifier);
                const dismissed = launch.actionIdentifier === 'com.apple.UNNotificationDismissActionIdentifier';
                if (!item || dismissed) { if (!dismissed) void dialog.showMessageBox({ type: 'info', message: '这个通知对应的问题已结束或不可用。请从待办查看当前问题。' }); }
                else if (item.kind === 'ask' && launch.userText) { const accepted = await notifications.reply(item, launch.userText).catch(() => false); if (!accepted) notifications.open(item); }
                else if (item.kind === 'ask' && /^\d+$/.test(launch.actionIdentifier ?? '')) { await notifications.choose(item, Number(launch.actionIdentifier)).catch(() => notifications.open(item)); }
                else notifications.open(item);
            }
            activationReady = true;
        });
        let monitorBusy = false;
        const serviceMonitor = setInterval(async () => {
            const action = serviceMonitorAction({ stoppedByUser: serviceStoppedByUser, setupPending: Boolean(setupPending), base });
            if (monitorBusy || action === 'wait') return;
            monitorBusy = true;
            try {
              try {
                if (action === 'reconnect') await prepareDesktop();
                else {
                    const response = await http('/api/session');
                    if (!response.ok) throw new Error('PULSE_SERVICE_UNAVAILABLE');
                    const info = await response.json();
                    if (serviceStoppedByUser || setupPending || app.isQuitting) return;
                    serviceError = '';
                    if (backendInfo?.pid !== info.serverPid || backendInfo?.version !== info.serverVersion || installation.runtimePolicy === 'bundled' && info.runtimeId !== installation.state.runtimeId) await prepareDesktop();
                }
              } catch (error) {
                if (serviceStoppedByUser || setupPending || app.isQuitting) return;
                serviceError = error.message; await prepareDesktop();
              }
              try { if (base && !serviceStoppedByUser) { await notifications.sync(); await voice.sync(); } } catch { /* Older services or an unavailable inbox do not disconnect a healthy backend. */ }
            } finally { monitorBusy = false; updateTray(); }
        }, 2000);
        serviceMonitor.unref(); powerMonitor.on('shutdown', () => { exitRequested = true; });
        const activateMain = () => {
            if (shouldRevealMain({ ready: activationReady, notificationLaunch: Boolean(notificationLaunch), pendingQuestions: notifications.pending.size, questionWindows: questionWindows.entries.size })) showDesktop();
        };
        app.on('activate', activateMain);
        app.on('second-instance', activateMain);
        app.on('window-all-closed', () => { if (!tray) quitDesktop(); });
        app.on('before-quit', event => { if (!exitRequested && tray && !tray.isDestroyed()) { event.preventDefault(); browser.hideAll(); window?.hide(); return; } clearInterval(serviceMonitor); app.isQuitting = true; voice?.close(); notifications?.close(); questionWindows?.close(); tray?.destroy(); clearTimeout(browserRetry); browserHost?.close(); browser.closeAll(); clearTimeout(retry); chat?.close(); for (const sub of subscriptions.values())
            sub.controller.abort(); if (reader?.connected) reader.disconnect(); reader?.kill('SIGTERM'); });
    }).catch(error => { diagnosticLog?.record('desktop-startup-error', { name: error.name, message: error.message }); console.error('Pulse desktop startup failed:', error.message); quitDesktop(); });
}
