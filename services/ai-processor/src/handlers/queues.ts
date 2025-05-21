import { NewContentQueue } from '@dome/silo/queues';
import { toDomeError } from '@dome/common';
import {
  getLogger,
  logError,
  trackOperation,
  aiProcessorMetrics,
} from '../utils/logging';
import type { NewContentMessage, ParsedMessageBatch } from '@dome/common';

export async function handleQueue(this: any, batch: MessageBatch<NewContentMessage>) {
  const batchId = crypto.randomUUID();

  await trackOperation(
    'process_message_batch',
    async () => {
      const startTime = Date.now();
      const queueName = batch.queue;

      const parsed: ParsedMessageBatch<NewContentMessage> = NewContentQueue.parseBatch(batch);

      getLogger().info(
        {
          queueName,
          batchId,
          messageCount: parsed.messages.length,
          firstMessageId: parsed.messages[0]?.id,
          operation: 'queue',
        },
        'Processing queue batch',
      );

      aiProcessorMetrics.counter('batch.received', 1, { queueName });
      aiProcessorMetrics.counter('messages.received', parsed.messages.length, { queueName });

      let successCount = 0;
      let errorCount = 0;

      for (const message of parsed.messages) {
        const messageRequestId = `${batchId}-${message.id}`;
        try {
          await this.services.processor.processMessage(message.body, messageRequestId);
          successCount++;
        } catch (error) {
          errorCount++;
          const domeError = toDomeError(error, 'Failed to process queue message', {
            messageId: message.id,
            contentId: message.body?.id,
            batchId,
            requestId: messageRequestId,
          });

          logError(domeError, 'Failed to process message from queue');
          aiProcessorMetrics.counter('messages.errors', 1, {
            queueName,
            errorType: domeError.code,
          });
        }
      }

      const duration = Date.now() - startTime;
      getLogger().info(
        {
          queueName,
          batchId,
          messageCount: parsed.messages.length,
          successCount,
          errorCount,
          successRate: Math.round((successCount / parsed.messages.length) * 100),
          durationMs: duration,
          avgProcessingTimeMs: Math.round(duration / parsed.messages.length),
          operation: 'queue',
        },
        'Completed processing queue batch',
      );

      aiProcessorMetrics.timing('batch.duration_ms', duration, { queueName });
      aiProcessorMetrics.counter('batch.completed', 1, { queueName });
      aiProcessorMetrics.counter('messages.processed', successCount, { queueName });
      aiProcessorMetrics.gauge('batch.success_rate', successCount / parsed.messages.length, {
        queueName,
      });
    },
    { batchId, queueName: batch.queue, messageCount: batch.messages.length },
  );
}
