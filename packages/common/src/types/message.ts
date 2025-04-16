/**
 * Message data interface for the queue infrastructure
 */

export enum Platform {
  TELEGRAM = 'telegram',
  TWITTER = 'twitter',
  SLACK = 'slack',
}

/**
 * Message data interface
 */
export interface MessageData {
  id: string;              // Unique message ID
  platform: Platform;          // Source of the message (telegram, websocket, etc.)
  timestamp: number;       // Unix timestamp in milliseconds
  content: {               // Message content
    type: string;          // text, image, video, etc.
    text?: string;         // Text content if applicable
    mediaUrl?: string;     // URL to media if applicable
  };
  metadata: {              // Additional metadata
    sender?: {             // Sender information
      id: string;
      name?: string;
    };
    retryCount?: number;   // For tracking retries
  };
}

/**
 * Queue message status
 */
export enum MessageStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter'
}

/**
 * Queue message interface
 */
export interface QueueMessage {
  id: string;
  data: MessageData;
  status: MessageStatus;
  createdAt: number;
  updatedAt: number;
  processingAttempts: number;
  error?: string;
}

/**
 * Dead letter queue message interface
 */
export interface DeadLetterQueueMessage extends QueueMessage {
  failureReason: string;
  lastAttemptAt: number;
}
