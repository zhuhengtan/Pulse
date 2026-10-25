import { UpdateManager } from './manager.js';
import { frontendResource } from './frontend.js';
import { createRequire } from 'node:module';
const directory = process.argv[2];
if (!directory || !process.send) throw new Error('READER_IPC_REQUIRED');
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const { ConversationDatabase } = createRequire(import.meta.url)('@hunterzhu/pulse-data/sqlite');
let database: any;
const get = () => database ??= new ConversationDatabase(directory, true);
const updates = new UpdateManager({ dataDir: directory, backendVersion: createRequire(import.meta.url)('../../package.json').version, ...(process.argv[3] ? { root: process.argv[3] } : {}) });
const publicConversation = (value: Record<string, any>) => { const { executionCwd, jarvisWorkspace, ...view } = value; return view; };
process.on('disconnect', () => { database?.close(); process.exit(0); });
process.on('message', async (raw: unknown) => {
    const { id, path, protocol } = raw as { id: string; path: string; protocol: number };
    if (protocol !== 1 || typeof id !== 'string' || typeof path !== 'string' || path.length > 4096) return;
    try {
        const url = new URL(path, 'http://pulse.local');
        let body;
        if (url.pathname === '/_frontend') {
            const resource = await frontendResource(updates, process.argv[4], url.searchParams.get('path') ?? '/', url.searchParams.get('page') === '1');
            if (!resource) throw new Error('FRONTEND_UNAVAILABLE');
            body = { ...resource, content: resource.content.toString('base64') };
        }
        else if (url.pathname === '/_health') body = { protocol: 1, revision: Number(get().db.prepare('SELECT max(seq) AS value FROM changes').get().value ?? 0) };
        else if (url.pathname === '/api/approval-policy')
            body = { policy: get().readState('approval-policy')?.policy === 'delegate' ? 'delegate' : 'manual' };
        else if (url.pathname === '/api/assistant')
            body = get().assistantView(url.searchParams.get('before') ?? undefined);
        else if (url.pathname === '/api/conversations') {
            const assistant = get().readState('assistant-inbox')?.conversationId;
            body = get().list().filter((item: Record<string, any>) => item.id !== assistant && Boolean(item.archivedAt) === (url.searchParams.get('archived') === '1')).map(publicConversation);
        }
        else if (url.pathname === '/api/projects') {
            const saved = JSON.parse(await readFile(join(directory, 'h5-projects.json'), 'utf8').catch(() => '{"projects":[]}'));
            const { lstat } = await import('node:fs/promises');
            body = await Promise.all(saved.projects.map(async (item: Record<string, any>) => ({ ...item, available: await lstat(item.cwd).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false) })));
        }
        else {
            const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/), messages = url.pathname.match(/^\/api\/data\/conversations\/([^/]+)\/(messages|body|search)$/);
            const run = url.pathname.match(/^\/api\/runs\/([^/]+)\/state$/);
            if (conversation)
                body = { ...publicConversation(get().get(decodeURIComponent(conversation[1]!))), ...(get().readState('assistant-inbox')?.conversationId === decodeURIComponent(conversation[1]!) ? { kind: 'assistant' } : {}) };
            else if (messages) {
                const cid = decodeURIComponent(messages[1]!);
                get().get(cid);
                body = messages[2] === 'messages' ? get().page(cid, url.searchParams.get('before') ?? undefined) : messages[2] === 'body' ? get().body(cid, url.searchParams.get('id')) : get().search(cid, url.searchParams.get('q') ?? '');
            }
            else if (run)
                body = get().readState(`run:${decodeURIComponent(run[1]!)}`) ?? { runId: run[1], state: 'interrupted', seq: 0, activities: [] };
            else
                throw new Error('LOCAL_QUERY_NOT_ALLOWED');
        }
        process.send?.({ id, status: 200, body });
    }
    catch (cause) {
        const error = cause as Error & { code?: string };
        process.send?.({ id, status: 404, body: { error: error.code === 'ERR_SQLITE_ERROR' ? 'LOCAL_DATA_UNAVAILABLE' : error.message } });
    }
});
