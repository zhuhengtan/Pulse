export interface NativeBrowserState { id: string; tabs: { revision: string; items: Array<{ index: number; title: string; url: string; active: boolean }> }; error?: string }
import type { PulseWebTransport, WebRunEvent, WebMessage } from './transport.js';
interface DesktopBridge {
    installation?: boolean;
    nativeBrowser?: boolean;
    browserLayout?(id: string, bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>;
    browserDispose?(id: string): Promise<void>;
    browserState?(id: string): Promise<NativeBrowserState | undefined>;
    browserEvents?(listener: (value: NativeBrowserState) => void): () => void;
    request(path: string, init?: {
        method?: string;
        body?: string;
    }): Promise<{
        status: number;
        body?: unknown;
        bytes?: Uint8Array;
        headers?: Record<string, string>;
    }>;
    openSocket?(id: string, path: string): Promise<void>;
    sendSocket?(id: string, value: string): Promise<void>;
    closeSocket?(id: string): Promise<void>;
    sockets?(listener: (value: {
        id: string;
        type: string;
        data?: string;
    }) => void): () => void;
    connections?(listener: (connected: boolean) => void): () => void;
    changes(listener: () => void): () => void;
    subscribe(kind: 'chat' | 'work', runId: string, after: number): Promise<string>;
    unsubscribe(id: string): Promise<void>;
    events(listener: (value: {
        id: string;
        event: WebRunEvent;
    }) => void): () => void;
}
declare global {
    interface Window {
        pulseDesktop?: DesktopBridge;
    }
}
export function createDesktopTransport(bridge: DesktopBridge): PulseWebTransport {
    const request: PulseWebTransport['request'] = async (path, init = {}) => {
        if (init.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        const result = await bridge.request(path, { ...(init.method ? { method: init.method } : {}), ...(typeof init.body === 'string' ? { body: init.body } : {}) });
        if (init.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        return new Response(result.bytes ? new Uint8Array(result.bytes).buffer : JSON.stringify(result.body), { status: result.status, headers: result.headers ?? { 'Content-Type': 'application/json' } });
    };
    const stream = (kind: 'chat' | 'work', runId: string, after: number, onEvent: (event: WebRunEvent) => void, onError: () => void) => {
        let id: string | undefined, closed = false;
        const buffered: Array<{
            id: string;
            event: WebRunEvent;
        }> = [];
        const off = bridge.events(value => { if (!id) {
            if (buffered.length < 1000)
                buffered.push(value);
            return;
        } if (!closed && value.id === id)
            onEvent(value.event); });
        void bridge.subscribe(kind, runId, after).then(value => { id = value; if (closed)
            void bridge.unsubscribe(id);
        else
            for (const item of buffered)
                if (item.id === id)
                    onEvent(item.event); buffered.length = 0; }).catch(onError);
        return () => { closed = true; off(); if (id)
            void bridge.unsubscribe(id); };
    };
    return { request, ...(bridge.connections ? { onConnection: (listener: (connected: boolean) => void) => bridge.connections!(listener) } : {}), onChange: listener => bridge.changes(listener), messages: async (id, before, signal) => {
            const response = await request(`/api/data/conversations/${encodeURIComponent(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`, signal ? { signal } : {});
            if (!response.ok)
                throw new Error('LOCAL_MESSAGES_UNAVAILABLE');
            return response.json() as Promise<{
                items: WebMessage[];
                before?: string;
                revision: number;
            }>;
        }, subscribeChat: (id, after, onEvent, onError) => stream('chat', id, after, onEvent, onError), subscribe: (path, onEvent, onError) => {
            const url = new URL(path, 'http://pulse.local'), match = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
            if (!match) {
                onError();
                return () => { };
            }
            return stream('work', decodeURIComponent(match[1]!), Number(url.searchParams.get('after') ?? 0), onEvent, onError);
        } };
}
