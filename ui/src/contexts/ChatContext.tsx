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
  ParsedMessage,
  ChatContextType,
  UserMessage,
  AssistantErrorMessage,
  AssistantContentMessage,
  AssistantThinkingMessage,
  MessageSender,
  // SourceItem, // Keep if used directly for constructing initial messages
} from '@/lib/chat-types';
import { messageProcessingService } from '@/lib/message-parser';

/**
 * @fileoverview Provides chat context for managing chat messages,
 * WebSocket communication, loading states, errors, and message parsing.
 */

/**
 * React Context for chat state and actions.
 */
const ChatContext = createContext<ChatContextType | null>(null);

/**
 * `ChatProvider` manages the chat state, including messages, WebSocket connection,
 * loading status, and errors. It provides these states and actions to child components
 * via the `ChatContext`.
 *
 * @param props - The props for the component.
 * @param props.children - The child components that will consume the context.
 * @example
 * ```tsx
 * // In a parent component (e.g., layout or page)
 * import { ChatProvider } from '@/contexts/ChatContext';
 * import ChatInterface from '@/components/chat/ChatInterface'; // Example component using useChat
 *
 * function ChatPage() {
 *   return (
 *     <ChatProvider>
 *       <ChatInterface />
 *     </ChatProvider>
 *   );
 * }
 * ```
 */
export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AssistantErrorMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null); // Tracks the ID of the assistant message being streamed/updated

  const { user, token } = useAuth(); // Get user authentication status and token

  /**
   * Closes the WebSocket connection if it's currently open.
   */
  const closeWs = useCallback(() => {
    if (wsRef.current) {
      console.log('[ChatContext] Closing WebSocket connection.');
      wsRef.current.close(1000, 'Client requested connection close');
      wsRef.current = null;
    }
  }, []);

  /**
   * Opens a new WebSocket connection to the chat backend.
   * Includes the authentication token as a query parameter.
   * @returns The newly created WebSocket instance, or null if no token is available.
   */
  const openWs = useCallback(() => {
    if (!token) {
      console.error('[ChatContext] No authentication token available. Cannot open WebSocket.');
      // Optionally, set an error state here or let sendToBackend handle it.
      return null;
    }

    // Determine WebSocket URL based on environment or window location
    const wsBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin).replace(
      /^http/,
      'ws',
    );
    // Append the token as a query parameter for WebSocket authentication
    const wsUrl = `${wsBaseUrl}/chat/ws?token=${encodeURIComponent(token)}`;

    console.log(`[ChatContext] Opening WebSocket connection to: ${wsUrl.replace(token, '[REDACTED_TOKEN]')}`); // Avoid logging token
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    return ws;
  }, [token]); // Add token as a dependency

  /**
   * Clears all messages, errors, and closes the WebSocket connection.
   */
  const clearChat = useCallback(() => {
    setMessages([]);
    setError(null);
    closeWs();
    console.log('[ChatContext] Chat cleared.');
  }, [closeWs]);

  /**
   * Sends the chat history and the new user message to the backend via WebSocket.
   * Handles WebSocket connection opening, message sending, and receiving streamed responses.
   * Updates message state based on received data (thinking, content, sources, errors).
   *
   * @param history - The current list of parsed messages (excluding the new user message).
   * @param newUserMessage - The new message object sent by the user.
   */
  const sendToBackend = useCallback(
    async (history: ParsedMessage[], newUserMessage: UserMessage): Promise<void> => {
      if (!user || !token) {
        const errorMsg = !user ? 'User not authenticated.' : 'Authentication token not available.';
        console.error(`[ChatContext] ${errorMsg} Cannot send message.`);
        const authError: AssistantErrorMessage = {
          id: uuidv4(),
          sender: 'system', type: 'error', timestamp: new Date(),
          error: { message: `Authentication error: ${errorMsg}`, code: 'AUTH_REQUIRED' },
          text: `Authentication error: ${errorMsg}`,
        };
        setMessages(prev => [...prev, authError]);
        setIsLoading(false);
        return;
      }

      closeWs(); // Ensure any previous connection is closed before starting anew

      const assistantMessagePlaceholderId = uuidv4();
      currentAssistantMessageIdRef.current = assistantMessagePlaceholderId;

      // Add a 'thinking' placeholder for immediate feedback
      const thinkingPlaceholder: AssistantThinkingMessage = {
        id: assistantMessagePlaceholderId, sender: 'assistant', type: 'thinking',
        timestamp: new Date(), text: 'Assistant is thinking...',
      };
      setMessages(prev => [...prev, thinkingPlaceholder]);
      setIsLoading(true);
      setError(null);

      const ws = openWs(); // Establish new WebSocket connection (now includes token)

      if (!ws) {
        console.error('[ChatContext] Failed to open WebSocket connection (likely due to missing token).');
        const wsOpenError: AssistantErrorMessage = {
          id: assistantMessagePlaceholderId, // Use placeholder ID to replace 'thinking'
          sender: 'system', type: 'error', timestamp: new Date(),
          error: { message: 'Failed to establish secure connection with chat server.', code: 'WS_OPEN_FAILED' },
          text: 'Failed to establish secure connection with chat server.',
        };
        setMessages(prev => {
            const thinkingIndex = prev.findIndex(m => m.id === assistantMessagePlaceholderId);
            if (thinkingIndex !== -1) {
                const updated = [...prev];
                updated[thinkingIndex] = wsOpenError;
                return updated;
            }
            return [...prev, wsOpenError];
        });
        setError(wsOpenError);
        setIsLoading(false);
        return;
      }

      ws.onopen = () => {
        console.log('[ChatContext] WebSocket connection opened.');
        // Prepare message history for the backend (user and assistant content only)
        const backendMessages = history
          .map(msg => {
            if (msg.sender === 'user') return { role: 'user', content: msg.text };
            if (msg.sender === 'assistant' && msg.type === 'content') return { role: 'assistant', content: msg.text };
            return null;
          })
          .filter(Boolean);

        // Construct payload for the backend
        const payload = {
          messages: backendMessages,
          options: { /* Backend options */ },
          stream: true,
        };
        console.log('[ChatContext] Sending payload (truncated):', JSON.stringify(payload).substring(0, 300) + "...");
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = e => {
        const rawData = e.data as string;
        const parsedMessage = messageProcessingService.parseMessage(rawData, currentAssistantMessageIdRef.current || undefined);

        if (parsedMessage) {
          setMessages(prevMessages => {
            const existingMsgIndex = prevMessages.findIndex(m => m.id === parsedMessage.id);

            if (existingMsgIndex !== -1) {
              // Update existing message (streaming content, replacing thinking, etc.)
              const existingMsg = prevMessages[existingMsgIndex];
              const updatedMessages = [...prevMessages];

              if (existingMsg.sender === 'assistant' && parsedMessage.sender === 'assistant') {
                if (existingMsg.type === 'content' && parsedMessage.type === 'content') {
                  // Append streamed content
                  updatedMessages[existingMsgIndex] = {
                    ...parsedMessage,
                    text: existingMsg.text + parsedMessage.text,
                  } as AssistantContentMessage;
                } else if (existingMsg.type === 'thinking' && (parsedMessage.type === 'content' || parsedMessage.type === 'sources' || parsedMessage.type === 'error')) {
                  // Replace 'thinking' with the first actual response part
                  updatedMessages[existingMsgIndex] = parsedMessage;
                } else {
                  // Replace with other message types (e.g., sources after content)
                  updatedMessages[existingMsgIndex] = parsedMessage;
                }
              } else {
                // Fallback: Replace if senders/types don't match expected streaming patterns
                console.warn('[ChatContext] Unexpected message update scenario, replacing:', existingMsg, parsedMessage);
                updatedMessages[existingMsgIndex] = parsedMessage;
              }
              return updatedMessages;
            } else {
              // Add as a new message if ID doesn't exist
              return [...prevMessages, parsedMessage];
            }
          });

          // Update global error state if an error message is received
          if ('type' in parsedMessage && parsedMessage.type === 'error' && (parsedMessage.sender === 'assistant' || parsedMessage.sender === 'system')) {
            setError(parsedMessage as AssistantErrorMessage);
          } else if (error?.id === parsedMessage.id && (!('type' in parsedMessage) || parsedMessage.type !== 'error')) {
            // Clear global error if a non-error message updates the one that caused the error
            setError(null);
          }
        } else {
          console.warn('[ChatContext] Failed to parse message or null returned by service:', rawData);
        }
      };

      ws.onerror = err => {
        const errorMessageText = err instanceof Error ? err.message : String((err as Event).type || 'WebSocket connection error');
        console.error('[ChatContext] WebSocket error:', errorMessageText, err);
        const connError: AssistantErrorMessage = {
          id: currentAssistantMessageIdRef.current || uuidv4(), // Use current ID or new one
          sender: 'system', type: 'error', timestamp: new Date(),
          error: { message: `WebSocket connection error: ${errorMessageText}`, code: 'WS_CONNECTION_ERROR' },
          text: `Connection error: ${errorMessageText}`,
        };
        // Update or add the error message in the list
        setMessages(prev => {
            const existingIndex = prev.findIndex(m => m.id === connError.id);
            if (existingIndex !== -1) {
                const updated = [...prev];
                updated[existingIndex] = connError; // Replace thinking/content with error
                return updated;
            }
            return [...prev, connError]; // Add if no existing message with ID
        });
        setError(connError); // Set global error state
        setIsLoading(false);
      };

      ws.onclose = (event) => {
        console.log(`[ChatContext] WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
        setIsLoading(false); // Stop loading indicator when connection closes
        // Resetting currentAssistantMessageIdRef here might be premature if an error needs to update the last message.
        // It's reset when the next message is sent via sendToBackend.
      };
    },
    [user, token, closeWs, openWs], // Dependencies for the sendToBackend callback
  );

  /**
   * Adds a message to the chat state and triggers sending it to the backend if it's a user message.
   * Can also be used to add system or initial assistant messages directly to the state.
   *
   * @param text - The content of the message.
   * @param sender - The sender of the message ('user', 'assistant', 'system'). Defaults to 'user'.
   */
  const addMessage = useCallback(
    async (text: string, sender: MessageSender = 'user'): Promise<void> => {
      if (sender === 'user') {
        if (!user || !token) { // Double-check auth before adding user message
          console.error('[ChatContext] Cannot add user message: User not authenticated or token missing.');
          // Optionally, show an error message to the user via setError or a toast
          const authError: AssistantErrorMessage = {
            id: uuidv4(), sender: 'system', type: 'error', timestamp: new Date(),
            error: { message: 'Authentication required to send messages.', code: 'AUTH_REQUIRED_SEND' },
            text: 'Authentication required to send messages.',
          };
          setMessages(prev => [...prev, authError]);
          setError(authError);
          return;
        }
        const userMsg: UserMessage = {
          id: uuidv4(), text, sender: 'user', timestamp: new Date(),
        };
        // Add user message optimistically *before* calling sendToBackend
        const currentMessages = [...messages, userMsg];
        setMessages(currentMessages);
        // Pass the history *including* the new user message to sendToBackend
        sendToBackend(currentMessages, userMsg);
      } else {
        // Handle adding non-user messages (e.g., initial system prompts) directly
        const rawMsg = {
            id: uuidv4(), text, sender, timestamp: new Date(),
            // Assign a type if it's an assistant message added manually
            type: sender === 'assistant' ? 'content' : undefined
        };
        const parsed = messageProcessingService.parseMessage(rawMsg);
        if (parsed) {
            setMessages(m => [...m, parsed]);
        } else {
            console.error("[ChatContext] Failed to parse manually added message:", rawMsg);
        }
      }
    },
    [sendToBackend, messages, user, token], // Include 'messages', 'user', and 'token'
  );

  /** Effect hook to ensure WebSocket connection is closed on component unmount. */
  useEffect(() => {
    return () => {
      closeWs();
    };
  }, [closeWs]);

  return (
    <ChatContext.Provider value={{ messages, addMessage, isLoading, error, clearChat }}>
      {children}
    </ChatContext.Provider>
  );
};

/**
 * Custom hook `useChat` provides an easy way to access the chat context values.
 *
 * @returns The chat context containing `messages`, `addMessage`, `isLoading`, `error`, and `clearChat`.
 * @throws Throws an error if used outside of a `ChatProvider` tree.
 * @example
 * ```tsx
 * import { useChat } from '@/contexts/ChatContext';
 *
 * function ChatInput() {
 *   const { addMessage, isLoading } = useChat();
 *   const [input, setInput] = useState('');
 *
 *   const handleSubmit = (e) => {
 *     e.preventDefault();
 *     if (input.trim() && !isLoading) {
 *       addMessage(input);
 *       setInput('');
 *     }
 *   };
 *
 *   return <form onSubmit={handleSubmit}>...</form>;
 * }
 * ```
 */
export const useChat = (): ChatContextType => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
