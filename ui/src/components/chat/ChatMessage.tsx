import React from 'react';
import { ParsedMessage } from '@/lib/chat-types'; // Updated import
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/**
 * Props for the {@link ChatMessage} component.
 */
interface ChatMessageProps {
  /** The message object containing sender, timestamp, and content. */
  message: ParsedMessage;
  /** Optional additional CSS class names for the component. */
  className?: string;
  /** Optional URL for the avatar image. */
  avatarSrc?: string;
  /** Fallback text for the avatar if the image fails to load or is not provided. */
  avatarFallback: string;
  /**
   * Optional React node to override the default rendering of message content.
   * Useful for complex message types like assistant messages with thinking indicators, sources, or errors.
   */
  contentOverride?: React.ReactNode;
}

/**
 * Renders a single chat message, adapting its style and layout based on whether
 * the sender is the user or another participant (e.g., assistant, system).
 * It displays an avatar, the message content (or a custom override), and a timestamp.
 *
 * @param props - The props for the component.
 * @returns A React functional component representing a chat message.
 */
export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  className,
  avatarSrc,
  avatarFallback,
  contentOverride,
}) => {
  const isUser = message.sender === 'user';

  return (
    <div
      className={cn(
        'flex items-end space-x-3 py-2',
        isUser ? 'justify-end pl-8 sm:pl-12' : 'justify-start pr-8 sm:pr-12',
        className
      )}
    >
      {!isUser && (
        <Avatar className="h-9 w-9">
          <AvatarImage src={avatarSrc} alt={message.sender} />
          <AvatarFallback>{avatarFallback}</AvatarFallback>
        </Avatar>
      )}
      <div
        className={cn(
          'max-w-sm rounded-xl p-3 shadow-md lg:max-w-lg',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-none'
            : 'bg-muted text-muted-foreground rounded-bl-none'
        )}
      >
        {contentOverride ? (
          contentOverride
        ) : (
          // Only render message.text if it exists on the message type
          // UserMessage has text. For others, contentOverride should be used.
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {('text' in message && typeof message.text === 'string') ? message.text : ''}
          </p>
        )}
        <p
          className={cn(
            'mt-1.5 text-xs',
            isUser ? 'text-primary-foreground/80' : 'text-muted-foreground/70'
          )}
        >
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
      {isUser && (
        <Avatar className="h-9 w-9"> {/* Slightly larger avatar */}
          <AvatarImage src={avatarSrc} alt={message.sender} />
          <AvatarFallback>{avatarFallback}</AvatarFallback>
        </Avatar>
      )}
    </div>
  );
};