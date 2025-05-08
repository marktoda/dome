'use client';

import React from 'react';
import { ChatProvider } from '@/contexts/ChatContext';
import { ChatInput } from '@/components/chat/ChatInput';
import { ChatMessagesList } from '@/components/chat/ChatMessagesList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * `ChatPage` is the main component for the chat interface.
 * It wraps the chat components (`ChatMessagesList`, `ChatInput`) within a `ChatProvider`
 * to provide the necessary context for chat state management and actions.
 * The layout (header, sidebar) is typically handled by a parent layout component like `LayoutWithSidebar`.
 *
 * @returns A React functional component representing the chat page UI.
 */
const ChatPage: React.FC = () => { // Added React.FC type
  return (
    <ChatProvider>
      {/*
        The overall page layout (like header, sidebar, and main content padding)
        is assumed to be handled by a higher-level layout component (e.g., LayoutWithSidebar).
        This component focuses solely on rendering the chat interface within the space provided.
      */}
      <Card className="flex h-full w-full max-w-4xl flex-col shadow-xl mx-auto border-0 md:border"> {/* Make border conditional */}
        <CardHeader className="border-b">
          <CardTitle className="text-xl font-semibold">Chat with Assistant</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
          {/* ChatMessagesList handles the scrollable message display */}
          <ChatMessagesList />
          {/* ChatInput provides the text input and send button */}
          <ChatInput />
        </CardContent>
      </Card>
    </ChatProvider>
  );
};

export default ChatPage;