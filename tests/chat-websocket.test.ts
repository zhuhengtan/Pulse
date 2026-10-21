import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalHost, H5Server } from '@hunterzhu/pulse-server';
const WebSocket = createRequire(new URL('../packages/server/package.json', import.meta.url))('ws');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse())
    await cleanup(); });
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-chat-socket-')), host = createLocalHost({ cwd: directory, dataDir: directory, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', mockResponse: 'socket answer', jarvis: { enabled: false } });
    const server = new H5Server(host, { dataDir: directory, port: 0, host: '127.0.0.1' });
    await host.init();
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`;
    cleanups.push(async () => { await server.stop(); await host.close(); await new Promise(r => setTimeout(r, 1600)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } }), cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    return { directory, host, server, base, cookie };
}
async function socket(base: string, cookie: string) { const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Origin: base, Cookie: cookie } }); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); cleanups.push(async () => { ws.terminate(); }); return ws; }
function call(ws: any, id: string, path: string, method = 'GET', body?: unknown): Promise<any> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`SOCKET_RESPONSE_TIMEOUT:${id}`)); }, 4000); const receive = (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.id === id) {
    clearTimeout(timer);
    ws.off('message', receive);
    resolve(frame);
} }; ws.on('message', receive); ws.send(JSON.stringify({ type: 'request', id, path, method, body })); }); }
it('uses authenticated WebSocket requests, idempotent sends and event replay', async () => {
    const { base, cookie, host } = await fixture(), ws = await socket(base, cookie);
    const view = await call(ws, 'view', '/api/assistant');
    expect(view.status).toBe(200);
    const body = { requestId: 'socket-request-001', text: 'hello via socket' };
    const first = await call(ws, 'send', '/api/assistant/messages', 'POST', body), second = await call(ws, 'repeat', '/api/assistant/messages', 'POST', body);
    expect(first.status).toBe(202);
    expect(second.body.runId).toBe(first.body.runId);
    expect(second.body.duplicate).toBe(true);
    const event = await new Promise<any>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('EVENT_TIMEOUT')), 4000); ws.on('message', (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.type === 'event' && frame.event.type === 'complete') {
        clearTimeout(timeout);
        resolve(frame.event);
    } }); ws.send(JSON.stringify({ type: 'subscribe', runId: first.body.runId, after: 0 })); });
    expect(event.data).toMatchObject({ status: 'succeeded' });
    const messages = await host.getConversationMessages(view.body.conversation.id);
    expect(messages.filter(message => message.id === 'msg-socket-request-001')).toHaveLength(1);
    expect(messages.some(message => message.text === 'socket answer')).toBe(true);
});
it('rejects foreign-origin upgrades and keeps history reads independent of a blocked worker RPC', async () => {
    const { base, cookie, host, server } = await fixture();
    await expect(new Promise((resolve, reject) => { const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Origin: 'https://foreign.example', Cookie: cookie } }); ws.once('open', () => { ws.terminate(); resolve(undefined); }); ws.once('error', reject); })).rejects.toThrow();
    const conversation = await host.createConversation({ origin: 'assistant' }), manifest = await host.conversationData.call<Record<string, unknown>>('get', conversation.id);
    await host.conversationData.call('save', { ...manifest, activeRunId: 'run-blocked', runs: ['run-blocked'] });
    const pending = vi.fn(() => new Promise(() => { }));
    (server as any).activeRuns.set('run-blocked', { id: 'run-blocked', conversationId: conversation.id, pendingInteractions: pending, cancel: async () => { } });
    const ws = await socket(base, cookie), started = performance.now(), view = await call(ws, 'fast', '/api/assistant');
    expect(view.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(200);
    expect(pending).not.toHaveBeenCalled();
    (server as any).activeRuns.delete('run-blocked');
});
it('resynchronizes a cursor outside the event buffer without a worker RPC', async () => {
    const { base, cookie, host, server } = await fixture(), view = await fetch(base + '/api/assistant', { headers: { Cookie: cookie } }).then(response => response.json()) as any;
    const runId = 'run-expired-cursor', conversationId = view.conversation.id;
    const manifest = await host.conversationData.call<Record<string, unknown>>('get', conversationId);
    await host.conversationData.call('save', { ...manifest, activeRunId: runId, runs: [runId] });
    (server as any).runEventBuffers.set(runId, [{ runId, conversationId, seq: 100, type: 'status', data: { kind: 'working' } }]);
    (server as any).runSnapshots.set(runId, { runId, state: 'succeeded', seq: 101, activities: [] });
    const ws = await socket(base, cookie);
    const event = await new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('RESYNC_TIMEOUT')), 2000); ws.on('message', (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.type === 'event') {
        clearTimeout(timer);
        resolve(frame.event);
    } }); ws.send(JSON.stringify({ type: 'subscribe', runId, after: 1 })); });
    expect(event).toMatchObject({ type: 'resync', seq: 101, data: { state: 'succeeded' } });
});
it('starts without replaying completed inbox history', async () => {
    const { host, server, directory } = await fixture();
    await server.stop();
    const inbox = await host.conversationData.call<any>('readState', 'assistant-inbox');
    inbox.messages = Array.from({ length: 10000 }, (_, i) => ({ messageId: `request-complete-${i}`, runId: `run-old-${i}`, text: 'old', state: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01' }));
    await host.conversationData.call('saveState', 'assistant-inbox', inbox);
    const record = vi.spyOn(host, 'appendAssistantUserMessage');
    const restarted = new H5Server(host, { dataDir: directory, port: 0, host: '127.0.0.1' });
    cleanups.push(async () => { await restarted.stop(); });
    const started = performance.now();
    await restarted.start();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(record).not.toHaveBeenCalled();
});
