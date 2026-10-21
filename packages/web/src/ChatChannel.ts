import type { WebRunEvent } from './transport.js';
/** One multiplexed socket. Commands have receipts; reconnect only replays subscriptions. */
export class ChatChannel {
    private socket: WebSocket | undefined;
    private connecting: Promise<WebSocket> | undefined;
    private pending = new Map<string, {
        resolve: (value: Response) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        cleanup: () => void;
    }>();
    private watchers = new Set<() => void>();
    private streams = new Map<string, {
        after: number;
        onEvent: (event: WebRunEvent) => void;
        onError: () => void;
    }>();
    private retry: ReturnType<typeof setTimeout> | undefined;
    private delay = 300;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    constructor(private readonly url: string, private readonly makeSocket: (url: string) => WebSocket = url => new WebSocket(url)) { }
    private connect(): Promise<WebSocket> {
        if (this.socket?.readyState === 1)
            return Promise.resolve(this.socket);
        if (this.connecting)
            return this.connecting;
        this.connecting = new Promise<WebSocket>((resolve, reject) => {
            const socket = this.makeSocket(this.url);
            this.socket = socket;
            const timer = setTimeout(() => { socket.close(); reject(new Error('CHAT_CONNECT_TIMEOUT')); }, 5000);
            socket.onopen = () => {
                clearTimeout(timer);
                this.delay = 300;
                for (const [runId, stream] of this.streams)
                    socket.send(JSON.stringify({ type: 'subscribe', runId, after: stream.after }));
                clearInterval(this.heartbeat);
                this.heartbeat = setInterval(() => { if (socket.readyState === 1)
                    socket.send(JSON.stringify({ type: 'ping' })); }, 20000);
                resolve(socket);
            };
            socket.onmessage = message => {
                try {
                    const frame = JSON.parse(String(message.data)) as {
                        type: string;
                        id?: string;
                        status?: number;
                        body?: unknown;
                        event?: WebRunEvent;
                    };
                    if (frame.type === 'response' && frame.id) {
                        const request = this.pending.get(frame.id);
                        if (!request)
                            return;
                        this.pending.delete(frame.id);
                        clearTimeout(request.timer);
                        request.cleanup();
                        request.resolve(new Response(JSON.stringify(frame.body), { status: frame.status ?? 200, headers: { 'Content-Type': 'application/json' } }));
                    }
                    else if (frame.type === 'changed') {
                        for (const watcher of this.watchers)
                            watcher();
                    }
                    else if (frame.type === 'event' && frame.event) {
                        const event = frame.event, stream = this.streams.get(event.runId);
                        if (stream && (event.type === 'resync' || (event.seq ?? 0) > stream.after)) {
                            stream.after = event.seq ?? 0;
                            stream.onEvent(event);
                        }
                    }
                }
                catch {
                    socket.close(1003);
                }
            };
            socket.onerror = () => { clearTimeout(timer); reject(new Error('CHAT_UNAVAILABLE')); };
            socket.onclose = () => {
                clearTimeout(timer);
                clearInterval(this.heartbeat);
                this.connecting = undefined;
                if (this.socket === socket)
                    this.socket = undefined;
                reject(new Error('CHAT_DISCONNECTED'));
                for (const item of this.pending.values()) {
                    clearTimeout(item.timer);
                    item.cleanup();
                    item.reject(new Error('CHAT_DISCONNECTED'));
                }
                this.pending.clear();
                for (const stream of this.streams.values())
                    stream.onError();
                if (this.watchers.size || this.streams.size) {
                    clearTimeout(this.retry);
                    this.retry = setTimeout(() => { void this.connect().catch(() => { }); }, this.delay);
                    this.delay = Math.min(this.delay * 2, 10000);
                }
            };
        }).finally(() => { this.connecting = undefined; });
        return this.connecting;
    }
    async request(path: string, init: RequestInit = {}): Promise<Response> {
        if (init.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        const socket = await this.connect();
        if (init.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        if (this.pending.size >= 32)
            throw new Error('CHAT_QUEUE_FULL');
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const cleanup = () => init.signal?.removeEventListener('abort', abort);
            const abort = () => { const item = this.pending.get(id); if (item)
                clearTimeout(item.timer); this.pending.delete(id); cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
            const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error('CHAT_REQUEST_TIMEOUT')); }, 10000);
            this.pending.set(id, { resolve, reject, timer, cleanup });
            init.signal?.addEventListener('abort', abort, { once: true });
            socket.send(JSON.stringify({ type: 'request', id, path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) }));
        });
    }
    changes(watcher: () => void): () => void { this.watchers.add(watcher); void this.connect().catch(() => { }); return () => { this.watchers.delete(watcher); }; }
    subscribe(runId: string, after: number, onEvent: (event: WebRunEvent) => void, onError: () => void): () => void {
        this.streams.set(runId, { after, onEvent, onError });
        const open = this.socket?.readyState === 1;
        void this.connect().then(socket => { if (open && this.streams.has(runId))
            socket.send(JSON.stringify({ type: 'subscribe', runId, after })); }).catch(onError);
        return () => { this.streams.delete(runId); if (this.socket?.readyState === 1)
            this.socket.send(JSON.stringify({ type: 'unsubscribe', runId })); };
    }
    close(): void { this.watchers.clear(); this.streams.clear(); clearTimeout(this.retry); clearInterval(this.heartbeat); this.socket?.close(); }
}
