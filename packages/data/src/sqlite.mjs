import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export const schemaVersion = 1;
export class ConversationDatabase {
    constructor(dataDir, readOnly = false) {
        if (!readOnly)
            mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(join(dataDir, 'pulse.sqlite'), { readOnly });
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
        if (!readOnly) {
            this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, updated TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS conversation_updated ON conversations(updated DESC,id);
        CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,id TEXT NOT NULL,body TEXT NOT NULL,text TEXT NOT NULL, UNIQUE(conversation,id));
        CREATE INDEX IF NOT EXISTS message_page ON messages(conversation,seq DESC);
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation TEXT,kind TEXT NOT NULL,item TEXT);
        PRAGMA user_version=1;`);
            chmodSync(join(dataDir, 'pulse.sqlite'), 0o600);
        }
        if (Number(this.db.prepare('PRAGMA user_version').get().user_version) !== schemaVersion)
            throw new Error('DATA_SCHEMA_INCOMPATIBLE');
    }
    assistantView(before) {
        const inbox = this.readState('assistant-inbox');
        if (!inbox)
            throw new Error('ASSISTANT_STORE_NOT_INITIALIZED');
        const conversation = this.get(inbox.conversationId), page = this.page(conversation.id, before);
        const receiptById = new Map(inbox.messages.map(item => [item.messageId, item]));
        const receipts = inbox.messages.filter((item, index) => index >= inbox.messages.length - 200 || ['queued', 'replying'].includes(item.state)).map(({ text, ...receipt }) => receipt);
        const decorate = message => { const receipt = message.role === 'user' && message.id.startsWith('msg-') ? receiptById.get(message.id.slice(4)) : undefined; return !receipt ? message : { ...message, runId: receipt.runId, ...(receipt.state === 'completed' ? {} : { requestId: receipt.messageId, deliveryState: receipt.state }) }; };
        const messages = page.items.map(decorate), seen = new Set(messages.map(message => message.id));
        for (const item of inbox.messages)
            if (item.state !== 'completed' && !seen.has(`msg-${item.messageId}`))
                messages.push({ id: `msg-${item.messageId}`, runId: item.runId, role: 'user', text: item.text, createdAt: item.createdAt, deliveryState: item.state, requestId: item.messageId, ...(item.attachments ? { attachments: item.attachments } : {}), ...(item.skills ? { skills: item.skills } : {}), ...(item.mentionedFiles ? { mentionedFiles: item.mentionedFiles } : {}) });
        const workInteractions = [], live = [];
        for (const work of this.list()) {
            if (work.id !== conversation.id && work.origin !== 'assistant' || work.archivedAt || !work.activeRunId)
                continue;
            const state = this.readState(`run:${work.activeRunId}`), pending = state?.interactions ?? [];
            for (const interaction of pending)
                workInteractions.push({ ...interaction, runId: work.activeRunId, conversationId: work.id, title: work.title, ...(work.projectId ? { projectId: work.projectId } : {}), approvalPolicy: work.approvalPolicy ?? 'manual' });
            if (work.id === conversation.id)
                continue;
            const lane = state?.laneState?.lanes.find(item => ['running', 'waiting'].includes(item.status));
            live.push({ id: `work-live-${work.activeRunId}`, role: 'assistant', text: '', createdAt: work.updatedAt, work: { conversationId: work.id, title: work.title, state: state?.state === 'running' ? (pending.length ? 'waiting' : 'running') : 'interrupted', ...(work.projectId ? { projectId: work.projectId } : {}), ...(lane ? { progress: (lane.activity ?? lane.label).slice(0, 200) } : {}) } });
        }
        const assistantWorkIds = new Set(this.list().filter(item => item.origin === 'assistant').map(item => item.id));
        const combined = [...messages, ...(before ? [] : (inbox.notices ?? []).filter(item => item.work && assistantWorkIds.has(item.work.conversationId)).slice(-50)), ...(before ? [] : live)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const { executionCwd, jarvisWorkspace, ...summary } = conversation;
        return { conversation: { ...summary, kind: 'assistant' }, messages: combined, receipts, workInteractions, ...(page.before ? { before: page.before } : {}), revision: page.revision };
    }
    close() { this.db.close(); }
    changed(conversation, kind, item) {
        const result = this.db.prepare('INSERT INTO changes(conversation,kind,item) VALUES(?,?,?)').run(conversation ?? null, kind, item ?? null);
        const seq = Number(result.lastInsertRowid);
        if (seq % 1000 === 0)
            this.db.prepare('DELETE FROM changes WHERE seq < ?').run(seq - 10000);
        return seq;
    }
    transaction(operation) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    list() { return this.db.prepare('SELECT body FROM conversations ORDER BY updated DESC,id').all().map(row => JSON.parse(row.body)); }
    get(id) { const row = this.db.prepare('SELECT body FROM conversations WHERE id=?').get(id); if (!row)
        throw new Error('CONVERSATION_NOT_FOUND'); return JSON.parse(row.body); }
    save(body) {
        if (!body || typeof body.id !== 'string' || typeof body.updatedAt !== 'string')
            throw new Error('INVALID_CONVERSATION');
        return this.transaction(() => { this.db.prepare('INSERT INTO conversations(id,updated,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,body=excluded.body').run(body.id, body.updatedAt, JSON.stringify(body)); return this.changed(body.id, 'conversation', body.id); });
    }
    patch(id, fields, unset = []) {
        return this.transaction(() => {
            const current = this.get(id);
            for (const [key, value] of Object.entries(fields)) if (key !== 'id') current[key] = value;
            for (const key of unset) if (key !== 'id') delete current[key];
            this.db.prepare('UPDATE conversations SET updated=?,body=? WHERE id=?').run(current.updatedAt, JSON.stringify(current), id);
            return this.changed(id, 'conversation', id);
        });
    }
    remove(id) { return this.transaction(() => { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); return this.changed(id, 'deleted', id); }); }
    append(id, body) {
        if (!body || typeof body.id !== 'string' || typeof body.text !== 'string')
            throw new Error('INVALID_MESSAGE');
        return this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM messages WHERE conversation=? AND id=?').get(id, body.id);
            const json = JSON.stringify(body);
            if (row?.body === json)
                return this.revision();
            if (row)
                throw new Error('MESSAGE_ID_REUSED');
            this.db.prepare('INSERT INTO messages(conversation,id,body,text) VALUES(?,?,?,?)').run(id, body.id, json, body.text);
            return this.changed(id, 'message', body.id);
        });
    }
    messages(id) { return this.db.prepare('SELECT body FROM messages WHERE conversation=? ORDER BY seq').all(id).map(row => JSON.parse(row.body)); }
    page(id, before, limit = 50) {
        limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        const cursor = before == null ? Number.MAX_SAFE_INTEGER : Number(before);
        if (!Number.isSafeInteger(cursor) || cursor < 1)
            throw new Error('INVALID_CURSOR');
        const rows = this.db.prepare('SELECT seq,body FROM messages WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id, cursor, limit + 1);
        const more = rows.length > limit;
        const selected = rows.slice(0, limit).reverse();
        return { items: selected.map(row => { const body = JSON.parse(row.body); return { ...body, text: body.text.slice(0, 8000), ...(body.text.length > 8000 ? { bodyTruncated: true, bodyLength: body.text.length } : {}), sequence: Number(row.seq) }; }), ...(more ? { before: String(selected[0].seq) } : {}), revision: this.revision() };
    }
    body(id, messageId) { const row = this.db.prepare('SELECT body FROM messages WHERE conversation=? AND id=?').get(id, messageId); if (!row)
        throw new Error('MESSAGE_NOT_FOUND'); return JSON.parse(row.body); }
    search(id, query, limit = 50) {
        if (typeof query !== 'string' || !query.trim())
            return [];
        return this.db.prepare('SELECT id,substr(text,1,500) AS preview FROM messages WHERE conversation=? AND instr(lower(text),lower(?))>0 ORDER BY seq DESC LIMIT ?').all(id, query.slice(0, 200), Math.min(100, Math.max(1, Number(limit) || 50)));
    }
    replace(id, messages) { return this.transaction(() => { this.db.prepare('DELETE FROM messages WHERE conversation=?').run(id); const stmt = this.db.prepare('INSERT INTO messages(conversation,id,body,text) VALUES(?,?,?,?)'); for (const m of messages)
        stmt.run(id, m.id, JSON.stringify(m), m.text); return this.changed(id, 'reset', id); }); }
    readState(key) { const row = this.db.prepare('SELECT body FROM state WHERE key=?').get(key); return row ? JSON.parse(row.body) : undefined; }
    saveState(key, body) { return this.transaction(() => { this.db.prepare('INSERT INTO state(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(body)); return this.changed(null, 'state', key); }); }
    revision() { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM changes').get().seq); }
    changes(after = 0) { const min = Number(this.db.prepare('SELECT coalesce(min(seq),0) AS seq FROM changes').get().seq); return { reset: after > 0 && after < min - 1, revision: this.revision(), items: this.db.prepare('SELECT seq,conversation,kind,item FROM changes WHERE seq>? ORDER BY seq LIMIT 10000').all(after) }; }
}
export const readMethods = new Set(['assistantView', 'list', 'get', 'messages', 'page', 'body', 'search', 'readState', 'revision', 'changes']);
export const writeMethods = new Set(['save', 'patch', 'remove', 'append', 'replace', 'saveState']);
