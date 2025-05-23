'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import { useChat } from '@/contexts/ChatContext';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ParsedMessage, AssistantContentMessage, AssistantErrorMessage, AssistantReasoningMessage, AssistantSourcesMessage, AssistantThinkingMessage } from '@/lib/chat-types'; // Import new type
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { SystemMessageDisplay } from './SystemMessageDisplay';

/**
 * `ChatMessagesList` component renders a list of chat messages within a scrollable area.
 * It handles different message senders (user, assistant, system) and displays them accordingly.
 * It also shows a loading skeleton when new messages are being fetched or processed.
 * The list automatically scrolls to the bottom when new messages are added or loading state changes.
 * @returns A React functional component.
 */
export const ChatMessagesList: React.FC = () => {
  const { messages, isLoading } = useChat();
  const scrollAreaRootRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Define the desired order for assistant message types within a single turn
  const assistantMessageTypeOrder = useMemo<
    Record<
      | AssistantContentMessage['type']
      | AssistantThinkingMessage['type']
      | AssistantSourcesMessage['type']
      | AssistantReasoningMessage['type']
      | AssistantErrorMessage['type'],
      number
    >
  >(
    () => ({
      thinking: 1,
      reasoning: 2,
      sources: 3,
      content: 4,
      error: 5, // Assistant errors related to the turn
    }),
    []
  );

  const sortedMessages = useMemo(() => {
    return [...messages].sort((a, b) => {
      // Primary sort by timestamp to maintain overall conversation flow
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();

      // If messages are part of the same assistant turn (share a parentId)
      if (
        a.sender === 'assistant' &&
        b.sender === 'assistant' &&
        a.parentId &&
        b.parentId &&
        a.parentId === b.parentId &&
        'type' in a && // Type guard for a
        'type' in b   // Type guard for b
      ) {
        // Now 'a.type' and 'b.type' are safe to access for assistant messages
        // and are guaranteed to be one of the keys in assistantMessageTypeOrder
        const orderA = assistantMessageTypeOrder[a.type as keyof typeof assistantMessageTypeOrder] || 99;
        const orderB = assistantMessageTypeOrder[b.type as keyof typeof assistantMessageTypeOrder] || 99;

        if (orderA !== orderB) {
          return orderA - orderB;
        }
      }
      // If timestamps are identical (can happen for rapidly streamed parts),
      // and they are part of the same turn, use type order.
      if (
        timeDiff === 0 &&
        a.parentId &&
        a.parentId === b.parentId &&
        a.sender === 'assistant' &&
        b.sender === 'assistant' &&
        'type' in a && // Type guard for a
        'type' in b   // Type guard for b
      ) {
        const orderA = assistantMessageTypeOrder[a.type as keyof typeof assistantMessageTypeOrder] || 99;
        const orderB = assistantMessageTypeOrder[b.type as keyof typeof assistantMessageTypeOrder] || 99;
        return orderA - orderB;
      }

      return timeDiff;
    });
  }, [messages, assistantMessageTypeOrder]); // Add assistantMessageTypeOrder to dependencies

  useEffect(() => {
    // Scroll to the bottom when sorted messages change or loading state changes.
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [sortedMessages, isLoading]);

  return (
    <ScrollArea className="flex-1" ref={scrollAreaRootRef}>
      <div className="space-y-4 p-0 sm:p-4 md:p-6">
        {sortedMessages.map((msg: ParsedMessage) => { // Use sortedMessages
          switch (msg.sender) {
            case 'user':
              return <UserMessage key={msg.id} message={msg} />;
            case 'assistant':
              // Inner switch based on assistant message type
              switch (msg.type) {
                case 'content':
                case 'thinking':
                case 'sources':
                case 'error': // Assistant errors are handled by AssistantMessage
                  // AssistantMessage handles various sub-types like 'content', 'thinking', 'sources', 'error'
                  return <AssistantMessage key={msg.id} message={msg} />;
                case 'reasoning':
                  // Simple display for reasoning steps
                  return (
                    <div key={msg.id} className="text-xs text-muted-foreground italic pl-10 py-1 border-l border-dashed border-border ml-4">
                      {msg.text}
                    </div>
                  );
                default:
                  // Fallback for unknown assistant message types
                  console.warn('Unknown assistant message type in ChatMessagesList:', (msg as any).type, msg);
                  return null;
              }
            case 'system':
              // System messages can be generic informational messages or errors.
              switch (msg.type) {
                  case 'system_generic':
                    return <SystemMessageDisplay key={msg.id} message={msg} />;
                  case 'error':
                    // Reuse AssistantMessage for consistent error styling for system errors.
                    // Ensure AssistantMessage can handle system errors if needed, or create a specific component.
                    // For now, assuming AssistantMessage can handle it based on previous code.
                    return <AssistantMessage key={msg.id} message={msg} />;
                  default:
                    // Fallback for any other system message types not explicitly handled.
                    console.warn('Unhandled system message type in ChatMessagesList:', (msg as any).type, msg);
                    return null;
              }
            default:
              // This case should ideally not be reached if message senders are well-defined.
              // Assert exhaustive check - this helps catch if new senders are added without handling
              const _exhaustiveCheck: never = msg;
              console.warn('Unknown message sender type in ChatMessagesList:', _exhaustiveCheck);
              return null;
          }
        })}
        {/* Show a skeleton loader if isLoading is true AND there isn't already an assistant "thinking" message.
            The `AssistantMessage` component itself shows a "thinking" state.
            This skeleton is more of a general "waiting for assistant's turn" indicator.
            A simpler check might be if isLoading and the last message isn't an assistant thinking message.
            For now, if `isLoading` is true, we show a generic pending response.
            The `AssistantMessage` component will replace this with a "thinking" state once an assistant message shell is created.
        */}
        {isLoading &&
          sortedMessages[sortedMessages.length - 1]?.sender !== 'assistant' && (
            <div className="py-2">
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
        <div ref={messagesEndRef} /> {/* Invisible element to scroll to */}
      </div>
    </ScrollArea>
  );
};