import React from 'react';
import { UserMessage as UserMessageType } from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage';

/**
 * Props for the {@link UserMessage} component.
 */
interface UserMessageProps {
  /** The user message object to display. */
  message: UserMessageType;
}

/**
 * Renders a message sent by the user.
 * It utilizes the generic {@link ChatMessage} component for the actual rendering,
 * providing user-specific configurations like avatar fallback.
 *
 * @param props - The props for the component.
 * @param props.message - The user message object.
 * @returns A React element representing the user's message, or null if the sender is not 'user'.
 */
export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  if (message.sender !== 'user') {
    // This check ensures the component only renders messages explicitly from the user.
    // It's a safeguard, though props typing should generally prevent misuse.
    console.warn('UserMessage component received a message not from "user":', message);
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
