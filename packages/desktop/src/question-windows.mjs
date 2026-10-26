import { ordinaryQuestion, currentQuestion, questionFingerprint } from './question-policy.mjs';
/** Each small window has one immutable question target and only a scoped IPC bridge. */
export class QuestionWindows {
    entries = new Map();
    constructor({ BrowserWindow, ipcMain, request, answer, openFull, pageUrl, preload, icon, isPageUrl }) {
        Object.assign(this, { BrowserWindow, request, answer, openFull, pageUrl, preload, icon, isPageUrl });
        ipcMain.handle('pulse:question-state', event => this.state(this.entry(event)));
        ipcMain.handle('pulse:question-submit', async (event, answers) => {
            const entry = this.entry(event); if (entry.completed) return true;
            const result = await this.answer(entry.item, answers);
            if (result) {
                entry.completed = true;
                // Close only the original window, after the durable server acknowledgement.
                if (this.entries.get(entry.key) === entry && !entry.window.isDestroyed()) entry.window.close();
            }
            return result;
        });
        ipcMain.handle('pulse:question-open-full', event => this.openFull(this.entry(event).item));
        ipcMain.handle('pulse:question-close', event => this.entry(event).window.close());
    }
    entry(event) {
        const entry = [...this.entries.values()].find(entry => entry.window.webContents === event.sender);
        if (!entry || event.senderFrame !== event.sender.mainFrame || !this.isPageUrl(event.senderFrame?.url ?? '', this.pageUrl)) throw new Error('QUESTION_WINDOW_INVALID');
        return entry;
    }
    async state(entry) {
        if (entry.completed) return { status: 'submitted' };
        const snapshot = await this.request(`/api/runs/${encodeURIComponent(entry.item.runId)}/state`);
        let group; try { group = currentQuestion(entry.item, snapshot); } catch { return { status: 'expired' }; }
        return { status: 'ready', fingerprint: questionFingerprint(group), interaction: { kind: 'interaction', interactionKind: 'ask', runId: entry.item.runId, conversationId: entry.item.conversationId, groupId: group.groupId, items: group.items } };
    }
    open(item) {
        if (!ordinaryQuestion(item.group)) { this.openFull(item); return; }
        const key = item.runId + ':' + item.groupId + ':' + questionFingerprint(item.group);
        const existing = this.entries.get(key);
        if (existing && !existing.window.isDestroyed()) { if (existing.window.isMinimized()) existing.window.restore(); existing.window.show(); existing.window.focus(); return; }
        const window = new this.BrowserWindow({ width: 540, height: 650, minWidth: 390, minHeight: 420, title: 'Pulse · 回答问题', icon: this.icon, autoHideMenuBar: true, webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
        this.entries.set(key, { key, window, item: structuredClone(item), completed: false });
        window.setMenu?.(null);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => { if (!this.isPageUrl(url, this.pageUrl)) event.preventDefault(); });
        window.on('closed', () => { if (this.entries.get(key)?.window === window) this.entries.delete(key); });
        const url = new URL('/question', this.pageUrl); url.searchParams.set('conversation', item.conversationId); url.searchParams.set('group', item.groupId); url.searchParams.set('surface', item.surface ?? 'work');
        void window.loadURL(url.href);
    }
    close() { for (const { window } of this.entries.values()) if (!window.isDestroyed()) window.destroy(); this.entries.clear(); }
}
