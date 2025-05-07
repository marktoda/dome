import React from 'react';
import { Message } from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage';

interface UserMessageProps {
  message: Message;
}

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  if (message.sender !== 'user') {
    return null;
  }

  return (
    <ChatMessage
      message={message}
      avatarFallback="U"
      // You can add a specific avatar source for the user if available
      // avatarSrc="/path/to/user-avatar.png"
      className="ml-auto"
    />
  );
};