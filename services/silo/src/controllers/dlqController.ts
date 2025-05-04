import { getLogger, logError, metrics } from '@dome/common';
import { toDomeError } from '../utils/errors';
import { DLQService } from '../services/dlqService';
import { DLQFilterOptions, DLQMessage, DLQStats } from '../types';

/**
 * DLQ Controller interface
 */
export interface DLQController {
  /**
   * Get DLQ statistics
   */
  getStats(): Promise<DLQStats>;

  /**
   * Get DLQ messages with filtering options
   */
  getMessages(options?: DLQFilterOptions): Promise<DLQMessage<unknown>[]>;

  /**
   * Reprocess a DLQ message
   */
  reprocessMessage(id: string): Promise<string>;

  /**
   * Reprocess multiple DLQ messages
   */
  reprocessMessages(ids: string[]): Promise<Record<string, string>>;

  /**
   * Purge DLQ messages
   */
  purgeMessages(options?: DLQFilterOptions): Promise<number>;

  /**
   * Send a message to the DLQ
   */
  sendToDLQ<T>(
    originalMessage: T,
    error: Error,
    metadata: {
      queueName: string;
      messageId: string;
      retryCount: number;
      producerService?: string;
    },
  ): Promise<string>;
}

/**
 * DLQ Controller implementation
 */
class DLQControllerImpl implements DLQController {
  constructor(private env: Env, private dlqService: DLQService) {}

  async getStats(): Promise<DLQStats> {
    try {
      return await this.dlqService.getDLQStats();
    } catch (error) {
      logError(error, 'Error getting DLQ stats');
      throw toDomeError(error, 'Failed to get DLQ stats');
    }
  }

  async getMessages(options?: DLQFilterOptions): Promise<DLQMessage<unknown>[]> {
    try {
      return await this.dlqService.getDLQMessages(options);
    } catch (error) {
      logError(error, 'Error getting DLQ messages');
      throw toDomeError(error, 'Failed to get DLQ messages', { filterOptions: options });
    }
  }

  async reprocessMessage(id: string): Promise<string> {
    try {
      return await this.dlqService.reprocessMessage(id);
    } catch (error) {
      logError(error, 'Error reprocessing DLQ message');
      throw toDomeError(error, 'Failed to reprocess DLQ message', { messageId: id });
    }
  }

  async reprocessMessages(ids: string[]): Promise<Record<string, string>> {
    try {
      return await this.dlqService.reprocessMessages(ids);
    } catch (error) {
      logError(error, 'Error reprocessing DLQ messages');
      throw toDomeError(error, 'Failed to reprocess DLQ messages', { messageIds: ids });
    }
  }

  async purgeMessages(options?: DLQFilterOptions): Promise<number> {
    try {
      return await this.dlqService.purgeMessages(options);
    } catch (error) {
      logError(error, 'Error purging DLQ messages');
      throw toDomeError(error, 'Failed to purge DLQ messages', { filterOptions: options });
    }
  }

  async sendToDLQ<T>(
    originalMessage: T,
    error: Error,
    metadata: {
      queueName: string;
      messageId: string;
      retryCount: number;
      producerService?: string;
    },
  ): Promise<string> {
    try {
      return await this.dlqService.sendToDLQ(originalMessage, error, metadata);
    } catch (error) {
      logError(error, 'Error sending message to DLQ');
      throw toDomeError(error, 'Failed to send message to DLQ', {
        queueName: metadata.queueName,
        messageId: metadata.messageId
      });
    }
  }
}

/**
 * Create a new DLQ controller
 */
export function createDLQController(env: Env, dlqService: DLQService): DLQController {
  return new DLQControllerImpl(env, dlqService);
}
