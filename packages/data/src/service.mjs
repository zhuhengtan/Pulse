import { createServer } from 'node:net';
import { chmodSync, existsSync, unlinkSync, openSync, writeFileSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationDatabase, readMethods, writeMethods } from './sqlite.mjs';
const [directory, endpoint] = process.argv.slice(2);
if (!directory || !endpoint)
    process.exit(2);
if (existsSync(join(directory, 'migration.lock')))
    process.exit(1);
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
            throw error;
        let owner;
        try {
            owner = JSON.parse(readFileSync(lockPath, 'utf8'));
        }
        catch {
            process.exit(1);
        }
        try {
            process.kill(owner.pid, 0);
            process.exit(0);
        }
        catch (probe) {
            if (probe.code !== 'ESRCH')
                process.exit(1);
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
    socket.on('close', () => { clients.delete(socket); if (!clients.size)
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
server.on('error', error => { if (error.code === 'EADDRINUSE')
    process.exit(0); process.exit(1); });
server.listen(endpoint, () => { try {
    if (process.platform !== 'win32')
        chmodSync(endpoint, 0o600);
    database = new ConversationDatabase(directory);
    idle = setTimeout(() => { if (!clients.size)
        server.close(stop); }, 3000);
}
catch {
    process.exit(1);
} });
process.once('SIGTERM', () => server.close(stop));
