import { useState, useEffect, useCallback } from 'react';
import type { LocalHost, ConversationHandle } from '@hunterzhu/pulse-server';
import type { DisplayMessage } from '../types.js';

export function useConversation({
  host,
  conversationId,
}: {
  host: LocalHost | null;
  conversationId?: string | undefined;
}) {
  const [conversation, setConversation] = useState<ConversationHandle | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadMessages = useCallback(
    async (convId: string) => {
      if (!host) return;
      try {
        const existing = await host.getConversationMessages(convId);
        setMessages(
          existing.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            createdAt: m.createdAt,
            runId: m.runId,
          }))
        );
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [host]
  );

  useEffect(() => {
    if (!host) return;
    const currentHost = host;

    let mounted = true;
    async function setupConversation() {
      try {
        if (conversationId) {
          const conv = await currentHost.getConversation(conversationId);
          if (mounted && conv) {
            setConversation(conv);
            await loadMessages(conversationId);
          }
        } else {
          // An interactive window starts without a persisted session. The
          // first user message (or an explicit /new) creates one.
          if (mounted) {
            setConversation(null);
            setMessages([]);
          }
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      }
    }
    setupConversation();
    return () => {
      mounted = false;
    };
  }, [host, conversationId, loadMessages]);

  const addUserMessage = useCallback((text: string) => {
    const newMessage: DisplayMessage = {
      id: Date.now().toString(),
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newMessage]);
  }, []);

  const addAssistantMessage = useCallback((msg: DisplayMessage, options?: { moveToEnd?: boolean }) => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === msg.id);
      if (index >= 0) {
        if (options?.moveToEnd) return [...prev.filter((m) => m.id !== msg.id), msg];
        const next = [...prev];
        next[index] = msg;
        return next;
      }
      return [...prev, msg];
    });
  }, []);

  const clearMessages = useCallback(() => setMessages([]), []);

  const switchConversation = useCallback(
    async (id: string) => {
      if (!host) return;
      try {
        const conv = await host.getConversation(id);
        if (conv) {
          setConversation(conv);
          await loadMessages(id);
        }
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [host, loadMessages]
  );

  const createConversation = useCallback(async () => {
    if (!host) return null;
    try {
      const conv = await host.createConversation();
      setConversation(conv);
      setMessages([]);
      setError(null);
      return conv;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [host]);

  const newConversation = useCallback(async () => {
    return createConversation();
  }, [createConversation]);

  return {
    conversation,
    messages,
    error,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    switchConversation,
    newConversation,
    createConversation,
  };
}
