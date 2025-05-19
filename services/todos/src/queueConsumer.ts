import { Env, TodoJob, TodoQueueItemSchema, TodoQueueItem } from './types';
import { TodosService } from './services/todosService';
import {
  getLogger,
  logError,
  parseMessageBatch,
  ParsedMessageBatch,
  toRawMessageBatch,
} from '@dome/common';
import { AiProcessorAdapter } from './adapters/aiProcessorAdapter';

const logger = getLogger();

/**
 * Process a batch of todo jobs from the queue
 */
/**
 * Process a batch of todo jobs from the queue
 *
 * @param batch Batch of messages from the queue
 * @param env Environment bindings
 */
export async function processTodoQueue(
  batch: MessageBatch<TodoQueueItem>,
  env: Env,
): Promise<void> {
  logger.info('Processing todo queue batch', {
    batchSize: batch.messages.length,
    queueName: batch.queue,
  });

  const todosService = new TodosService(env.DB);
  const startTime = Date.now();

  // Convert the incoming batch to typed queue items
  let parsed: ParsedMessageBatch<TodoQueueItem>;
  try {
    parsed = parseMessageBatch(
      TodoQueueItemSchema,
      toRawMessageBatch(batch),
    );
  } catch (error) {
    logError(error, 'Failed to parse todo queue batch');
    return;
  }

  // Process each message in the batch
  const results = await Promise.allSettled(
    parsed.messages.map(async message => {
      try {
        const jobs = [AiProcessorAdapter.queueItemToJob(message.body)];

        if (jobs.length === 0) {
          logger.warn('No valid todo jobs found in message', {
            messageId: message.id,
          });
          return [];
        }

        // Process all jobs from this message
        const jobResults = await Promise.all(
          jobs.map(async job => {
            logger.debug('Processing todo job', {
              userId: job.userId,
              sourceNoteId: job.sourceNoteId,
              title: job.title?.substring(0, 30) + (job.title?.length > 30 ? '...' : ''),
            });

            // Process the job
            const result = await todosService.processTodoJob(job);

            logger.debug('Todo job processed successfully', {
              todoId: result.id,
              userId: job.userId,
              sourceNoteId: job.sourceNoteId,
            });

            return result;
          }),
        );

        return jobResults;
      } catch (error) {
        logError(error, 'Failed to process todo job', {
          messageId: message.id,
        });

        // Re-throw to be caught by Promise.allSettled
        throw error;
      }
    }),
  );

  const processingTime = Date.now() - startTime;

  // Count successes and failures
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  // Count total jobs processed
  const totalJobsProcessed = results
    .filter(r => r.status === 'fulfilled')
    .reduce(
      (count, result) => count + ((result as PromiseFulfilledResult<unknown[]>).value?.length || 0),
      0,
    );

  logger.info('Completed processing todo queue batch', {
    batchSize: batch.messages.length,
    totalJobsProcessed,
    messagesSucceeded: succeeded,
    messagesFailed: failed,
    processingTimeMs: processingTime,
    queueName: batch.queue,
  });
}

