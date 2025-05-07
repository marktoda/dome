import React from 'react';
import { Message } from '@/lib/chat-types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

interface ChatMessageProps {
  message: Message;
  className?: string;
  avatarSrc?: string;
  avatarFallback: string;
  contentOverride?: React.ReactNode; // New prop for custom content rendering
}

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
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.text}</p>
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