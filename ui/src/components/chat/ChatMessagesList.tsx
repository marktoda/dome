'use client';

import React, { useEffect, useRef } from 'react';
import { useChat } from '@/contexts/ChatContext';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ParsedMessage } from '@/lib/chat-types'; // Updated import
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

  useEffect(() => {
    // Scroll to the bottom when messages change or loading state changes.
    // 'auto' behavior is used for instant scroll without smooth animation,
    // which is generally preferred for chat interfaces.
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, isLoading]);

  return (
    <ScrollArea className="flex-1" ref={scrollAreaRootRef}>
      <div className="space-y-6 p-4 md:p-6">
        {messages.map((msg) => {
          switch (msg.sender) {
            case 'user':
              return <UserMessage key={msg.id} message={msg} />;
            case 'assistant':
              // AssistantMessage handles various sub-types like 'content', 'thinking', 'sources', 'error'
              return <AssistantMessage key={msg.id} message={msg} />;
            case 'system':
              // System messages can be generic informational messages or errors.
              if (msg.type === 'system_generic') {
                return <SystemMessageDisplay key={msg.id} message={msg} />;
              } else if (msg.type === 'error') {
                // Reuse AssistantMessage for consistent error styling for system errors.
                return <AssistantMessage key={msg.id} message={msg} />;
              }
              // Fallback for any other system message types not explicitly handled.
              console.warn('Unhandled system message type in ChatMessagesList:', (msg as any).type, msg);
              return null;
            default:
              // This case should ideally not be reached if message senders are well-defined.
              console.warn('Unknown message sender type in ChatMessagesList:', (msg as ParsedMessage).sender, msg);
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
        {isLoading && messages[messages.length -1]?.sender !== 'assistant' && (
          <div className="flex items-start space-x-3 py-3 justify-start">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-[250px]" />
              <Skeleton className="h-4 w-[200px]" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} /> {/* Invisible element to scroll to */}
      </div>
    </ScrollArea>
  );
};