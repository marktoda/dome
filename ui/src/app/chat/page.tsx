'use client';

import React from 'react';
import { ChatProvider } from '@/contexts/ChatContext';
import { ChatInput } from '@/components/chat/ChatInput';
import { ChatMessagesList } from '@/components/chat/ChatMessagesList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const ChatPage = () => {
  return (
    <ChatProvider>
      {/* Removed outer div with height calculation and padding, as layout is handled by LayoutWithSidebar */}
      {/* The Card will now naturally fill the space provided by the main content area of LayoutWithSidebar */}
      <Card className="flex h-full w-full max-w-4xl flex-col shadow-xl mx-auto"> {/* Increased max-w, added shadow, centered with mx-auto */}
        <CardHeader className="border-b"> {/* Added border to header */}
          <CardTitle className="text-xl font-semibold">Chat with Assistant</CardTitle> {/* Enhanced title styling */}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col overflow-hidden p-0"> {/* p-0 to let children handle padding */}
          <ChatMessagesList />
          <ChatInput />
        </CardContent>
      </Card>
    </ChatProvider>
  );
};

export default ChatPage;