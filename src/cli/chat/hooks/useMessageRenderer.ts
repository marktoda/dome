import { useMemo } from 'react';
import { ChatMessage } from '../state/types.js';

interface MessageRenderData {
  id: string;
  content: string;
  type: ChatMessage['type'];
  isCollapsed?: boolean;
  timestamp: Date;
}

export function useMessageRenderer(messages: ChatMessage[]) {
  // Memoize the processed messages to avoid re-rendering
  const processedMessages = useMemo(() => {
    return messages.map(msg => ({
      id: msg.id,
      content: msg.streamingContent || msg.content,
      type: msg.type,
      isCollapsed: msg.isCollapsed,
      timestamp: msg.timestamp,
      isStreaming: msg.isStreaming,
    }));
  }, [messages]);

  // Memoize the visible messages calculation
  const visibleMessages = useMemo(() => {
    // Keep only last 50 messages for performance
    return processedMessages.slice(-50);
  }, [processedMessages]);

  return {
    processedMessages,
    visibleMessages,
  };
}