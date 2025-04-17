/**
 * Message models for the push-message-ingestor service
 */

import type { MessageData } from '@dome/common';
import { Platform } from '@dome/common';

export interface PlatformMessage {
  platform: Platform;
  toMessageData(): MessageData;
}

export type TelegramMessageData = {
  id: string;
  timestamp: string;
  platform: 'telegram';
  content: string;
  chatId: string;
  messageId: string;
  fromUserId?: string;
  fromUsername?: string;
  replyToMessageId?: string;
  forwardFromMessageId?: string;
  forwardFromChatId?: string;
  mediaType?: string;
  mediaUrl?: string;
};

/**
 * Telegram message interface
 */
export class TelegramMessage implements PlatformMessage {
  platform = Platform.TELEGRAM;

  constructor(public data: TelegramMessageData) {}

  toMessageData(): MessageData {
    const sender = this.data.fromUserId
      ? {
          id: this.data.fromUserId,
          name: this.data.fromUsername,
        }
      : undefined;

    return {
      id: this.data.id,
      platform: this.platform,
      timestamp: parseInt(this.data.timestamp),
      content: {
        type: 'text',
        text: this.data.content,
      },
      metadata: {
        sender,
      },
    };
  }
}

export interface PublishTelegramMessageRequest {
  messages: TelegramMessageData[];
}
