/**
 * Type definitions for the Silo service
 */

/**
 * R2 Event structure for object-created events
 */
export interface R2Event {
  account: string;
  bucket: string;
  eventTime: string;
  action: string; // "PutObject" for new objects
  object: {
    key: string;
    eTag: string;
    size: number;
  };
}

/**
 * Dead Letter Queue message structure
 */
export interface DLQMessage<T> {
  // Original message
  originalMessage: T;

  // Error information
  error: {
    message: string;
    name: string;
    stack?: string;
  };

  // Processing metadata
  processingMetadata: {
    failedAt: number;
    retryCount: number;
    queueName: string;
    messageId: string;
    producerService?: string;
  };

  // Recovery information
  recovery: {
    reprocessed: boolean;
    reprocessedAt?: number;
    recoveryResult?: string;
  };
}

/**
 * DLQ filter options for retrieving messages
 */
export interface DLQFilterOptions {
  queueName?: string;
  errorType?: string;
  reprocessed?: boolean;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}

/**
 * DLQ statistics response
 */
export interface DLQStats {
  totalMessages: number;
  reprocessedMessages: number;
  pendingMessages: number;
  byQueueName: Record<string, number>;
  byErrorType: Record<string, number>;
}
