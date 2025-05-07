'use client';

import React, { createContext, useContext, useState, ReactNode, useCallback, useRef, useEffect } from 'react';
import { Message as UIMessage, ChatContextType } from '@/lib/chat-types'; // Renamed to UIMessage to avoid conflict
import { v4 as uuidv4 } from 'uuid';
import { useAuth } from './AuthContext';

// --- ChatMessageChunk and detection logic adapted from packages/cli/src/utils/api.ts ---
export type ChatMessageChunk =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'sources';
      node: {
        sources: Array<{
          id: string;
          title: string;
          source: string;
          url?: string;
          relevanceScore: number;
          // Add other fields if present in actual data, e.g., 'content' for chunk content
        }>;
      };
    }
  | { type: 'error'; content: string } // Added error type
  | { type: 'unknown'; content: string };

interface ChunkDetector {
  (raw: string, parsed: any): ChatMessageChunk | null;
}

const detectors: ChunkDetector[] = [
  // LangGraph messages node - content chunks
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'messages' && Array.isArray(p[1]) && p[1].length > 0 && p[1][0].kwargs?.content) {
      return { type: 'content', content: p[1][0].kwargs.content };
    }
    return null;
  },
  // LangGraph updates - thinking (simplified)
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates') {
      const nodeUpdate = p[1];
      if (typeof nodeUpdate === 'object' && nodeUpdate !== null) {
        const firstKey = Object.keys(nodeUpdate)[0];
        const nodeContent = nodeUpdate[firstKey];
        if (nodeContent && typeof nodeContent.reasoning === 'string' && nodeContent.reasoning.trim() !== '') {
          return { type: 'thinking', content: nodeContent.reasoning };
        }
        if (nodeContent && Array.isArray(nodeContent.reasoning) && nodeContent.reasoning.length > 0) {
          return { type: 'thinking', content: nodeContent.reasoning[nodeContent.reasoning.length - 1] };
        }
      }
    }
    return null;
  },
  // LangGraph updates - sources (adapted for observed structure: ["updates",{"retrieve":{...}}])
  (raw, p) => {
    if (Array.isArray(p) && p[0] === 'updates' && p[1]?.retrieve?.retrievals) {
        const retrievals = p[1].retrieve.retrievals;
        if (Array.isArray(retrievals)) {
            const allChunksAsSources: ChatMessageChunk['node']['sources'] = [];
            retrievals.forEach(retrieval => {
                if (retrieval.chunks && Array.isArray(retrieval.chunks)) {
                    retrieval.chunks.forEach((chunk: any) => {
                        allChunksAsSources.push({
                            id: chunk.id || uuidv4(),
                            title: chunk.title || chunk.id || 'Unknown Source',
                            source: chunk.source || chunk.metadata?.source || 'N/A',
                            url: chunk.url || chunk.metadata?.url,
                            relevanceScore: chunk.relevanceScore || chunk.score || 0,
                            // content: chunk.content // Optionally include chunk content
                        });
                    });
                }
            });
            if (allChunksAsSources.length > 0) {
                return { type: 'sources', node: { sources: allChunksAsSources } };
            }
        }
    }
    return null;
  },
  // Plain content string (if server sends simple string for content)
  (raw, p) => {
    if (typeof p === 'string') { // If parsed is just a string
        return { type: 'content', content: p };
    }
    if (p && typeof p.content === 'string' && Object.keys(p).length === 1) { // { content: "..." }
        return { type: 'content', content: p.content };
    }
    return null;
  }
];

const detectChunk = (data: string): ChatMessageChunk => {
  try {
    const parsed = JSON.parse(data);
    for (const det of detectors) {
      const match = det(data, parsed);
      if (match) return match;
    }
    // If no detector matches, but it's valid JSON, treat as unknown structured data
    return { type: 'unknown', content: `Unknown JSON structure: ${data.substring(0,100)}...` };
  } catch {
    // Not JSON, treat as plain text, potentially an error or simple content
    if (data.toLowerCase().includes("error")) {
        return { type: 'error', content: data };
    }
    return { type: 'content', content: data }; // Default to content if not JSON and not error-like
  }
};
// --- End of adapted CLI logic ---

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const { token } = useAuth();
  const currentAssistantMessageIdRef = useRef<string | null>(null);

  const connectAndSendMessage = useCallback((messageHistory: UIMessage[], userMessageText: string) => {
    if (!token) {
      console.error('[ChatContext] No auth token available for WebSocket.');
      setMessages(prev => [...prev, { id: uuidv4(), text: "Authentication error. Cannot connect.", sender: 'assistant', timestamp: new Date() }]);
      setIsLoading(false);
      return;
    }

    const wsUrl = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/^http/, 'ws') + '/chat/ws';
    console.log('[ChatContext] Attempting WebSocket connection to:', wsUrl);
    console.log('[ChatContext] Using auth token:', token ? `${token.substring(0, 15)}...` : 'null');

    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      console.log('[ChatContext] Closing existing WebSocket due to new message.');
      wsRef.current.close(1000, "Starting new message exchange");
    }
    
    // Create a new assistant message placeholder
    const assistantMessageId = uuidv4();
    currentAssistantMessageIdRef.current = assistantMessageId;
    setMessages(prev => [...prev, { id: assistantMessageId, text: '', sender: 'assistant', timestamp: new Date() }]);

    const newWs = new WebSocket(wsUrl);
    wsRef.current = newWs; // Assign immediately

    newWs.onopen = () => {
      console.log('[ChatContext] WebSocket connected.');
      setIsLoading(true); // Ensure loading is true when connection opens

      const historyForApi = messageHistory.map(m => ({
        role: m.sender,
        content: m.text,
      }));
      historyForApi.push({ role: 'user', content: userMessageText });

      const initialMessagePayload = {
        messages: historyForApi,
        options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000, temperature: 0.7 },
        stream: true,
        token: token,
        auth: { token: token },
      };
      console.log('[ChatContext] Sending initial payload:', JSON.stringify(initialMessagePayload, null, 2).substring(0, 300) + "...");
      newWs.send(JSON.stringify(initialMessagePayload));
    };

    newWs.onmessage = (event) => {
      const rawData = event.data as string;
      console.log('[ChatContext] Raw message received:', rawData.substring(0,300));
      const chunk = detectChunk(rawData);
      console.log('[ChatContext] Detected chunk:', chunk);

      if (chunk.type === 'content') {
        setMessages(prev => prev.map(msg =>
            msg.id === currentAssistantMessageIdRef.current ? { ...msg, text: msg.text + chunk.content } : msg
        ));
      } else if (chunk.type === 'thinking') {
        console.log('[ChatContext] Assistant thinking:', chunk.content);
        // Optionally, update UI to show thinking state
      } else if (chunk.type === 'sources') {
        console.log('[ChatContext] Received sources:', chunk.node.sources);
        // Optionally, append sources to the message or display them
        const sourcesText = chunk.node.sources.map((s, i) => `\n[Source ${i+1}: ${s.title || s.id}](${s.url || ''})`).join('');
        setMessages(prev => prev.map(msg =>
            msg.id === currentAssistantMessageIdRef.current ? { ...msg, text: msg.text + sourcesText } : msg
        ));
      } else if (chunk.type === 'error') {
        console.error('[ChatContext] Received error chunk from server:', chunk.content);
        setMessages(prev => prev.map(msg =>
            msg.id === currentAssistantMessageIdRef.current ? { ...msg, text: msg.text + `\n[Server Error: ${chunk.content}]` } : msg
        ));
      } else if (chunk.type === 'unknown') {
        console.warn('[ChatContext] Received unknown chunk:', chunk.content);
      }
    };

    newWs.onerror = (error) => {
      console.error('[ChatContext] WebSocket error:', error);
      if (wsRef.current === newWs) { // Only update if it's the current WebSocket erroring
        setMessages(prev => prev.map(msg =>
          msg.id === currentAssistantMessageIdRef.current ? { ...msg, text: msg.text + "\n[Chat connection error]" } : msg
        ));
        setIsLoading(false);
        currentAssistantMessageIdRef.current = null;
      }
    };

    newWs.onclose = (event) => {
      console.log(`[ChatContext] WebSocket disconnected. Code: ${event.code}, Reason: ${event.reason}`);
      if (wsRef.current === newWs) { // Only act if it's the current WebSocket closing
        setIsLoading(false);
        currentAssistantMessageIdRef.current = null;
        wsRef.current = null; // Clear the ref if this instance is closed
      }
    };
  }, [token, messages]); // Added messages to dependency array of connectAndSendMessage

  const addMessage = useCallback(async (text: string) => {
    const userMessage: UIMessage = {
      id: uuidv4(),
      text,
      sender: 'user',
      timestamp: new Date(),
    };
    
    // Important: Get history *before* adding the new user message to the state
    // This ensures `connectAndSendMessage` gets the correct history for the API call
    const currentMessageHistory = messages; 
    
    setMessages(prevMessages => [...prevMessages, userMessage]);
    setIsLoading(true); // Set loading true when user sends a message
    
    connectAndSendMessage(currentMessageHistory, text);

  }, [connectAndSendMessage, messages]); // `messages` is needed here to get current history

  useEffect(() => {
    // Cleanup WebSocket on component unmount
    return () => {
      if (wsRef.current) {
        console.log('[ChatContext] Cleaning up WebSocket on unmount.');
        wsRef.current.close(1000, "Component unmounting");
        wsRef.current = null;
      }
    };
  }, []);

  return (
    <ChatContext.Provider value={{ messages, addMessage, isLoading }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};