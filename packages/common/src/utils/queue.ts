import { MessageData, QueueMessage } from '../types/message';

/**
 * Queue utility functions for interacting with the queue service
 */

/**
 * Enqueue a message to the queue service
 * 
 * @param queueServiceUrl The URL of the queue service
 * @param message The message data to enqueue
 * @returns The ID of the enqueued message
 */
export async function enqueueMessage(queueServiceUrl: string, message: MessageData): Promise<string> {
  const response = await fetch(`${queueServiceUrl}/queue/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to enqueue message: ${error.error?.message || 'Unknown error'}`);
  }

  const result = await response.json();
  return result.messageId;
}

/**
 * Get a message from the queue service by ID
 * 
 * @param queueServiceUrl The URL of the queue service
 * @param messageId The ID of the message to get
 * @returns The message or null if not found
 */
export async function getMessage(queueServiceUrl: string, messageId: string): Promise<QueueMessage | null> {
  const response = await fetch(`${queueServiceUrl}/queue/message/${messageId}`, {
    method: 'GET'
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    const error = await response.json();
    throw new Error(`Failed to get message: ${error.error?.message || 'Unknown error'}`);
  }

  const result = await response.json();
  return result.message;
}

/**
 * Get queue statistics from the queue service
 * 
 * @param queueServiceUrl The URL of the queue service
 * @returns Queue statistics
 */
export async function getQueueStats(queueServiceUrl: string): Promise<{
  pending: number;
  processing: number;
  completed: number;
  retrying: number;
  deadLetter: number;
  total: number;
}> {
  const response = await fetch(`${queueServiceUrl}/queue/stats`, {
    method: 'GET'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to get queue stats: ${error.error?.message || 'Unknown error'}`);
  }

  const result = await response.json();
  return result.stats;
}

/**
 * Get dead letter messages from the queue service
 * 
 * @param queueServiceUrl The URL of the queue service
 * @returns Array of dead letter messages
 */
export async function getDeadLetterMessages(queueServiceUrl: string): Promise<QueueMessage[]> {
  const response = await fetch(`${queueServiceUrl}/queue/dead-letter`, {
    method: 'GET'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to get dead letter messages: ${error.error?.message || 'Unknown error'}`);
  }

  const result = await response.json();
  return result.messages;
}

/**
 * Retry a message in the queue service
 * 
 * @param queueServiceUrl The URL of the queue service
 * @param messageId The ID of the message to retry
 */
export async function retryMessage(queueServiceUrl: string, messageId: string): Promise<void> {
  const response = await fetch(`${queueServiceUrl}/queue/retry/${messageId}`, {
    method: 'POST'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to retry message: ${error.error?.message || 'Unknown error'}`);
  }
}