'use client';

import React from 'react';
import { ChatProvider } from '@/contexts/ChatContext';
import { ChatInput } from '@/components/chat/ChatInput';
import { ChatMessagesList } from '@/components/chat/ChatMessagesList';


/**
 * `ChatPage` is the main component for the chat interface.
 * It wraps the chat components (`ChatMessagesList`, `ChatInput`) within a `ChatProvider`
 * to provide the necessary context for chat state management and actions.
 * The layout (header, sidebar) is typically handled by a parent layout component like `LayoutWithSidebar`.
 *
 * @returns A React functional component representing the chat page UI.
 */
const ChatPage: React.FC = () => {
  return (
    <ChatProvider>
      {/*
        The overall page layout (like header, sidebar, and main content padding)
        is assumed to be handled by a higher-level layout component (e.g., LayoutWithSidebar).
        This component focuses solely on rendering the chat interface within the space provided.
      */}
      <div className="flex h-full w-full max-w-4xl flex-col mx-auto">
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatMessagesList />
          <ChatInput />
        </div>
      </div>
    </ChatProvider>
  );
};

export default ChatPage;