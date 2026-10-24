import { createConnection, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, readdir, access, lstat, chmod, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export interface MessagePage<T = Record<string, unknown>> {
    items: T[];
    before?: string;
    revision: number;
}
export interface DataChange {
    seq: number;
    conversation: string | null;
    kind: string;
    item: string | null;
}
export function dataEndpoint(directory: string): string { const digest = createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 24); return process.platform === 'win32' ? `\\\\.\\pipe\\pulse-data-${digest}` : join('/tmp', `pulse-ipc-${process.getuid?.() ?? 'user'}`, `${digest}.sock`); }
// A kernel connection alone can target a writer that has already begun its
// final shutdown. Only expose a socket after the writer has registered it.
function connectReadySocket(endpoint: string): Promise<Socket> {
    return new Promise((resolveSocket, reject) => {
        const socket = createConnection(endpoint);
        socket.setEncoding('utf8');
        let buffer = '';
        const fail = (cause?: Error) => { cleanup(); socket.destroy(); reject(cause ?? Object.assign(new Error('DATA_SERVICE_DISCONNECTED'), { code: 'DATA_SERVICE_DISCONNECTED' })); };
        const timer = setTimeout(() => fail(Object.assign(new Error('DATA_SERVICE_HANDSHAKE_TIMEOUT'), { code: 'DATA_SERVICE_HANDSHAKE_TIMEOUT' })), 2000);
        const closed = () => fail();
        const cleanup = () => { clearTimeout(timer); socket.removeListener('error', fail); socket.removeListener('close', closed); socket.removeListener('data', receive); };
        const receive = (chunk: string) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 64 * 1024) { fail(new Error('DATA_RESPONSE_TOO_LARGE')); return; }
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                try {
                    const response = JSON.parse(line);
                    if (response.id !== 0) continue;
                    if (!Number.isSafeInteger(response.value) || response.value < 0) { fail(new Error('DATA_SERVICE_NOT_READY')); return; }
                    socket.pause(); cleanup();
                    if (buffer) socket.unshift(buffer);
                    resolveSocket(socket); return;
                } catch { fail(new Error('DATA_RESPONSE_INVALID')); return; }
            }
        };
        socket.on('error', fail); socket.on('close', closed); socket.on('data', receive);
        socket.once('connect', () => socket.write(JSON.stringify({ id: 0, method: 'revision', args: [] }) + '\n'));
    });
}
/** One writer service per data directory; clients never perform synchronous SQL in the gateway. */
export class ConversationData {
    private closed = false;
    private socket: Socket | undefined;
    private connecting: Promise<void> | undefined;
    private closing: Promise<void> | undefined;
    private serial = 0;
    private pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private listeners = new Set<(revision: number) => void>();
    constructor(readonly directory: string) { }
    onChange(listener: (revision: number) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private async connect(): Promise<void> {
        if (this.closed)
            throw new Error('DATA_CLIENT_CLOSED');
        if (this.socket && !this.socket.destroyed)
            return;
        if (this.connecting)
            return this.connecting;
        this.connecting = this.open().finally(() => { this.connecting = undefined; });
        return this.connecting;
    }
    private async open(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (await access(join(this.directory, 'migration.lock')).then(() => true, () => false))
            throw new Error('DATA_MIGRATION_IN_PROGRESS');
        if (!await access(join(this.directory, 'pulse.sqlite')).then(() => true, () => false)) {
            const entries = await readdir(join(this.directory, 'conversations')).catch(() => []);
            for (const entry of entries)
                if (await access(join(this.directory, 'conversations', entry, 'manifest.json')).then(() => true, () => false))
                    throw new Error('DATA_MIGRATION_REQUIRED');
        }
        const endpoint = dataEndpoint(this.directory);
        if (process.platform !== 'win32') {
            await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
            const info = await lstat(dirname(endpoint));
            if (info.isSymbolicLink() || info.uid !== process.getuid?.())
                throw new Error('DATA_ENDPOINT_OWNER_INVALID');
            await chmod(dirname(endpoint), 0o700);
        }
        const attempt = () => connectReadySocket(endpoint);
        const openStartedAt = Date.now();
        let socket: Socket | undefined;
        while (!socket) {
            try {
                socket = await attempt();
            }
            catch (error) {
                const child = spawn(process.execPath, [fileURLToPath(new URL('./service.mjs', import.meta.url)), resolve(this.directory), endpoint], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
                child.unref();
                const startedAt = openStartedAt;
                let phase = 'starting';
                let serviceCode: string | undefined;
                let exitCode: number | null | undefined;
                let exitSignal: NodeJS.Signals | null | undefined;
                let lastConnectCode: string | undefined;
                child.channel?.unref();
                const onMessage = (message: unknown) => {
                    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'pulse-data-startup') return;
                    const value = message as { phase?: unknown; code?: unknown };
                    if (typeof value.phase === 'string' && /^[a-z-]{1,40}$/.test(value.phase)) phase = value.phase;
                    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)) serviceCode = value.code;
                };
                const onExit = (code: number | null, signal: NodeJS.Signals | null) => { exitCode = code; exitSignal = signal; };
                const onError = (cause: NodeJS.ErrnoException) => { phase = 'spawn'; serviceCode = cause.code ?? 'SPAWN_FAILED'; };
                child.on('message', onMessage);
                child.on('exit', onExit);
                child.on('error', onError);
                const unavailable = (code: string) => Object.assign(new Error(`${code}: phase=${phase}${serviceCode ? ` code=${serviceCode}` : ''}${exitCode !== undefined ? ` exit=${exitCode}` : ''}${exitSignal ? ` signal=${exitSignal}` : ''}${lastConnectCode ? ` connect=${lastConnectCode}` : ''}`), {
                    code, details: { phase, serviceCode, exitCode, exitSignal, childPid: child.pid, connectionCode: lastConnectCode, elapsedMs: Date.now() - startedAt },
                });
                let found: Socket | undefined;
                try {
                    // Cold native process startup can exceed three seconds under concurrent
                    // work. Wait for explicit database readiness within one wall-clock budget.
                    const deadline = startedAt + 15_000;
                    while (Date.now() < deadline) {
                        if (serviceCode || exitCode !== undefined && exitCode !== 0 || exitSignal) throw unavailable('DATA_SERVICE_START_FAILED');
                        // Another client may already own the writer. Its child exits cleanly;
                        // connect to that writer without deleting its lock or killing it.
                        if (phase === 'ready' || phase === 'lock-owner-alive' || exitCode === 0) {
                            try { found = await attempt(); break; }
                            catch (cause) {
                                lastConnectCode = (cause as NodeJS.ErrnoException).code;
                                // The old writer may have acknowledged its final close
                                // after a competing startup observed its live PID.
                                if (exitCode === 0 && !await access(join(this.directory, '.writer.lock')).then(() => true, () => false)) break;
                            }
                        }
                        await new Promise(r => setTimeout(r, Math.min(30, Math.max(1, deadline - Date.now()))));
                    }
                    if (!found && Date.now() >= deadline) throw unavailable('DATA_SERVICE_UNAVAILABLE');
                } finally {
                    child.removeListener('message', onMessage);
                    child.removeListener('exit', onExit);
                    // A spawn error can arrive after a closing client has stopped waiting.
                    child.removeListener('error', onError);
                    child.on('error', () => {});
                    if (child.connected) child.disconnect();
                }
                socket = found;
            }
        }
        // A close racing startup joins this connection and releases it through
        // the same graceful protocol; do not leave an unclaimed writer behind.
        this.socket = socket;
        socket.unref();
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => { buffer += chunk; if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
            socket.destroy(new Error('DATA_RESPONSE_TOO_LARGE'));
            return;
        } let n; while ((n = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, n);
            buffer = buffer.slice(n + 1);
            try {
                const result = JSON.parse(line) as {
                    id?: number;
                    value?: unknown;
                    error?: string;
                    changed?: boolean;
                    revision?: number;
                };
                if (result.changed) {
                    for (const listener of this.listeners)
                        listener(result.revision ?? 0);
                    continue;
                }
                const item = this.pending.get(result.id!);
                if (item) {
                    this.pending.delete(result.id!);
                    if (!this.pending.size)
                        socket.unref();
                    clearTimeout(item.timer);
                    if (result.error)
                        item.reject(new Error(result.error));
                    else
                        item.resolve(result.value);
                }
            }
            catch {
                socket.destroy(new Error('DATA_RESPONSE_INVALID'));
            }
        } });
        const fail = () => { if (this.socket !== socket) return;
            this.socket = undefined; for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('DATA_SERVICE_DISCONNECTED'));
        } this.pending.clear(); };
        socket.on('error', fail);
        socket.on('close', fail);
        socket.resume();
    }
    async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        await this.connect();
        if (this.closed) throw new Error('DATA_CLIENT_CLOSED');
        return this.request<T>(method, args);
    }
    private request<T>(method: string, args: unknown[]): Promise<T> { return new Promise<T>((resolveCall, reject) => { if (this.pending.size >= 256) {
        reject(new Error('DATA_QUEUE_FULL'));
        return;
    } const id = ++this.serial; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('DATA_REQUEST_TIMEOUT')); }, 10000); this.pending.set(id, { resolve: v => resolveCall(v as T), reject, timer }); this.socket!.ref(); this.socket!.write(JSON.stringify({ id, method, args }) + '\n'); }); }
    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.closing = this.disconnect();
        return this.closing;
    }
    private async disconnect(): Promise<void> {
        await this.connecting?.catch(() => undefined);
        const socket = this.socket;
        if (!socket || socket.destroyed) return;
        // Graceful release drains prior requests. Only the final client closes the
        // writer; losing a connection still retains the normal reconnect grace.
        const released = await this.request<{ lastClient: boolean; pid: number }>('disconnect', []).catch(() => undefined);
        await new Promise<void>(resolve => {
            if (socket.destroyed) { resolve(); return; }
            socket.once('close', () => resolve());
            socket.destroy();
        });
        if (this.socket === socket) this.socket = undefined;
        if (!released?.lastClient) return;
        const deadline = Date.now() + 2000;
        while (true) {
            const owner = await readFile(join(this.directory, '.writer.lock'), 'utf8').then(value => {
                // A replacement writer may have created its lock but not yet
                // written its PID. The released writer never rewrites this file.
                try { return JSON.parse(value) as { pid?: number }; } catch { return undefined; }
            }, error => {
                if (error.code === 'ENOENT') return undefined;
                throw error;
            });
            if (owner?.pid !== released.pid) return;
            if (Date.now() >= deadline) throw new Error('DATA_SERVICE_CLOSE_TIMEOUT');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
}
