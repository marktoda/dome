import { QueueService, Event, createReminderDueEvent } from '@dome/common';

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
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Running scheduled job at ${new Date().toISOString()}`);
    
    // Initialize the queue service
    const queueService = new QueueService({
      queueBinding: env.EVENTS,
      maxRetries: 3,
    });
    
    try {
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
        
        console.log(`Processing batch of ${reminders.length} reminders`);
        
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
          })
        );
        
        // Publish events to the queue
        if (reminderEvents.length > 0) {
          await queueService.publishEvents(reminderEvents);
          console.log(`Published ${reminderEvents.length} reminder events to queue`);
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
      
      console.log(`Scheduled job completed. Processed ${processedCount} reminders.`);
    } catch (error) {
      console.error('Error in scheduled job:', error);
      // Ensure the error is reported to the Cloudflare dashboard
      ctx.waitUntil(Promise.reject(error));
      // Re-throw the error to propagate it to the caller
      throw error;
    }
  },
};