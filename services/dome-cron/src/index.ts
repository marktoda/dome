import { QueueService, Event, createReminderDueEvent } from '@dome/common';
import { withLogger, getLogger, logError } from '@dome/logging';
import { monitorDLQ } from './jobs/dlqMonitoring';

// Define the execution context interface with the run method
interface CFExecutionContext {
  run<T>(callback: () => T): Promise<T>;
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

/**
 * Environment interface for the dome-cron worker
 */
export interface Env {
  // D1 Database binding
  D1_DATABASE: D1Database;

  // Queue binding
  EVENTS: Queue;

  // Environment variables
  ENVIRONMENT: string;
  VERSION: string;

  // DLQ monitoring configuration
  SILO_API_URL: string;
  INTERNAL_API_KEY: string;
  DLQ_ALERT_THRESHOLD: string;
  DLQ_ERROR_TYPE_THRESHOLD: string;
  DLQ_AUTO_REPROCESS: string;
}

/**
 * Scheduled worker that scans for due reminders and enqueues events
 */
export default {
  /**
   * Scheduled handler that runs on the specified cron schedule
   * @param event The scheduled event
   * @param env Environment bindings
   * @param ctx Execution context
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: CFExecutionContext): Promise<void> {
    await withLogger(
      {
        trigger: 'cron',
        cron: event.cron,
        scheduledTime: event.scheduledTime,
        environment: env.ENVIRONMENT,
      },
      async () => {
        const logger = getLogger();
        logger.info({ cron: event.cron }, 'Running scheduled job');

        try {
          // Determine which job to run based on the cron schedule
          if (event.cron === '*/15 * * * *') {
            // Run DLQ monitoring job every 15 minutes
            logger.info('Starting DLQ monitoring job');
            await monitorDLQ(env);
            logger.info('DLQ monitoring job completed');
          } else {
            // Default job: Process reminders
            logger.info('Starting reminder processing job');

            // Initialize the queue service
            const queueService = new QueueService({
              queueBinding: env.EVENTS,
              maxRetries: 3,
            });

            // Process reminders in batches to handle potential large result sets
            let cursor: string | null = null;
            const batchSize = 500; // Process 500 reminders at a time
            let processedCount = 0;

            do {
              // Query for due reminders that haven't been delivered yet
              const query = `
            SELECT
              r.id as reminder_id,
              t.id as task_id,
              t.user_id,
              t.title,
              t.description,
              r.remind_at,
              t.priority
            FROM reminders r
            JOIN tasks t ON r.task_id = t.id
            WHERE r.remind_at <= datetime('now')
              AND r.delivered = 0
            ORDER BY r.remind_at ASC
            LIMIT ${batchSize}
            ${cursor ? `OFFSET ${cursor}` : ''}
          `;

              const result = await env.D1_DATABASE.prepare(query).all();
              const reminders = result.results as any[];

              if (reminders.length === 0) {
                break; // No more reminders to process
              }

              // Update cursor for next batch
              cursor = String(parseInt(cursor || '0') + reminders.length);
              processedCount += reminders.length;

              logger.info({ count: reminders.length }, 'Processing batch of reminders');

              // Create reminder events for each due reminder
              const reminderEvents: Event[] = reminders.map(reminder =>
                createReminderDueEvent({
                  reminderId: reminder.reminder_id,
                  taskId: reminder.task_id,
                  userId: reminder.user_id,
                  title: reminder.title,
                  description: reminder.description,
                  dueAt: reminder.remind_at,
                  priority: reminder.priority,
                }),
              );

              // Publish events to the queue
              if (reminderEvents.length > 0) {
                await queueService.publishEvents(reminderEvents);
                logger.info({ count: reminderEvents.length }, 'Published reminder events to queue');
              }

              // If we got fewer results than the batch size, we need to make one more query
              // to ensure we've processed everything, but then we can stop
              if (reminders.length < batchSize) {
                // Make one more query after getting fewer results than the batch size
                const emptyCheckQuery = `
              SELECT
                r.id as reminder_id,
                t.id as task_id,
                t.user_id,
                t.title,
                t.description,
                r.remind_at,
                t.priority
              FROM reminders r
              JOIN tasks t ON r.task_id = t.id
              WHERE r.remind_at <= datetime('now')
                AND r.delivered = 0
              ORDER BY r.remind_at ASC
              LIMIT ${batchSize}
              OFFSET ${cursor}
            `;

                await env.D1_DATABASE.prepare(emptyCheckQuery).all();
                break;
              }
            } while (true);

            logger.info({ processedCount }, 'Reminder processing job completed');
          }
        } catch (error) {
          logError(getLogger(), error, 'Error in scheduled job');
          // Ensure the error is reported to the Cloudflare dashboard
          ctx.waitUntil(Promise.reject(error));
          // Re-throw the error to propagate it to the caller
          throw error;
        }
      },
    );
  },
};
