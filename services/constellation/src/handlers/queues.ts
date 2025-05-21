import { NewContentQueue } from '@dome/silo/queues';
import { ParsedMessageBatch, NewContentMessage } from '@dome/common';
import { toDomeError } from '../utils/errors';
import {
  getLogger,
  logError,
  trackOperation,
  constellationMetrics as metrics,
} from '../utils/logging';
import { wrapServiceCall } from '@dome/common';
import type { MessageBatch } from '@cloudflare/workers-types/experimental';

const runWithLog = wrapServiceCall('constellation');

export async function handleQueue(this: any, batch: MessageBatch<Record<string, unknown>>) {
  const batchId = crypto.randomUUID();

  await runWithLog(
    {
      service: 'constellation',
      op: 'queue',
      size: batch.messages.length,
      batchRequestId: batchId,
      ...this.env,
    },
    async () => {
      const startTime = Date.now();
      metrics.gauge('queue.batch_size', batch.messages.length);
      metrics.counter('queue.batches_received', 1);

      const parsed: ParsedMessageBatch<NewContentMessage> = NewContentQueue.parseBatch(batch);

      getLogger().info(
        {
          batchRequestId: batchId,
          messageCount: parsed.messages.length,
          queueName: batch.queue,
          operation: 'queue',
        },
        `Processing queue batch with ${parsed.messages.length} messages`,
      );

      if (parsed.messages.length) {
        const processed = await this.embedBatch(parsed.messages, this.env.EMBED_DEAD, batchId);
        metrics.counter('queue.jobs_processed', processed);
      }

      const duration = Date.now() - startTime;
      metrics.timing('queue.batch_processing_time', duration);
      metrics.counter('queue.batches_completed', 1);
    },
  );
}
