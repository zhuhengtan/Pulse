import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConversationDatabase } from '@hunterzhu/pulse-data/sqlite';
let database;
const get = () => database ??= new ConversationDatabase(workerData.directory, true);
const publicConversation = value => { const { executionCwd, jarvisWorkspace, ...view } = value; return view; };
parentPort.on('message', async ({ id, path }) => {
    try {
        const url = new URL(path, 'http://pulse.local');
        let body;
        if (url.pathname === '/api/approval-policy')
            body = { policy: get().readState('approval-policy')?.policy === 'delegate' ? 'delegate' : 'manual' };
        else if (url.pathname === '/api/assistant')
            body = get().assistantView(url.searchParams.get('before') ?? undefined);
        else if (url.pathname === '/api/conversations') {
            const assistant = get().readState('assistant-inbox')?.conversationId;
            body = get().list().filter(item => item.id !== assistant && Boolean(item.archivedAt) === (url.searchParams.get('archived') === '1')).map(publicConversation);
        }
        else if (url.pathname === '/api/projects') {
            const saved = JSON.parse(await readFile(join(workerData.directory, 'h5-projects.json'), 'utf8').catch(() => '{"projects":[]}'));
            const { lstat } = await import('node:fs/promises');
            body = await Promise.all(saved.projects.map(async (item) => ({ ...item, available: await lstat(item.cwd).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false) })));
        }
        else {
            const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/), messages = url.pathname.match(/^\/api\/data\/conversations\/([^/]+)\/(messages|body|search)$/);
            const run = url.pathname.match(/^\/api\/runs\/([^/]+)\/state$/);
            if (conversation)
                body = { ...publicConversation(get().get(decodeURIComponent(conversation[1]))), ...(get().readState('assistant-inbox')?.conversationId === decodeURIComponent(conversation[1]) ? { kind: 'assistant' } : {}) };
            else if (messages) {
                const cid = decodeURIComponent(messages[1]);
                get().get(cid);
                body = messages[2] === 'messages' ? get().page(cid, url.searchParams.get('before') ?? undefined) : messages[2] === 'body' ? get().body(cid, url.searchParams.get('id')) : get().search(cid, url.searchParams.get('q') ?? '');
            }
            else if (run)
                body = get().readState(`run:${decodeURIComponent(run[1])}`) ?? { runId: run[1], state: 'interrupted', seq: 0, activities: [] };
            else
                throw new Error('LOCAL_QUERY_NOT_ALLOWED');
        }
        parentPort.postMessage({ id, status: 200, body });
    }
    catch (error) {
        parentPort.postMessage({ id, status: 404, body: { error: error.code === 'ERR_SQLITE_ERROR' ? 'LOCAL_DATA_UNAVAILABLE' : error.message } });
    }
});
