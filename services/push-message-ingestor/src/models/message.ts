/**
 * Message models for the push-message-ingestor service
 */

/**
 * Base message interface that all platform-specific messages will extend
 */
export interface BaseMessage {
  id: string;
  timestamp: string;
  platform: string;
  content: string;
  metadata: Record<string, any>;
}

/**
 * Telegram message interface
 */
export interface TelegramMessage extends BaseMessage {
  platform: 'telegram';
  metadata: {
    chatId: string;
    messageId: string;
    fromUserId?: string;
    fromUsername?: string;
    replyToMessageId?: string;
    forwardFromMessageId?: string;
    forwardFromChatId?: string;
    mediaType?: string;
    mediaUrl?: string;
    [key: string]: any;
  };
}

/**
 * Type guard to check if a message is a TelegramMessage
 */
export function isTelegramMessage(message: BaseMessage): message is TelegramMessage {
  return message.platform === 'telegram';
}

/**
 * Message batch interface for publishing multiple messages at once
 */
export interface MessageBatch<T extends BaseMessage = BaseMessage> {
  messages: T[];
}

/**
 * Telegram message batch interface
 */
export interface TelegramMessageBatch extends MessageBatch<TelegramMessage> {}