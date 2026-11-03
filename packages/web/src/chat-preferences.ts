export function readChatPreReply(): boolean { try { return localStorage.getItem('pulse-chat-pre-reply') !== 'off' } catch { return true } }
export function saveChatPreReply(enabled: boolean): void { localStorage.setItem('pulse-chat-pre-reply', enabled ? 'on' : 'off') }
