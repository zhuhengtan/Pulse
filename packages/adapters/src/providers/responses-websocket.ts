import WebSocket from 'ws';
import { createHash } from 'node:crypto';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const error = (code: string) => Object.assign(new Error(code), { code, retryable: false });
type Callbacks = {
    signal: AbortSignal;
    event(frame: Record<string, any>): void;
    validate(response: unknown): void;
    nativeItems(response: unknown): unknown[];
};
class Connection {
    private socket: WebSocket | undefined;
    private opening: Promise<void> | undefined;
    private active: {
        reject: (error: Error) => void;
        message: (frame: Record<string, any>) => void;
    } | undefined;
    private previous: {
        id: string;
        conditions: string;
        history: unknown[];
    } | undefined;
    private dead = false;
    private readonly seen = new Set<string>();
    constructor(private readonly endpoint: string, private readonly headers: Record<string, string>) { }
    get unavailable() { return this.dead; }
    get busy() { return this.active !== undefined || this.socket?.readyState === WebSocket.CONNECTING; }
    close() { if (this.dead)
        return; this.dead = true; this.previous = undefined; this.active?.reject(error('PROVIDER_WS_OUTCOME_UNKNOWN')); this.active = undefined; this.socket?.terminate(); }
    private connect(signal: AbortSignal): Promise<void> {
        return this.opening ??= new Promise<void>((resolve, reject) => {
            signal.throwIfAborted();
            const socket = this.socket = new WebSocket(this.endpoint, { headers: this.headers, maxPayload: 2097152, handshakeTimeout: 15000 });
            const abort = () => { reject(error('PROVIDER_REQUEST_CANCELLED')); this.close(); };
            signal.addEventListener('abort', abort, { once: true });
            socket.once('open', () => { signal.removeEventListener('abort', abort); resolve(); });
            socket.on('error', () => { signal.removeEventListener('abort', abort); reject(error('PROVIDER_WS_CONNECTION_FAILED')); this.close(); });
            socket.on('close', () => { signal.removeEventListener('abort', abort); reject(error('PROVIDER_WS_CONNECTION_CLOSED')); this.close(); });
            socket.on('message', (bytes, isBinary) => { try {
                if (isBinary)
                    throw error('PROVIDER_WS_INVALID_FRAME');
                const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes as Buffer));
                if (!value || typeof value.type !== 'string' || !this.active)
                    throw error('PROVIDER_WS_UNEXPECTED_EVENT');
                this.active.message(value);
            }
            catch {
                this.close();
            } });
        });
    }
    async request(body: Record<string, unknown>, cb: Callbacks): Promise<unknown> {
        if (this.active)
            throw error('PROVIDER_WS_BUSY');
        if (this.seen.size >= 1024) { this.close(); throw error('PROVIDER_WS_CONNECTION_RETIRED'); }
        try {
            await this.connect(cb.signal);
            cb.signal.throwIfAborted();
        }
        catch (cause) {
            this.close();
            throw cause;
        }
        ;
        if (this.active)
            throw error('PROVIDER_WS_BUSY');
        if (this.dead)
            throw error('PROVIDER_WS_CONNECTION_CLOSED');
        const { input, stream: _stream, ...conditions } = body, items = Array.isArray(input) ? input : [], fingerprint = digest(conditions), previous = this.previous;
        const incremental = previous && previous.conditions === fingerprint && items.length > previous.history.length && previous.history.every((item, i) => digest(item) === digest(items[i]));
        const payload = { ...conditions, type: 'response.create', input: incremental ? items.slice(previous.history.length) : items, previous_response_id: incremental ? previous.id : null };
        return new Promise((resolve, reject) => {
            let responseId: string | undefined, terminal = false;
            const cleanup = () => { clearTimeout(timer); cb.signal.removeEventListener('abort', abort); this.active = undefined; };
            const fail = (cause: Error) => { cleanup(); reject('retryable' in cause && cause.retryable === false ? cause : Object.assign(error('PROVIDER_WS_OUTCOME_UNKNOWN'), { cause })); this.close(); };
            const abort = () => fail(error('PROVIDER_REQUEST_CANCELLED')), timer = setTimeout(() => fail(error('PROVIDER_WS_OUTCOME_UNKNOWN')), 120000);
            cb.signal.addEventListener('abort', abort, { once: true });
            this.active = { reject: cause => { cleanup(); reject(cause); }, message: frame => {
                    try {
                        if (terminal)
                            throw error('PROVIDER_WS_DUPLICATE_TERMINAL');
                        if (frame.type === 'response.created') {
                            if (responseId || typeof frame.response?.id !== 'string' || !frame.response.id || this.seen.has(frame.response.id))
                                throw error('PROVIDER_WS_RESPONSE_ID_INVALID');
                            responseId = frame.response.id;
                        }
                        if (!responseId && frame.type !== 'error') throw error('PROVIDER_WS_RESPONSE_ID_INVALID');
                        if (frame.response_id !== undefined && responseId !== undefined && frame.response_id !== responseId)
                            throw error('PROVIDER_WS_RESPONSE_ID_MISMATCH');
                        if (['error', 'response.failed', 'response.cancelled'].includes(frame.type))
                            throw error('PROVIDER_WS_OUTCOME_UNKNOWN');
                        cb.event(frame);
                        if (frame.type === 'response.completed' || frame.type === 'response.incomplete') {
                            terminal = true;
                            const response = frame.response;
                            if (!response || response.status !== (frame.type === 'response.completed' ? 'completed' : 'incomplete') || typeof response.id !== 'string' || !responseId || response.id !== responseId)
                                throw error('PROVIDER_WS_TERMINAL_INVALID');
                            cb.validate(response);
                            this.seen.add(response.id);
                            this.previous = response.status === 'completed' ? { id: response.id, conditions: fingerprint, history: [...items, ...cb.nativeItems(response)] } : undefined;
                            cleanup();
                            resolve(response);
                        }
                    }
                    catch (cause) {
                        fail(cause instanceof Error ? cause : error('PROVIDER_WS_INVALID_RESPONSE'));
                    }
                } };
            try {
                this.socket!.send(JSON.stringify(payload), cause => { if (cause)
                    fail(error('PROVIDER_WS_OUTCOME_UNKNOWN')); });
            }
            catch {
                fail(error('PROVIDER_WS_OUTCOME_UNKNOWN'));
            }
        });
    }
}
export class ResponsesWebSocketPool {
    private readonly connections = new Map<string, Connection>();
    private readonly owners = new Map<string, string>();
    async request(endpoint: string, headers: Record<string, string>, scope: string, key: string, body: Record<string, unknown>, callbacks: Callbacks): Promise<unknown> {
        const id = digest([endpoint, headers, scope, key]);
        const old = this.owners.get(key);
        if (old && old !== id) { if (this.connections.get(old)?.busy) throw error('PROVIDER_WS_BUSY'); this.connections.get(old)?.close(); this.connections.delete(old); }
        this.owners.set(key, id);
        let connection = this.connections.get(id);
        if (!connection || connection.unavailable) {
            if (connection?.unavailable) this.connections.delete(id);
            if (this.connections.size >= 32) {
                const oldest = [...this.connections].find(([, connection]) => !connection.busy)?.[0];
                if (!oldest) { this.owners.delete(key); throw error('PROVIDER_WS_CONNECTION_LIMIT'); }
                this.connections.get(oldest)!.close(); this.connections.delete(oldest);
                for (const [owner, current] of this.owners) if (current === oldest) this.owners.delete(owner);
            }
            connection = new Connection(endpoint.replace(/^http/, 'ws'), headers);
            this.connections.set(id, connection);
        }
        return connection.request(body, callbacks);
    }
    releaseOwner(owner: string) { const id = this.owners.get(owner); if (id) { this.connections.get(id)?.close(); this.connections.delete(id); this.owners.delete(owner) } }
    releaseScope(scope: string) { for (const [owner,id] of this.owners) if (owner.startsWith(scope + ":")) { this.connections.get(id)?.close(); this.connections.delete(id); this.owners.delete(owner) } }
    dispose() { for (const connection of this.connections.values())
        connection.close(); this.connections.clear(); this.owners.clear(); }
}
