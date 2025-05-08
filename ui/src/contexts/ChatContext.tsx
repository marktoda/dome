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
 *  Chunk parsing (aligned with CLI)
 * ------------------------------------------------------------------*/

// CLI's ChatMessageChunk structure
type CliChatMessageChunk =
  | { type: 'content' | 'thinking' | 'unknown' | 'internal_update'; content: string } // Added internal_update
  | {
      type: 'sources';
      node: { // This 'node' is the value from p[1][nodeId] in the CLI detector
        sources: SourceItem | SourceItem[]; // The 'sources' property itself can be one or many
      };
    }
  | { type: 'error'; content: string }; // Added error type for completeness

// Extensible chunk‑type detector stack (from CLI: packages/cli/src/utils/api.ts)
interface ChunkDetector {
  (raw: string, parsed: any): CliChatMessageChunk | null;
}
const detectors: ChunkDetector[] = [
  // LangGraph updates - sources
  // Extracts sources if the node ID is 'doc_to_sources'.
  // The 'node' field in the returned chunk will contain the data from p[1]['doc_to_sources'].
  // This data is expected to have a 'sources' property which can be a single SourceItem or SourceItem[].
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId: string = Object.keys(p[1])[0];
      if (nodeId !== 'doc_to_sources') return null;
      const node = p[1][nodeId];
      // Ensure the node has a 'sources' property before returning
      if (node && typeof node === 'object' && 'sources' in node) {
        return { type: 'sources', node: node as { sources: SourceItem | SourceItem[] } };
      }
    }
    return null;
  },

  // LangGraph update - thinking
  // Extracts reasoning content if present in an 'updates' event.
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeId: string = Object.keys(p[1])[0];
      const node = p[1][nodeId];

      if (node && node.reasoning && Array.isArray(node.reasoning) && node.reasoning.length > 0) {
        const lastReasoning = node.reasoning[node.reasoning.length - 1];
        if (typeof lastReasoning === 'string') {
          return { type: 'thinking', content: lastReasoning };
        }
      }
    }
    return null;
  },

  // Generic LangGraph updates that are not handled specifically (e.g., 'retrieve')
  // This should come AFTER specific 'updates' handlers like 'doc_to_sources' and 'thinking' with reasoning.
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      // If it reaches here, it wasn't 'doc_to_sources' or 'thinking' with reasoning.
      // These are likely internal state updates we don't want to display as content.
      const nodeId: string = Object.keys(p[1])[0];
      // Avoid classifying 'doc_to_sources' or thinking updates if they somehow missed earlier detectors
      // or if their specific conditions (e.g., presence of 'sources' or 'reasoning' field) weren't met.
      if (nodeId === 'doc_to_sources' || (p[1][nodeId] && typeof p[1][nodeId] === 'object' && 'reasoning' in p[1][nodeId])) {
        return null; // Let other detectors or unknown handling take over.
      }
      console.debug(`[ChatContext] Detected internal update for node: ${nodeId}`);
      return { type: 'internal_update', content: raw }; // Store raw for debugging
    }
    return null;
  },

  // LangGraph messages node - content chunks
  // Specifically targets content from the 'generate_answer' node.
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'messages') {
      const details = p[1]; // details is expected to be an array of message objects
      // Check if 'details' is an array and has at least one element
      // The actual content is in details[0].kwargs.content
      // The node name check might be on a different part of the payload structure
      // For langgraph, often the event name itself or a metadata field indicates the node.
      // The CLI's `details[1].langgraph_node` was problematic.
      // Let's assume the structure is `["messages", arrayOfMessages, {name: "node_name_here"}]`
      // or the node name is part of the log path for run_log events.
      // For now, we'll check if p[2] (if it exists) has a name property.
      // This is a common pattern for 'event' type streams from LangGraph.
      let isGenerateAnswerNode = false;
      if (p.length > 2 && typeof p[2] === 'object' && p[2] !== null && 'name' in p[2]) {
        if ((p[2] as {name: string}).name === 'generate_answer') {
          isGenerateAnswerNode = true;
        }
      } else if (raw.includes('"generate_answer"')) { // Fallback: simple string check in raw data
        isGenerateAnswerNode = true;
      }


      if (isGenerateAnswerNode && Array.isArray(details) && details.length > 0 && details[0]?.kwargs?.content) {
        if (typeof details[0].kwargs.content === 'string') {
          return { type: 'content', content: details[0].kwargs.content };
        }
      }
    }
    return null;
  },

  // Handle tasks object that contains a task query (from CLI)
  (raw, p) => {
    if (typeof p === 'object' && p !== null && p.tasks && Array.isArray(p.tasks)) {
      if (p.instructions && typeof p.instructions === 'string') {
        return { type: 'thinking', content: p.instructions };
      }
      if (p.reasoning && typeof p.reasoning === 'string') {
        return { type: 'thinking', content: p.reasoning };
      }
    }
    return null;
  },
  // Basic error string detection
  (raw, p) => {
    if (typeof p === 'string' && /error/i.test(p)) {
        return { type: 'error', content: p };
    }
    if (typeof p === 'object' && p !== null && 'error' in p && typeof p.error === 'string') {
        return { type: 'error', content: p.error };
    }
    return null;
  }
];

// detectChunk function (from CLI: packages/cli/src/utils/api.ts)
const detectChunk = (data: string): CliChatMessageChunk => {
  try {
    const parsed = JSON.parse(data);
    for (const det of detectors) {
      const match = det(data, parsed);
      if (match) return match;
    }
    // If no specific detector matches, but it's a simple JSON string like {"content": "..."}
    if (typeof parsed === 'object' && parsed !== null && 'content' in parsed && typeof parsed.content === 'string' && Object.keys(parsed).length === 1) {
      return { type: 'content', content: parsed.content };
    }

  } catch {
    // If JSON.parse fails, treat as plain text content, unless it looks like an error
    if (/error/i.test(data)) return { type: 'error', content: data };
    // It might be a plain string chunk which should be treated as content
    if (data && typeof data === 'string' && data.trim() !== '') {
        return { type: 'content', content: data };
    }
  }
  // Fallback for unparsed or unhandled JSON structures
  return { type: 'unknown', content: data };
};


/** ------------------------------------------------------------------
 *  React context
 * ------------------------------------------------------------------*/

const ChatContext = createContext<ChatContextType | null>(null);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantId = useRef<string | null>(null);

  const { user } = useAuth(); // Use user object for auth status, token is HttpOnly

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
      if (!user) { // Check for user object instead of token
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
          // auth: { token }, // Token is sent via HttpOnly cookie, not in payload
        };
        ws.send(JSON.stringify(payload));
        setIsLoading(true);
      };

      ws.onmessage = e => {
        let chunk = detectChunk(e.data as string);

        // CLI's additional processing for 'unknown' chunks
        if (chunk.type === 'unknown' && chunk.content) {
          const raw = chunk.content;
          // Skip printing raw JSON for recognized LangGraph message formats
          if (
            raw.startsWith('["messages"') ||
            raw.startsWith('["updates"') ||
            raw.includes('"generatedText"') || // A common key in some LLM responses
            raw.includes('"reasoning"') // Another common key
          ) {
            console.debug('[ChatContext] Skipping internal LangGraph format:', raw.substring(0, 80) + '...');
            return; // Skip this chunk
          }
          try {
            const parsed = JSON.parse(raw); // raw is chunk.content here
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed.content === 'string') {
                chunk = { type: 'content', content: parsed.content };
              } else if (typeof parsed.message === 'string') {
                chunk = { type: 'content', content: parsed.message };
              } else if (typeof parsed.response === 'string') {
                chunk = { type: 'content', content: parsed.response };
              } else if (typeof parsed.answer === 'string') { // Common in RAG
                chunk = { type: 'content', content: parsed.answer };
              }
            }
          } catch (parseError) {
            // Not JSON or not in expected format, keep as 'unknown' or treat as plain text if it's just a string
            if (typeof raw === 'string' && raw.trim() !== '') {
                 // If it wasn't caught by detectors but is a plain string, treat as content.
                 // This handles cases where the stream might send un-JSONified string parts.
                 chunk = { type: 'content', content: raw };
            }
          }
        }


        switch (chunk.type) {
          case 'content':
            setMessages(prevMessages =>
              prevMessages.map(msg =>
                msg.id === currentAssistantId.current
                  ? { ...msg, text: msg.text + chunk.content }
                  : msg,
              ),
            );
            break;
          case 'sources':
            // Ensure chunk.node and chunk.node.sources exist
            if (chunk.node && chunk.node.sources) {
              const newSources = Array.isArray(chunk.node.sources)
                ? chunk.node.sources
                : [chunk.node.sources];
              setMessages(prevMessages =>
                prevMessages.map(msg =>
                  msg.id === currentAssistantId.current
                    ? { ...msg, sources: [...(msg.sources || []), ...newSources] } // Append sources
                    : msg,
                ),
              );
            }
            break;
          case 'thinking':
            console.log('[ChatContext] Thinking:', chunk.content);
            // Add thinking steps as messages from 'system'
            // Ensure UIMessage and rendering components can handle sender: 'system'
            const thinkingMsg: UIMessage = {
              id: uuidv4(),
              text: `${chunk.content}`, // Display thinking content directly
              sender: 'system', // Use 'system' or a dedicated 'thinking' sender type
              timestamp: new Date(),
              sources: [], // Ensure sources is initialized if UIMessage expects it
            };
            setMessages(prevMessages => [...prevMessages, thinkingMsg]);
            break;
          case 'internal_update':
            // Log for debugging, but don't show in UI or append to messages
            console.debug('[ChatContext] Internal update ignored:', chunk.content.substring(0,150) + "...");
            break;
          case 'error':
            let errorMsg = chunk.content;
            try {
              const parsedError = JSON.parse(chunk.content);
              if (parsedError && typeof parsedError.message === 'string' && parsedError.message.trim() !== '') {
                errorMsg = parsedError.message;
              } else if (parsedError && typeof parsedError.error === 'string' && parsedError.error.trim() !== '') {
                errorMsg = parsedError.error;
              }
            } catch (e) {
              // Not JSON or no specific 'message'/'error' field, use content as is
            }
            // Truncate if too long for console and UI
            const shortErrorMsg = errorMsg.length > 250 ? errorMsg.substring(0, 250) + '...' : errorMsg;
            // Log both short and full error for better debugging
            console.error('[ChatContext] Error (short):', shortErrorMsg, '\nFull error data:', chunk.content);
            setMessages(prevMessages =>
              prevMessages.map(msg =>
                msg.id === currentAssistantId.current
                  ? {
                    ...msg,
                    // Append the potentially long original error to the text if it's not too disruptive,
                    // or stick to shortErrorMsg. For now, let's use shortErrorMsg for UI.
                    text: msg.text + `\n[Server Error] ${shortErrorMsg}`,
                  }
                  : msg,
              ),
            );
            break;
          case 'unknown':
            // Only log if it wasn't converted to 'content' above
            console.log('[ChatContext] Unknown chunk:', chunk.content);
            // Potentially append to a debug view or a less prominent part of the message
            // For now, we won't append it to the main message text to keep it clean.
            break;
        }
      };

      ws.onerror = err => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Log a concise message and the full error object for details
        console.error('WebSocket error:', errorMessage, err);
        setMessages(m =>
          m.map(msg =>
            msg.id === currentAssistantId.current
              ? { ...msg, text: msg.text + `\n[Connection error: ${errorMessage}]` } // Provide more specific error
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
    [user], // Changed from token to user
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
    [sendToBackend, messages, user], // Added user to dependency array
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
