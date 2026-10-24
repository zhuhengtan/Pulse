import { WebContentsView, session } from 'electron';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';
import { formatAXNode } from './ax-text.mjs';
import { captureNativePage } from './native-capture.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(code); };
const localHosts = new Set(['localhost', '[::1]', '[::]', '0.0.0.0', ...Object.values(networkInterfaces()).flatMap(items => (items || []).map(item => item.family === 'IPv6' ? `[${item.address}]` : item.address))]);
const local = host => localHosts.has(host) || /^127\./.test(host) || host.endsWith('.localhost');

/** Native pages have no preload, Node, Pulse cookies, or access to the application IPC. */
export class NativeBrowser {
    groups = new Map();
    constructor({ window, notify, protectedUrls }) { this.window = window; this.notify = notify; this.protectedUrls = protectedUrls; }
    allowed(group, value, resource = false) {
        if (value === 'about:blank') return true;
        try {
            const url = new URL(value);
            if (!(resource ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password || !group.allowNetwork) return false;
            if (group.networkHosts && !group.networkHosts.some(host => host.toLowerCase() === url.hostname.toLowerCase())) return false;
            return !this.protectedUrls().some(value => {
                const app = new URL(value);
                return url.origin === app.origin || local(url.hostname) && local(app.hostname) && url.port === app.port;
            });
        } catch { return false; }
    }
    tabs(group) {
        const items = group.pages.map((page, index) => ({ index, title: page.webContents.getTitle() || '新标签页', url: page.webContents.getURL() || 'about:blank', active: page === group.active }));
        return { revision: hash(items), items };
    }
    publish(group) { this.notify({ id: group.id, tabs: this.tabs(group), error: group.error || '' }); }
    group(id) { return this.groups.get(id) ?? fail('AUTOMATION_SESSION_NOT_FOUND'); }
    open(params) {
        let group = this.groups.get(params.id);
        if (group) { Object.assign(group, { allowNetwork: params.allowNetwork, networkHosts: params.networkHosts }); return this.tabs(group); }
        group = { ...params, pages: [], active: undefined, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false, state: 'paused', until: 0, downloads: [] };
        group.session = session.fromPartition(`persist:pulse-browser-${hash(params.profile).slice(0, 24)}`);
        group.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        group.session.setPermissionCheckHandler(() => false);
        group.session.webRequest.onBeforeRequest((details, callback) => {
            // Block app origins, disallowed hosts and privileged schemes for subresources too.
            callback({ cancel: !this.allowed(group, details.url, true) && !/^(data:|blob:)/.test(details.url) });
        });
        group.download = (_event, item) => {
            if (!params.downloadDir) { item.cancel(); return; }
            const name = `${Date.now()}-${basename(item.getFilename()).replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
            const path = join(params.downloadDir, name); item.setSavePath(path);
            item.once('done', (_event, state) => { if (state === 'completed') group.downloads.push({ name, path, bytes: item.getReceivedBytes() }); });
        };
        group.session.on('will-download', group.download);
        this.groups.set(params.id, group);
        this.newPage(group);
        return this.tabs(group);
    }
    newPage(group) {
        const view = new WebContentsView({ webPreferences: { session: group.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, navigateOnDragDrop: false } });
        const wc = view.webContents;
        group.pages.push(view); group.active = view;
        wc.setZoomFactor(1);
        wc.on('zoom-changed', event => event.preventDefault());
        const guard = (event, url) => { if (!this.allowed(group, url)) { event.preventDefault(); group.error = 'BROWSER_NETWORK_NOT_ALLOWED'; this.publish(group); } };
        wc.on('will-navigate', guard); wc.on('will-redirect', guard);
        wc.setWindowOpenHandler(({ url }) => {
            if (this.allowed(group, url)) { const page = this.newPage(group); void page.ready.then(() => page.webContents.loadURL(url)).catch(() => {}); }
            else { group.error = 'BROWSER_NETWORK_NOT_ALLOWED'; this.publish(group); }
            return { action: 'deny' };
        });
        const input = event => { if (!group.injecting && (group.state !== 'human' || Date.now() >= group.until)) event.preventDefault(); };
        wc.on('before-input-event', input); wc.on('before-mouse-event', input);
        for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading']) wc.on(event, () => this.publish(group));
        wc.on('did-start-navigation', () => { group.refs = undefined; group.geometry = undefined; });
        wc.on('did-fail-load', (_event, code) => { if (code !== -3) { group.error = 'BROWSER_LOAD_FAILED'; this.publish(group); } });
        wc.on('render-process-gone', () => { group.error = 'BROWSER_RENDERER_STOPPED'; this.publish(group); });
        wc.on('will-prevent-unload', event => event.preventDefault());
        wc.debugger.attach('1.3');
        void wc.debugger.sendCommand('Accessibility.enable');
        void wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: group.state === 'ai' }).catch(() => {});
        wc.debugger.on('message', (_event, method, params) => { if (method === 'Page.fileChooserOpened') group.fileInput = { page: view, backendNodeId: params.backendNodeId }; });
        this.applyLayout(group); this.publish(group);
        view.ready = wc.loadURL('about:blank').catch(() => {});
        return view;
    }
    applyLayout(group) {
        const window = this.window();
        if (!window || window.isDestroyed()) return;
        for (const page of group.pages) {
            if (!window.contentView.children.includes(page)) window.contentView.addChildView(page);
            page.setBounds(group.bounds);
            page.setVisible(group.visible && page === group.active);
        }
    }
    layout(id, bounds) {
        const group = this.groups.get(id), window = this.window();
        if (!group || !window) return;
        if (!bounds) { group.visible = false; this.applyLayout(group); return; }
        const zoom = window.webContents.getZoomFactor(), size = window.getContentSize();
        const x = Math.max(0, Math.min(size[0], Math.round(bounds.x * zoom))), y = Math.max(0, Math.min(size[1], Math.round(bounds.y * zoom)));
        const width = Math.max(0, Math.min(size[0] - x, Math.round(bounds.width * zoom))), height = Math.max(0, Math.min(size[1] - y, Math.round(bounds.height * zoom)));
        group.visible = width > 0 && height > 0;
        if (group.visible) group.bounds = { x, y, width, height };
        this.applyLayout(group);
    }
    hideAll() { for (const group of this.groups.values()) { group.visible = false; this.applyLayout(group); } }
    disconnect() { for (const group of this.groups.values()) { group.state = 'paused'; group.until = 0; } }
    close(id) {
        const group = this.groups.get(id); if (!group) return;
        this.groups.delete(id); group.session.removeListener('will-download', group.download);
        group.session.webRequest.onBeforeRequest(null);
        for (const page of group.pages) this.destroyPage(page);
    }
    destroyPage(page) {
        const window = this.window();
        if (window && !window.isDestroyed() && window.contentView.children.includes(page)) window.contentView.removeChildView(page);
        if (!page.webContents.isDestroyed()) page.webContents.close({ waitForBeforeUnload: false });
    }
    closeAll() { for (const id of this.groups.keys()) this.close(id); }
    async command(group, method, params, operation) {
        const wc = group.active?.webContents;
        if (!wc || wc.isDestroyed()) fail('BROWSER_TAB_NOT_FOUND');
        if (method === 'tabs') return this.tabs(group);
        if (['navigate', 'newTab'].includes(method)) {
            const url = String(params.url || 'about:blank');
            if (!this.allowed(group, url)) fail('BROWSER_NETWORK_NOT_ALLOWED');
            group.error = '';
            const page = method === 'newTab' ? this.newPage(group) : group.active;
            await page.ready;
            if (operation?.aborted) fail('AUTOMATION_CANCELLED');
            const target = page.webContents;
            await target.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED') fail('BROWSER_LOAD_FAILED'); });
        } else if (['selectTab', 'closeTab'].includes(method)) {
            const tabs = this.tabs(group);
            if (params.revision && params.revision !== tabs.revision) fail('STALE_BROWSER_TABS');
            if (!Number.isInteger(params.index) || !group.pages[params.index]) fail('BROWSER_TAB_NOT_FOUND');
            const page = group.pages[params.index];
            if (method === 'selectTab') group.active = page;
            else { group.pages.splice(params.index, 1); this.destroyPage(page); if (group.active === page) group.active = group.pages[Math.min(params.index, group.pages.length - 1)]; }
        } else if (method === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
        else if (method === 'reload') wc.reload();
        else if (method === 'downloads') return group.downloads;
        else if (method === 'upload') {
            if (group.fileInput?.page !== group.active) fail('BROWSER_FILE_CHOOSER_MISSING');
            await wc.debugger.sendCommand('DOM.setFileInputFiles', { backendNodeId: group.fileInput.backendNodeId, files: params.files }); delete group.fileInput;
        } else fail('UNKNOWN_BROWSER_METHOD');
        this.applyLayout(group); this.publish(group);
        return this.tabs(group);
    }
    async snapshot(group) {
        const wc = group.active?.webContents;
        if (!wc || wc.isDestroyed()) fail('BROWSER_TAB_NOT_FOUND');
        const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree');
        const refs = new Map(), lines = [];
        for (const node of nodes) {
            if (node.ignored || !node.backendDOMNodeId) continue;
            const ref = `e${wc.id}_${node.backendDOMNodeId}`;
            refs.set(ref, node.backendDOMNodeId);
            lines.push(formatAXNode(node, ref));
            if (lines.length >= 1500) break;
        }
        const viewport = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: '({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})' }]);
        const text = lines.join('\n').slice(0, 16000), geometry = hash([wc.id, wc.getURL(), viewport, lines]);
        group.refs = refs; group.geometry = geometry;
        return { text, geometry, width: viewport.width, height: viewport.height, title: wc.getTitle(), url: wc.getURL(), tabs: this.tabs(group) };
    }
    async observe(group) {
        const observation = await this.snapshot(group);
        // Vision is available to the agent; the UI displays the native view and never fetches frames.
        const image = await captureNativePage(group.active.webContents);
        return { ...observation, image: { mediaType: 'image/jpeg', data: image.toJPEG(75).toString('base64') } };
    }
    async act(group, action, geometry, operation) {
        const epoch = group.epoch;
        const check = () => { if (operation?.aborted || epoch !== group.epoch) fail('AUTOMATION_CANCELLED'); };
        const current = await this.snapshot(group);
        check();
        if (geometry !== current.geometry) fail('AUTOMATION_GEOMETRY_CHANGED');
        const wc = group.active.webContents, send = input => { group.injecting = true; try { wc.sendInputEvent(input); } finally { group.injecting = false; } };
        const point = value => ({ x: Math.round(value.x * (current.width - 1)), y: Math.round(value.y * (current.height - 1)) });
        const click = (position, button = 'left', clickCount = 1) => { send({ type: 'mouseDown', ...position, button, clickCount }); send({ type: 'mouseUp', ...position, button, clickCount }); };
        try {
            if (action.type === 'element') {
                const backendNodeId = group.refs.get(action.ref); if (!backendNodeId) fail('STALE_ELEMENT');
                await wc.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId }); check();
                if (action.operation === 'click') {
                    const { model } = await wc.debugger.sendCommand('DOM.getBoxModel', { backendNodeId });
                    check(); const box = model.content; click({ x: Math.round((box[0] + box[4]) / 2), y: Math.round((box[1] + box[5]) / 2) });
                } else {
                    const { object } = await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId });
                    try {
                        check();
                        const result = await wc.debugger.sendCommand('Runtime.callFunctionOn', {
                            objectId: object.objectId, functionDeclaration: action.operation === 'fill' ? `function(value) { this.focus(); const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) throw Error('ELEMENT_NOT_EDITABLE'); setter.call(this, value); this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); }` : `function(value) { this.value = value; this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); }`, arguments: [{ value: action.value || '' }], returnByValue: true,
                        });
                        if (result.exceptionDetails) fail('BROWSER_ELEMENT_ACTION_FAILED');
                    } finally { await wc.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId }); }
                }
            } else if (action.type === 'type') await wc.insertText(action.text);
            else if (action.type === 'key') {
                const aliases = { Control: 'control', Ctrl: 'control', Meta: 'meta', Command: 'meta', Alt: 'alt', Shift: 'shift', ControlOrMeta: process.platform === 'darwin' ? 'meta' : 'control' };
                const keyCode = action.keys.at(-1), modifiers = action.keys.slice(0, -1).map(key => aliases[key] || key.toLowerCase());
                send({ type: 'keyDown', keyCode, modifiers }); send({ type: 'keyUp', keyCode, modifiers });
            } else if (action.type === 'click') click(point(action.point), action.button, action.count);
            else if (action.type === 'scroll') send({ type: 'mouseWheel', ...point(action.point), deltaX: -action.dx, deltaY: -action.dy, canScroll: true });
            else if (action.type === 'drag') {
                const from = point(action.from), to = point(action.to); send({ type: 'mouseDown', ...from, button: 'left', clickCount: 1 });
                for (let i = 1; i <= 10; i++) send({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / 10), y: Math.round(from.y + (to.y - from.y) * i / 10), modifiers: ['leftButtonDown'] });
                send({ type: 'mouseUp', ...to, button: 'left', clickCount: 1 });
            }
        } finally { group.injecting = false; }
    }
    async dispatch(method, params, operation) {
        if (operation?.aborted) fail('AUTOMATION_CANCELLED');
        if (method === 'open') return this.open(params);
        if (method === 'close') return this.close(params.id);
        const group = this.group(params.id);
        if (method === 'command') return this.command(group, params.method, params.params || {}, operation);
        if (method === 'observe') return this.observe(group);
        if (method === 'act') return this.act(group, params.action, params.geometry, operation);
        if (method === 'control') {
            if (group.state !== params.state) group.epoch = (group.epoch || 0) + 1;
            group.state = params.state; group.until = params.until || 0;
            await Promise.all(group.pages.map(page => page.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: params.state === 'ai' }).catch(() => {})));
            return;
        }
        if (method === 'release') { group.epoch = (group.epoch || 0) + 1; return; }
        fail('UNKNOWN_NATIVE_BROWSER_METHOD');
    }
}
