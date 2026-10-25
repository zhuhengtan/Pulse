import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderClient } from '../../packages/server/dist/updates/reader-client.js';
import { createLocalHost, H5Server } from '../../packages/server/dist/index.js';
const directory = await mkdtemp(join(tmpdir(), 'pulse-query-bench-')), host = createLocalHost({ cwd: directory, dataDir: directory }), server = new H5Server(host, { dataDir: directory, port: 0, host: '127.0.0.1' });
let reader, timer;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
try {
    await host.init();
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`;
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } }), cookie = session.headers.get('set-cookie').split(';')[0];
    const work = await host.createConversation({ title: '10000 messages' }), runDir = join(directory, 'conversations', work.id, 'runs/run-large');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'runtime.json'), JSON.stringify({ padding: 'x'.repeat(50 * 1024 * 1024) }));
    await host.conversationData.call('replace', work.id, Array.from({ length: 10000 }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', text: 'History ' + i + ' ' + 'x'.repeat(100), createdAt: new Date(i * 1000).toISOString() })));
    let events = 0, rpcQueries = 0, runtimeArchiveQueries = 0;
    const originalLanes = host.getPublicRunLanes.bind(host);
    host.getPublicRunLanes = (...args) => { runtimeArchiveQueries++; return originalLanes(...args); };
    await host.conversationData.call('save', { ...await host.conversationData.call('get', work.id), origin: 'assistant', activeRunId: 'run-bench-a', runs: ['run-bench-a', 'run-bench-b'] });
    for (const id of ['run-bench-a', 'run-bench-b']) {
        server.runEventBuffers.set(id, []);
        server.runSseClients.set(id, new Set());
        server.runConversations.set(id, work.id);
        server.activeRuns.set(id, { id, conversationId: work.id, pendingInteractions: () => { rpcQueries++; return new Promise(() => { }); }, cancel: async () => { } });
    }
    timer = setInterval(() => { for (const runId of ['run-bench-a', 'run-bench-b'])
        server.pushEvent(runId, { type: 'status', runId, conversationId: work.id, seq: ++events, data: { kind: 'working', label: 'Benchmark progress' } }); }, 100);
    reader = new ReaderClient(directory);
    const native = [], http = [], chat = [];
    for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const path = `/api/data/conversations/${work.id}/messages`;
        const local = reader.query(path);
        const remote = fetch(base + path, { headers: { Cookie: cookie } }).then(async (response) => { if (!response.ok)
            throw new Error('HTTP_QUERY_FAILED'); await response.json(); http.push(performance.now() - start); });
        const assistant = fetch(base + '/api/assistant', { headers: { Cookie: cookie } }).then(async (response) => { if (!response.ok)
            throw new Error('CHAT_QUERY_FAILED'); await response.json(); chat.push(performance.now() - start); });
        const page = await local;
        if (page.status !== 200 || page.body.items.length !== 50)
            throw new Error('LOCAL_QUERY_FAILED');
        native.push(performance.now() - start);
        await Promise.all([remote, assistant]);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const result = { messages: 10000, runtimeMiB: 50, concurrentRunProjections: 2, events, queries: 100, nativeP95Ms: percentile(native, .95), httpP95Ms: percentile(http, .95), assistantP95Ms: percentile(chat, .95), workerRpcQueries: rpcQueries, runtimeArchiveQueries };
    if (rpcQueries || runtimeArchiveQueries)
        throw new Error('HOT_QUERY_DEPENDS_ON_RUNTIME');
    if (result.nativeP95Ms > 200 || result.httpP95Ms > 200 || result.assistantP95Ms > 200)
        throw new Error('QUERY_P95_EXCEEDED:' + JSON.stringify(result));
    console.log(JSON.stringify(result));
}
finally {
    clearInterval(timer);
    reader?.close();
    server.activeRuns.clear();
    await server.stop();
    await host.close();
    await new Promise(r => setTimeout(r, 1700));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
