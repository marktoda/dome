import { wrap } from '../utils/wrap';
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
import type { SiloEnv } from '../config/env';

class DLQControllerImpl implements DLQController {
  constructor(private env: SiloEnv, private dlqService: DLQService) {}

  async getStats(): Promise<DLQStats> {
    return wrap({ operation: 'getStats' }, () => this.dlqService.getDLQStats());
  }

  async getMessages(options?: DLQFilterOptions): Promise<DLQMessage<unknown>[]> {
    return wrap({ operation: 'getMessages', filterOptions: options }, () =>
      this.dlqService.getDLQMessages(options),
    );
  }

  async reprocessMessage(id: string): Promise<string> {
    return wrap({ operation: 'reprocessMessage', id }, () =>
      this.dlqService.reprocessMessage(id),
    );
  }

  async reprocessMessages(ids: string[]): Promise<Record<string, string>> {
    return wrap({ operation: 'reprocessMessages', messageIds: ids }, () =>
      this.dlqService.reprocessMessages(ids),
    );
  }

  async purgeMessages(options?: DLQFilterOptions): Promise<number> {
    return wrap({ operation: 'purgeMessages', filterOptions: options }, () =>
      this.dlqService.purgeMessages(options),
    );
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
    return wrap(
      {
        operation: 'sendToDLQ',
        queueName: metadata.queueName,
        messageId: metadata.messageId,
      },
      () => this.dlqService.sendToDLQ(originalMessage, error, metadata),
    );
  }
}

/**
 * Create a new DLQ controller
 */
export function createDLQController(env: SiloEnv, dlqService: DLQService): DLQController {
  return new DLQControllerImpl(env, dlqService);
}
