'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useAuth } from './AuthContext';
import {
  Message as UIMessage,
  ChatContextType,
  SourceItem,
} from '@/lib/chat-types';

/** ------------------------------------------------------------------
 *  Chunk parsing
 * ------------------------------------------------------------------*/

// export interface SourceItem { // Moved to chat-types.ts
//   id: string;
//   title: string;
//   source: string;
//   url?: string;
//   relevanceScore: number;
// }

export type ChatMessageChunk =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'sources'; sources: SourceItem[] }
  | { type: 'error'; content: string }
  | { type: 'unknown'; content: string };

/** Detectors map raw server‑sent events → structured chunks. */
const detectors: ((raw: string, parsed: unknown) => ChatMessageChunk | null)[] = [
  // LangGraph “messages” node ➜ assistant content
  (_, p) => {
    if (
      Array.isArray(p) &&
      p[0] === 'messages' &&
      Array.isArray(p[1]) &&
      p[1][0]?.kwargs?.content
    ) {
      return { type: 'content', content: p[1][0].kwargs.content as string };
    }
    return null;
  },
  // LangGraph “updates” node ➜ chain reasoning
  (_, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const node = p[1] as Record<string, unknown>; // Changed any to unknown
      const first = node?.[Object.keys(node)[0]] as { reasoning?: string | string[] } | undefined; // Added type assertion for first
      const reasoning: string | string[] | undefined = first?.reasoning;
      if (typeof reasoning === 'string' && reasoning.trim())
        return { type: 'thinking', content: reasoning };
      if (Array.isArray(reasoning) && reasoning.length)
        return { type: 'thinking', content: reasoning.at(-1)! };
    }
    return null;
  },
  // LangGraph “retrieve” updates ➜ sources
  (_, p) => {
    // Re-using/defining a similar structure to UpdateRetrievePayload for clarity here
    interface RetrievalPayload {
      retrieve?: {
        retrievals?: Array<{
          chunks?: Array<Record<string, unknown>>;
          // Add other potential properties of retrieval item if necessary
        }>;
      };
    }

    if (
      Array.isArray(p) &&
      p.length > 1 && // ensure p[1] exists
      p[0] === 'updates' &&
      (p[1] as RetrievalPayload)?.retrieve?.retrievals
    ) {
      const updatePayload = p[1] as RetrievalPayload;
      // Ensure retrievals is an array before proceeding
      const retrievals = Array.isArray(updatePayload.retrieve?.retrievals) ? updatePayload.retrieve.retrievals : [];
      const sources: SourceItem[] = [];
      retrievals.forEach(r => {
        // Ensure r.chunks is an array before forEach
        const chunksArray = Array.isArray(r.chunks) ? r.chunks : [];
        chunksArray.forEach((c: Record<string, unknown>) => // c is Record<string, unknown>
          sources.push({
            id: (c.id as string) ?? uuidv4(),
            title: (c.title as string) ?? (c.id as string) ?? 'Untitled',
            source:
              (c.source as string) ?? ((c.metadata as Record<string, unknown>)?.source as string) ?? 'N/A',
            url: (c.url as string | undefined) ?? ((c.metadata as { url?: string })?.url),
            relevanceScore: (c.relevanceScore as number) ?? (c.score as number) ?? 0,
          }),
        );
      });
      return sources.length ? { type: 'sources', sources } : null;
    }
    return null;
  },
  // Plain string JSON
  (_, p) => {
    if (typeof p === 'string') return { type: 'content', content: p };
    if (
      p &&
      typeof p === 'object' &&
      'content' in p &&
      typeof (p as { content: unknown }).content === 'string' && // Check if content is string
      Object.keys(p).length === 1
    ) {
      return { type: 'content', content: (p as { content: string }).content }; // Cast to { content: string }
    }
    return null;
  },
];

/** Parse any server line into a `ChatMessageChunk`. */
function detectChunk(data: string): ChatMessageChunk {
  try {
    const parsed = JSON.parse(data);
    for (const det of detectors) {
      const out = det(data, parsed);
      if (out) return out;
    }
    return { type: 'unknown', content: `Unknown JSON: ${data.slice(0, 80)}…` };
  } catch {
    if (/error/i.test(data)) return { type: 'error', content: data };
    return { type: 'content', content: data };
  }
}

/** ------------------------------------------------------------------
 *  React context
 * ------------------------------------------------------------------*/

const ChatContext = createContext<ChatContextType | null>(null);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantId = useRef<string | null>(null);

  const { token } = useAuth();

  /** ----------------------------------------------------------------
   *  WebSocket helpers
   * ----------------------------------------------------------------*/
  const closeWs = () => {
    wsRef.current?.close(1000, 'reset');
    wsRef.current = null;
  };

  const openWs = () => {
    const url = (process.env.NEXT_PUBLIC_API_BASE_URL || '')
      .replace(/^http/, 'ws')
      .concat('/chat/ws');
    const ws = new WebSocket(url);
    wsRef.current = ws;
    return ws;
  };

  /** Send conversation + new user prompt to backend. */
  const sendToBackend = useCallback(
    async (history: UIMessage[], text: string): Promise<void> => {
      if (!token) {
        setMessages(m => [
          ...m,
          {
            id: uuidv4(),
            text: 'Authentication error – cannot connect.',
            sender: 'assistant',
            timestamp: new Date(),
          },
        ]);
        return;
      }

      closeWs();

      // create stub assistant message so UI can stream
      const assistantId = uuidv4();
      currentAssistantId.current = assistantId;
      setMessages(m => [
        ...m,
        { id: assistantId, text: '', sender: 'assistant', timestamp: new Date() },
      ]);

      const ws = openWs();

      ws.onopen = () => {
        const payload = {
          messages: [...history, { role: 'user' as const, content: text }].map(
            msg => {
              if ('sender' in msg) {
                // This is a UIMessage
                return { role: msg.sender, content: msg.text };
              } else {
                // This is the new { role: 'user', content: text } message
                return { role: msg.role, content: msg.content };
              }
            },
          ),
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1_000,
            temperature: 0.7,
          },
          stream: true,
          auth: { token },
        };
        ws.send(JSON.stringify(payload));
        setIsLoading(true);
      };

      ws.onmessage = e => {
        const chunk = detectChunk(e.data as string);
        switch (chunk.type) {
          case 'content':
            setMessages(m =>
              m.map(msg =>
                msg.id === currentAssistantId.current
                  ? { ...msg, text: msg.text + chunk.content }
                  : msg,
              ),
            );
            break;
          case 'sources':
            setMessages(m =>
              m.map(msg =>
                msg.id === currentAssistantId.current
                  ? { ...msg, sources: chunk.sources }
                  : msg,
              ),
            );
            break;
          case 'thinking':
          case 'unknown':
            // ignore for now; hook UI later if desired
            break;
          case 'error':
            setMessages(m =>
              m.map(msg =>
                msg.id === currentAssistantId.current
                  ? {
                    ...msg,
                    text: msg.text + `\n[Server error] ${chunk.content}`,
                  }
                  : msg,
              ),
            );
            break;
        }
      };

      ws.onerror = err => {
        console.error('WebSocket error', err);
        setMessages(m =>
          m.map(msg =>
            msg.id === currentAssistantId.current
              ? { ...msg, text: msg.text + '\n[Connection error]' }
              : msg,
          ),
        );
        setIsLoading(false);
      };

      ws.onclose = () => {
        setIsLoading(false);
        currentAssistantId.current = null;
      };
    },
    [token],
  );

  /** Public helper – add a new user message. */
  const addMessage = useCallback(
    async (text: string): Promise<void> => {
      const userMsg: UIMessage = {
        id: uuidv4(),
        text,
        sender: 'user',
        timestamp: new Date(),
      };
      setMessages(m => [...m, userMsg]);
      sendToBackend(messages, text);
    },
    [sendToBackend, messages],
  );

  /** Clean up on unmount. */
  useEffect(() => () => closeWs(), []);

  return (
    <ChatContext.Provider value={{ messages, addMessage, isLoading }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be inside <ChatProvider>');
  return ctx;
};
