import type { WebMessage } from './transport.js';
export interface CachedConversation {
    messages: WebMessage[];
    before?: string;
    scrollTop?: number;
    atBottom?: boolean;
}
/** Bounded history cache. Drafts live separately and are never evicted here. */
export class ConversationCache {
    private entries = new Map<string, CachedConversation>();
    get(id: string): CachedConversation | undefined { const value = this.entries.get(id); if (value) {
        this.entries.delete(id);
        this.entries.set(id, value);
    } return value; }
    set(id: string, value: CachedConversation): void { this.entries.delete(id); this.entries.set(id, { ...value, messages: value.messages.slice(-200) }); let bytes = 0; for (const [key, item] of [...this.entries].reverse()) {
        bytes += JSON.stringify(item).length * 2;
        if (bytes > 20 * 1024 * 1024 || this.entries.size > 10)
            this.entries.delete(key);
    } }
}
