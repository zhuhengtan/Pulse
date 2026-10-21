import { createConnection, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, readdir, access, lstat, chmod } from 'node:fs/promises';
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
/** One writer service per data directory; clients never perform synchronous SQL in the gateway. */
export class ConversationData {
    private closed = false;
    private socket: Socket | undefined;
    private connecting: Promise<void> | undefined;
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
        const attempt = () => new Promise<Socket>((yes, no) => { const s = createConnection(endpoint); s.once('error', no); s.once('connect', () => { s.removeListener('error', no); yes(s); }); });
        let socket: Socket;
        try {
            socket = await attempt();
        }
        catch (error) {
            const child = spawn(process.execPath, [fileURLToPath(new URL('./service.mjs', import.meta.url)), resolve(this.directory), endpoint], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
            child.unref();
            child.on('error', () => { });
            let found: Socket | undefined;
            for (let i = 0; i < 100; i++) {
                try {
                    found = await attempt();
                    break;
                }
                catch {
                    await new Promise(r => setTimeout(r, 30));
                }
            }
            if (!found)
                throw new Error('DATA_SERVICE_UNAVAILABLE');
            socket = found;
        }
        if (this.closed) {
            socket.destroy();
            throw new Error('DATA_CLIENT_CLOSED');
        }
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
        const fail = () => { if (this.socket === socket)
            this.socket = undefined; for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('DATA_SERVICE_DISCONNECTED'));
        } this.pending.clear(); };
        socket.on('error', fail);
        socket.on('close', fail);
    }
    async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> { await this.connect(); return new Promise<T>((resolveCall, reject) => { if (this.pending.size >= 256) {
        reject(new Error('DATA_QUEUE_FULL'));
        return;
    } const id = ++this.serial; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('DATA_REQUEST_TIMEOUT')); }, 10000); this.pending.set(id, { resolve: v => resolveCall(v as T), reject, timer }); this.socket!.ref(); this.socket!.write(JSON.stringify({ id, method, args }) + '\n'); }); }
    close(): void { this.closed = true; this.socket?.destroy(); this.socket = undefined; }
}
