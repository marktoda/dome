import { getLogger, metrics } from '@dome/logging';
import { R2Service } from '../services/r2Service';
import { MetadataService } from '../services/metadataService';
import { QueueService } from '../services/queueService';
import { R2Event } from '../types';

/**
 * QueueController handles business logic for queue operations
 * Coordinates between R2Service, MetadataService, and QueueService
 */
export class QueueController {
  constructor(
    private env: any,
    private r2Service: R2Service,
    private metadataService: MetadataService,
    private queueService: QueueService
  ) {}

  /**
   * Process a batch of queue messages
   */
  async processBatch(batch: any) {
    const startTime = Date.now();
    
    getLogger().info('Processing queue batch');
    metrics.gauge('silo.queue.batch_size', batch.messages.length);

    try {
      // Process the batch using QueueService
      await this.queueService.processBatch(batch);
      
      // Record metrics for processing time
      metrics.timing('silo.queue.process_time_ms', Date.now() - startTime);
    } catch (error) {
      getLogger().error({ error }, 'Error processing queue batch');
      metrics.increment('silo.queue.errors', 1, { operation: 'processBatch' });
      throw error;
    }
  }
}

export function createQueueController(
  env: any,
  r2Service: R2Service,
  metadataService: MetadataService,
  queueService: QueueService
): QueueController {
  return new QueueController(env, r2Service, metadataService, queueService);
}