import React from 'react';
import { ParsedMessage } from '@/lib/chat-types';
import { cn } from '@/lib/utils';

/**
 * Props for the {@link ChatMessage} component.
 */
interface ChatMessageProps {
  /** The message object containing sender, timestamp, and content. */
  message: ParsedMessage;
  /** Optional additional CSS class names for the component. */
  className?: string;
  /** Optional React node to override the default rendering of message content. */
  contentOverride?: React.ReactNode;
}

/**
 * Renders a single chat message in a minimalist style.
 * Displays the content without avatars or timestamp for a clean look.
 *
 * @param props - The props for the component.
 * @returns A React functional component representing a chat message.
 */
export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  className,
  contentOverride,
}) => {
  const isUser = message.sender === 'user';

  return (
    <div className={cn('py-2', isUser ? 'text-right' : 'text-left', className)}>
      {contentOverride ? (
        contentOverride
      ) : (
        <p className="whitespace-pre-wrap break-words font-mono text-lg">
          {'text' in message && typeof message.text === 'string' ? message.text : ''}
        </p>
      )}
    </div>
  );
};