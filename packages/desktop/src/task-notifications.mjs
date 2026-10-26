import { createHash } from 'node:crypto';
import { ordinaryQuestion, choiceActions, currentQuestion, questionFingerprint, validQuestionAnswers } from './question-policy.mjs';
const noticeKey = item => item.kind === 'complete' ? item.id : `${item.id}:${questionFingerprint(item.group)}`;
/** Electron 44 puts the clicked notification under launchInfo.notificationResponse. Older payloads may be flat. */
export function readNotificationLaunch(info) {
    const source = info?.notificationResponse && typeof info.notificationResponse === 'object' ? info.notificationResponse : info;
    if (!source || typeof source.identifier !== 'string' || !source.identifier) return undefined;
    const actionIdentifier = typeof source.actionIdentifier === 'string' ? source.actionIdentifier : undefined;
    const userText = typeof source.userText === 'string' ? source.userText : undefined;
    return { identifier: source.identifier, ...(actionIdentifier ? { actionIdentifier } : {}), ...(userText ? { userText } : {}) };
}
export function matchTaskNotice(pending, recent, identifier) {
    if (pending.has(identifier)) return pending.get(identifier);
    for (const item of pending.values()) if (item.id === identifier || noticeKey(item) === identifier) return item;
    return recent.find(item => item.id === identifier || noticeKey(item) === identifier);
}
export function notificationRequestId(key, answers, attempt = 0) {
    return `notification_${createHash('sha256').update(`${key}\0${attempt}\0${JSON.stringify(answers)}`).digest('hex')}`;
}
/** System notifications are an optional view over the durable task inbox. */
export class TaskNotifications {
    seen = new Set(); pending = new Map(); recent = []; live = new Map(); liveTargets = new Map(); replying = new Set(); submitted = new Set(); attempts = new Map(); initialized = false; disabled = false; closed = false; deliveryError = '';
    constructor({ Notification, request, open, load, save, platform = process.platform, allowChoiceActions = false, changed = () => {} }) {
        Object.assign(this, { Notification, request, open, load, save, platform, allowChoiceActions, changed });
    }
    async sync() {
        if (this.busy || this.closed) return;
        this.busy = true;
        try {
            if (!this.initialized) { for (const id of await this.load()) this.seen.add(id); }
            const items = await this.request('/api/notifications');
            if (this.closed) return;
            const current = new Map(), snapshots = new Map();
            const completed = new Set(items.filter(item => item.kind === 'complete').map(item => item.runId));
            const history = !this.initialized && this.platform === 'darwin' && this.Notification.getHistory ? await this.Notification.getHistory().catch(() => []) : [];
            for (const item of items) {
                if (item.kind === 'complete') {
                    if (!this.initialized || ( !this.seen.has(item.id) && this.show(item))) this.seen.add(item.id);
                } else {
                    if (completed.has(item.runId)) { this.live.get(item.id)?.close(); this.live.delete(item.id); continue; }
                    if (!snapshots.has(item.runId)) snapshots.set(item.runId, await this.request(`/api/runs/${encodeURIComponent(item.runId)}/state`));
                    const snapshot = snapshots.get(item.runId);
                    const group = snapshot.state === 'running' && snapshot.interactions?.find(group => group.groupId === item.groupId);
                    if (!group?.items.length) { this.live.get(item.id)?.close(); this.live.delete(item.id); continue; }
                    current.set(item.id, { ...item, group });
                    const target = { ...item, group }, key = noticeKey(target);
                    if (this.liveTargets.has(item.id) && this.liveTargets.get(item.id) !== key) { this.live.get(item.id)?.close(); this.live.delete(item.id); this.liveTargets.delete(item.id); }
                    const restored = history.find(notice => notice.id === key);
                    if (restored) { this.wire(restored, { ...item, group }); this.seen.add(key); }
                    else if (!this.seen.has(key) && this.show(target)) this.seen.add(key);
                }
            }
            // Only a successful, complete feed/snapshot read can revoke a question.
            const valid = new Set([...current.values()].map(noticeKey));
            for (const [id, key] of this.liveTargets) if (!valid.has(key)) { this.live.get(id)?.close(); this.live.delete(id); this.liveTargets.delete(id); }
            // On restart, close orphaned/legacy question notices without touching completion history.
            for (const notice of history) if (notice.id?.startsWith('interaction:') && !valid.has(notice.id)) notice.close();
            this.pending = current;
            this.recent = items.filter(item => item.kind === 'complete').slice(-10).reverse();
            while (this.live.size > 200) { const id = this.live.keys().next().value; this.live.get(id)?.close(); this.live.delete(id); this.liveTargets.delete(id); }
            this.initialized = true;
            await this.persistSeen();
            this.changed();
        } finally { this.busy = false; }
    }
    show(item) {
        if (this.closed || this.disabled || !this.Notification.isSupported()) return false;
        let delivered = true;
        try {
        const question = ordinaryQuestion(item.group) && item.group.items.length === 1 && item.group.items[0].input.type === 'input';
        const actions = this.platform === 'darwin' && this.allowChoiceActions ? choiceActions(item.group) : [];
        const notice = new this.Notification({ id: noticeKey(item), title: item.kind === 'complete' ? 'Pulse · 任务已结束' : item.kind === 'approval' ? 'Pulse · 需要审批' : 'Pulse · 需要你的回答', body: actions.length ? item.group.items[0].input.prompt : question ? '有一个待回答问题。展开通知可回复，或点击查看详情。' : '点击打开对应任务查看详情。', hasReply: Boolean(question && this.platform === 'darwin'), replyPlaceholder: '输入回答（不会批准任何操作）', actions: actions.map(option => ({ type: 'button', text: option.label })) });
        notice.on('failed', () => { delivered = false; });
        this.wire(notice, item);
        notice.show();
        return delivered;
        } catch (error) { this.unavailable(error instanceof Error ? error.message : String(error)); return false; }
    }
    wire(notice, item) {
        const question = ordinaryQuestion(item.group) && item.group.items.length === 1 && item.group.items[0].input.type === 'input';
        const actions = this.platform === 'darwin' && this.allowChoiceActions ? choiceActions(item.group) : [];
        this.live.set(item.id, notice);
        if (item.kind !== 'complete') this.liveTargets.set(item.id, noticeKey(item));
        notice.on('click', () => this.open(item));
        notice.on('close', () => { if (item.kind === 'complete') this.live.delete(item.id); });
        notice.on('failed', (_event, error) => { this.seen.delete(noticeKey(item)); void this.persistSeen(); this.unavailable(typeof error === 'string' ? error : '系统未能投递通知'); });
        if (actions.length) notice.on('action', (event, legacyIndex) => { const index = event.actionIndex ?? legacyIndex; void this.choose(item, index).catch(() => this.open(item)); });
        if (question && this.platform === 'darwin') notice.on('reply', (event, legacyReply) => { void this.reply(item, event.reply ?? legacyReply).catch(() => this.open(item)); });
    }
    unavailable(reason) {
        this.disabled = true; this.deliveryError = String(reason).slice(0, 500); this.changed();
    }
    async choose(item, index) {
        const actions = this.platform === 'darwin' && this.allowChoiceActions ? choiceActions(item.group) : [];
        if (!Number.isInteger(index) || !actions[index]) throw new Error('QUESTION_ACTION_INVALID');
        return this.answer(item, [{ effectId: item.group.items[0].effectId, value: { value: actions[index].value } }]);
    }
    async reply(item, text) {
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) return false;
        if (!ordinaryQuestion(item.group) || item.group.items.length !== 1 || item.group.items[0].input.type !== 'input') throw new Error('QUESTION_EXPIRED');
        return this.answer(item, [{ effectId: item.group.items[0].effectId, value: { text } }]);
    }
    async answer(item, answers) {
        const key = item.id + ':' + questionFingerprint(item.group);
        if (this.submitted.has(key)) return true;
        if (this.replying.has(key)) return false;
        this.replying.add(key);
        try {
            const snapshot = await this.request(`/api/runs/${encodeURIComponent(item.runId)}/state`);
            const group = currentQuestion(item, snapshot);
            if (!validQuestionAnswers(group, answers)) throw new Error('QUESTION_ANSWER_INVALID');
            const attempt = this.attempts.get(key) ?? 0;
            const requestId = notificationRequestId(key, answers, attempt);
            try {
            await this.request(`/api/runs/${encodeURIComponent(item.runId)}/replies`, { method: 'POST', body: JSON.stringify({ conversationId: item.conversationId, groupId: item.groupId, requestId, answers }) });
            } catch (error) {
                if (String(error instanceof Error ? error.message : error).startsWith('API_4')) this.attempts.set(key, attempt + 1);
                throw error;
            }
            this.submitted.add(key); while (this.submitted.size > 1000) this.submitted.delete(this.submitted.values().next().value);
            if (this.pending.get(item.id) && noticeKey(this.pending.get(item.id)) === noticeKey(item)) this.pending.delete(item.id);
            if (this.liveTargets.get(item.id) === noticeKey(item)) { this.live.get(item.id)?.close(); this.live.delete(item.id); this.liveTargets.delete(item.id); }
            this.changed(); return true;
        } finally { this.replying.delete(key); }
    }
    async persistSeen() {
        this.seen = new Set([...this.seen].slice(-1000));
        const serialized = JSON.stringify([...this.seen]);
        if (serialized !== this.persisted) { await this.save([...this.seen]); this.persisted = serialized; }
    }
    close() { this.closed = true; for (const notice of this.live.values()) notice.close(); this.live.clear(); this.liveTargets.clear(); }
}
