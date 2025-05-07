'use client';

import React, { useEffect, useRef } from 'react';
import { useChat } from '@/contexts/ChatContext';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { Message } from '@/lib/chat-types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';

export const ChatMessagesList: React.FC = () => {
  const { messages, isLoading } = useChat();
  const scrollAreaRootRef = useRef<HTMLDivElement>(null); // Ref for the ScrollArea's root
  const messagesEndRef = useRef<HTMLDivElement>(null); // Ref for an element at the end of messages

  useEffect(() => {
    // Scroll to the bottom when messages change or loading state changes
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, isLoading]);

  return (
    <ScrollArea className="flex-1" ref={scrollAreaRootRef}> {/* Removed p-4, will add padding to inner div */}
      <div className="space-y-6 p-4 md:p-6"> {/* Increased space-y and added responsive padding */}
        {messages.map((msg: Message) => (
          msg.sender === 'user' ? (
            <UserMessage key={msg.id} message={msg} />
          ) : (
            <AssistantMessage key={msg.id} message={msg} />
          )
        ))}
        {isLoading && (
          <div className="flex items-start space-x-3 py-3 justify-start"> {/* Kept skeleton styling as is, seems reasonable */}
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