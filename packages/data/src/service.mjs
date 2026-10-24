import { createServer } from 'node:net';
import { chmodSync, existsSync, unlinkSync, openSync, writeFileSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationDatabase, readMethods, writeMethods } from './sqlite.mjs';
// Startup status contains fixed phases and error codes only, never persisted data.
const startup = (phase, error) => new Promise(resolve => {
    const candidate = error?.code ?? error?.message;
    const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) ? candidate : error ? 'STARTUP_FAILED' : undefined;
    if (!process.connected) { resolve(); return; }
    process.send({ type: 'pulse-data-startup', phase, ...(code ? { code } : {}) }, () => resolve());
});
const exitStartup = async (phase, error, code = 1) => { await startup(phase, error); process.exit(code); };
const [directory, endpoint] = process.argv.slice(2);
if (!directory || !endpoint)
    await exitStartup('arguments', new Error('DATA_SERVICE_ARGUMENTS_INVALID'), 2);
if (existsSync(join(directory, 'migration.lock')))
    await exitStartup('migration', new Error('DATA_MIGRATION_IN_PROGRESS'));
const lockPath = join(directory, '.writer.lock');
let lock;
for (;;) {
    try {
        lock = openSync(lockPath, 'wx', 0o600);
        writeFileSync(lock, JSON.stringify({ pid: process.pid }));
        break;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            await exitStartup('lock-create', error);
        let owner;
        // A competing writer can observe the exclusive lock between creation and
        // its PID write. Give that in-flight initialization a bounded settlement.
        for (let attempt = 0; attempt < 10; attempt++) {
            try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        if (!existsSync(lockPath)) continue;
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0)
            await exitStartup('lock-invalid', new Error('DATA_WRITER_LOCK_INVALID'));

        try {
            process.kill(owner.pid, 0);
            await exitStartup('lock-owner-alive', undefined, 0);
        }
        catch (probe) {
            if (probe.code !== 'ESRCH')
                await exitStartup('lock-probe', probe);
        }
        unlinkSync(lockPath);
    }
}
process.once('exit', () => { try {
    closeSync(lock);
    unlinkSync(lockPath);
}
catch { } });
if (process.platform !== 'win32' && existsSync(endpoint))
    unlinkSync(endpoint);
const clients = new Set();
let database;
let idle;
let stopping = false;
const stop = () => { try {
    database?.close();
}
finally {
    process.exit(0);
} };
const server = createServer(socket => {
    clearTimeout(idle);
    clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => { });
    socket.on('close', () => { clients.delete(socket); if (!stopping && !clients.size)
        idle = setTimeout(() => server.close(stop), 1500); });
    socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
            socket.destroy();
            return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let request;
            try {
                request = JSON.parse(line);
                if (request.method === 'disconnect' && Array.isArray(request.args) && request.args.length === 0) {
                    clients.delete(socket);
                    const lastClient = clients.size === 0;
                    if (lastClient) {
                        stopping = true;
                        clearTimeout(idle);
                        server.close(stop);
                        database.close();
                        database = undefined;
                    }
                    socket.end(JSON.stringify({ id: request.id, value: { lastClient, pid: process.pid } }) + '\n');
                    return;
                }
                if (!readMethods.has(request.method) && !writeMethods.has(request.method))
                    throw new Error('DATA_METHOD_INVALID');
                if (!Array.isArray(request.args))
                    throw new Error('DATA_ARGS_INVALID');
                const value = database[request.method](...request.args);
                socket.write(JSON.stringify({ id: request.id, value }) + '\n');
                if (writeMethods.has(request.method)) {
                    const notification = JSON.stringify({ changed: true, revision: database.revision() }) + '\n';
                    for (const client of clients)
                        if (client.writableLength < 1024 * 1024)
                            client.write(notification);
                        else
                            client.destroy();
                }
            }
            catch (error) {
                socket.write(JSON.stringify({ id: request?.id, error: error.message }) + '\n');
            }
        }
    });
});
server.on('error', async error => { await exitStartup('listen', error.code === 'EADDRINUSE' ? undefined : error, error.code === 'EADDRINUSE' ? 0 : 1); });
server.listen(endpoint, async () => { try {
    if (process.platform !== 'win32')
        chmodSync(endpoint, 0o600);
    database = new ConversationDatabase(directory);
    await startup('ready');
    idle = setTimeout(() => { if (!clients.size)
        server.close(stop); }, 3000);
}
catch (error) {
    await exitStartup('database', error);
} });
process.once('SIGTERM', () => server.close(stop));
