import { Event, ReminderDueEvent, IngestionCompleteEvent } from '@dome/common';
import { NotificationService, Notification } from '../services/notificationService';

/**
 * Base event handler interface
 */
export interface EventHandler {
  canHandle(event: Event): boolean;
  handle(event: Event, env: any): Promise<void>;
}

/**
 * Handler for reminder due events
 */
export class ReminderDueEventHandler implements EventHandler {
  private notificationService: NotificationService;

  constructor(notificationService: NotificationService) {
    this.notificationService = notificationService;
  }

  /**
   * Check if this handler can handle the given event
   * @param event The event to check
   * @returns True if this handler can handle the event
   */
  canHandle(event: Event): boolean {
    return event.type === 'reminder_due';
  }

  /**
   * Handle a reminder due event
   * @param event The event to handle
   * @param env Environment bindings
   */
  async handle(event: Event, env: any): Promise<void> {
    const reminderEvent = event as ReminderDueEvent;
    console.log(`Handling reminder due event for task: ${reminderEvent.data.taskId}`);

    try {
      // Create notification from reminder event
      const notification: Notification = {
        userId: reminderEvent.data.userId,
        title: `Reminder: ${reminderEvent.data.title}`,
        message: reminderEvent.data.description || reminderEvent.data.title,
        priority: reminderEvent.data.priority || 'medium',
        metadata: {
          taskId: reminderEvent.data.taskId,
          reminderId: reminderEvent.data.reminderId,
          dueAt: reminderEvent.data.dueAt,
        },
      };

      // Send the notification
      await this.notificationService.sendNotification(notification);

      // Mark the reminder as delivered in the database
      await this.markReminderAsDelivered(reminderEvent.data.reminderId, env.D1_DATABASE);

      console.log(`Reminder notification sent and marked as delivered: ${reminderEvent.data.reminderId}`);
    } catch (error) {
      console.error('Error handling reminder due event:', error);
      throw error;
    }
  }

  /**
   * Mark a reminder as delivered in the database
   * @param reminderId The ID of the reminder to mark as delivered
   * @param db The D1 database instance
   */
  private async markReminderAsDelivered(reminderId: string, db: D1Database): Promise<void> {
    try {
      const query = `
        UPDATE reminders
        SET delivered = 1, delivered_at = datetime('now')
        WHERE id = ?
      `;

      const result = await db.prepare(query).bind(reminderId).run();

      if (!result.success) {
        throw new Error(`Failed to update reminder: ${result.error}`);
      }
    } catch (error) {
      console.error(`Error marking reminder ${reminderId} as delivered:`, error);
      throw error;
    }
  }
}

/**
 * Handler for ingestion complete events
 */
export class IngestionCompleteEventHandler implements EventHandler {
  private notificationService: NotificationService;

  constructor(notificationService: NotificationService) {
    this.notificationService = notificationService;
  }

  /**
   * Check if this handler can handle the given event
   * @param event The event to check
   * @returns True if this handler can handle the event
   */
  canHandle(event: Event): boolean {
    return event.type === 'ingestion_complete';
  }

  /**
   * Handle an ingestion complete event
   * @param event The event to handle
   * @param env Environment bindings
   */
  async handle(event: Event, env: any): Promise<void> {
    const ingestionEvent = event as IngestionCompleteEvent;
    console.log(`Handling ingestion complete event for note: ${ingestionEvent.data.noteId}`);

    try {
      // Create notification from ingestion event
      const notification: Notification = {
        userId: ingestionEvent.data.userId,
        title: 'Content Processing Complete',
        message: `Your content "${ingestionEvent.data.title}" has been processed and is now searchable.`,
        priority: 'low',
        metadata: {
          noteId: ingestionEvent.data.noteId,
          fileType: ingestionEvent.data.fileType,
          fileSize: ingestionEvent.data.fileSize,
        },
      };

      // Send the notification
      await this.notificationService.sendNotification(notification);

      console.log(`Ingestion complete notification sent for note: ${ingestionEvent.data.noteId}`);
    } catch (error) {
      console.error('Error handling ingestion complete event:', error);
      throw error;
    }
  }
}

/**
 * Event handler registry that manages multiple event handlers
 */
export class EventHandlerRegistry {
  private handlers: EventHandler[] = [];

  /**
   * Register an event handler
   * @param handler The event handler to register
   */
  registerHandler(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Get a handler for the given event
   * @param event The event to get a handler for
   * @returns The handler for the event, or undefined if no handler is found
   */
  getHandler(event: Event): EventHandler | undefined {
    return this.handlers.find(handler => handler.canHandle(event));
  }

  /**
   * Handle an event with the appropriate handler
   * @param event The event to handle
   * @param env Environment bindings
   */
  async handleEvent(event: Event, env: any): Promise<void> {
    const handler = this.getHandler(event);

    if (!handler) {
      console.warn(`No handler found for event type: ${event.type}`);
      return;
    }

    await handler.handle(event, env);
  }
}