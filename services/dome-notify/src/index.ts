import { QueueService, Event, EventSchema, MessageBatch } from '@dome/common';
import { withLogger, getLogger } from '@dome/logging';

// Define the execution context interface with the run method
interface CFExecutionContext {
  run<T>(callback: () => T): Promise<T>;
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}
import {
  NotificationService,
  EmailNotificationChannel,
  SlackNotificationChannel,
} from './services/notificationService';
import {
  EventHandlerRegistry,
  ReminderDueEventHandler,
  IngestionCompleteEventHandler,
} from './handlers/eventHandlers';

/**
 * Environment interface for the dome-notify worker
 */
export interface Env {
  // D1 Database binding
  D1_DATABASE: D1Database;

  // Environment variables
  ENVIRONMENT: string;
  VERSION: string;
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  SLACK_WEBHOOK_URL: string;
}

/**
 * Initialize the notification service with configured channels
 * @param env Environment bindings
 * @returns Configured notification service
 */
function initializeNotificationService(env: Env): NotificationService {
  const notificationService = new NotificationService();

  // Add email notification channel
  const emailChannel = new EmailNotificationChannel(env.MAIL_FROM, env.MAIL_FROM_NAME);
  notificationService.addChannel(emailChannel);

  // Add Slack notification channel if webhook URL is configured
  if (env.SLACK_WEBHOOK_URL) {
    const slackChannel = new SlackNotificationChannel(env.SLACK_WEBHOOK_URL);
    notificationService.addChannel(slackChannel);
  }

  return notificationService;
}

/**
 * Initialize the event handler registry with all event handlers
 * @param notificationService The notification service to use
 * @returns Configured event handler registry
 */
function initializeEventHandlerRegistry(
  notificationService: NotificationService,
): EventHandlerRegistry {
  const registry = new EventHandlerRegistry();

  // Register handlers for different event types
  registry.registerHandler(new ReminderDueEventHandler(notificationService));
  registry.registerHandler(new IngestionCompleteEventHandler(notificationService));

  return registry;
}

/**
 * Queue consumer worker that processes events and sends notifications
 */
export default {
  /**
   * Queue message handler
   * @param batch The batch of queue messages to process
   * @param env Environment bindings
   * @param ctx Execution context
   */
  async queue(batch: MessageBatch, env: Env, ctx: CFExecutionContext): Promise<void> {
    await withLogger(
      {
        trigger: 'queue',
        batchSize: batch.messages.length,
        environment: env.ENVIRONMENT,
      },
      async (log) => {
        log.info({ batchSize: batch.messages.length }, 'Processing message batch');

        // Initialize services
        const notificationService = initializeNotificationService(env);
        const eventHandlerRegistry = initializeEventHandlerRegistry(notificationService);

        // Process each message in the batch
        for (const message of batch.messages) {
          try {
            log.info({ messageId: message.id }, 'Processing message');

            // Parse the message body as JSON
            const rawEvent = JSON.parse(message.body);

            // Validate the event against the schema
            const event = EventSchema.parse(rawEvent) as Event;

            // Handle the event with the appropriate handler
            await eventHandlerRegistry.handleEvent(event, env);

            // Acknowledge the message as processed
            batch.ack(message.id);

            log.info({ messageId: message.id }, 'Successfully processed message');
          } catch (error) {
            log.error({ messageId: message.id, error }, 'Error processing message');

            // Acknowledge the message to remove it from the queue
            // In a production environment, you might want to implement a dead-letter queue
            // or other error handling mechanism instead of just acknowledging
            batch.ack(message.id);
          }
        }

        log.info('Batch processing completed');
      }
    );
  },
};
