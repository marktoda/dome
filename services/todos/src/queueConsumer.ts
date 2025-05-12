import { Env, TodoJob } from './types';
import { TodosService } from './services/todosService';
import { getLogger, logError } from '@dome/common'; // Assuming logError is co-located or update path
import { AiProcessorAdapter, AiExtractedTodo } from './adapters/aiProcessorAdapter';
import { TodoQueueItem } from './client';

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

  // Process each message in the batch
  const results = await Promise.allSettled(
    batch.messages.map(async message => {
      try {
        // Handle different message formats based on source
        const jobs = transformQueueMessage(message);

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

/**
 * Transform a queue message into TodoJob objects
 *
 * @param message Message from the queue
 * @returns Array of TodoJob objects ready for processing
 */
function transformQueueMessage(message: { body: TodoQueueItem; id: string }): TodoJob[] {
  const { body } = message;

  if (!body) {
    logger.warn('Empty message body received', { messageId: message.id });
    return [];
  }

  try {
    // Check if message has all required fields according to TodoQueueItem interface
    const { userId, sourceNoteId, sourceText, title } = body;

    if (!userId || !sourceNoteId || !sourceText || !title) {
      logger.warn('Invalid todo queue item - missing required fields', {
        messageId: message.id,
        hasUserId: !!userId,
        hasSourceNoteId: !!sourceNoteId,
        hasSourceText: !!sourceText,
        hasTitle: !!title,
      });
      return [];
    }

    // Use the adapter to convert the queue item to a job
    const todoJob = AiProcessorAdapter.queueItemToJob(body);

    logger.debug('Transformed queue message to todo job', {
      messageId: message.id,
      todoId: todoJob.sourceNoteId,
      userId: todoJob.userId,
    });

    return [todoJob];
  } catch (error) {
    logError(error, 'Error transforming queue message', {
      messageId: message.id,
    });
    return [];
  }
}
