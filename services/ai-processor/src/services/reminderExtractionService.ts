import { getLogger } from '@dome/logging';
import { ValidationError } from '../utils/errors';
import { ReminderStatus, ReminderPriority, NotificationChannel } from '../types';

/**
 * Service for extracting reminders from content and sending them to the queue
 */
export class ReminderExtractionService {
  private readonly REMINDER_QUEUE: Queue<ReminderQueueMessage>;

  constructor(env: Env) {
    this.REMINDER_QUEUE = env.REMINDER_QUEUE;
  }

  /**
   * Process content for reminders and send them to the queue
   * @param content The content to process
   * @param userId The ID of the user who owns the content
   * @returns Object containing count of queued reminders and any errors
   */
  async processContentForReminders(content: { id: string; text: string }, userId: string) {
    // Extract reminders using existing logic
    const extractedReminders = await this.extractRemindersFromContent(content);
    
    if (extractedReminders.length === 0) {
      return { count: 0 };
    }
    
    // Format reminders with required fields
    const formattedReminders = extractedReminders.map(reminder => ({
      ...reminder,
      userId,
      sourceContentId: content.id,
      createdAt: new Date().toISOString(),
      status: ReminderStatus.PENDING,
      notificationChannels: reminder.notificationChannels || [NotificationChannel.IN_APP],
      priority: reminder.priority || ReminderPriority.MEDIUM,
      metadata: reminder.metadata || {}
    }));
    
    // Send to reminder queue
    const queueResults = await this.sendRemindersToQueue(formattedReminders);
    
    // Return results
    return {
      count: queueResults.successCount,
      errors: queueResults.errors
    };
  }

  /**
   * Extract reminders from content using NLP techniques
   * @param content The content to process
   * @returns Array of extracted reminders
   */
  async extractRemindersFromContent(content: { id: string; text: string }): Promise<Partial<Reminder>[]> {
    try {
      const reminders: Partial<Reminder>[] = [];
      const text = content.text;
      
      // Simple regex patterns for reminder extraction
      // In a production system, this would be replaced with more sophisticated NLP
      const reminderPatterns = [
        // "Remind me to X on/at Y" pattern
        /remind\s+me\s+to\s+([^.!?]+)(?:\s+on\s+([^.!?]+)|at\s+([^.!?]+)|by\s+([^.!?]+))?/gi,
        
        // "X due on/at Y" pattern
        /([^.!?]+)\s+due\s+(?:on|at|by)\s+([^.!?]+)/gi,
        
        // "X deadline is Y" pattern
        /([^.!?]+)\s+deadline\s+is\s+([^.!?]+)/gi
      ];
      
      for (const pattern of reminderPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const title = match[1]?.trim();
          const dateText = match[2] || match[3] || match[4];
          
          if (title) {
            try {
              // Parse the date text to get a due date
              const dueAt = this.parseDateText(dateText);
              
              // Create a reminder object
              reminders.push({
                id: `reminder-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                title,
                dueAt: dueAt.toISOString(),
                priority: this.determinePriority(title, text)
              });
            } catch (error) {
              getLogger().warn(
                { error: error instanceof Error ? error.message : String(error) },
                `Failed to parse date for reminder: ${title}`
              );
            }
          }
        }
      }
      
      return reminders;
    } catch (error) {
      getLogger().error(
        { error: error instanceof Error ? error.message : String(error), contentId: content.id },
        'Failed to extract reminders from content'
      );
      return [];
    }
  }

  /**
   * Parse date text into a Date object
   * @param dateText The text to parse
   * @returns Date object
   */
  private parseDateText(dateText?: string): Date {
    if (!dateText) {
      // Default to tomorrow if no date is specified
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0); // 9 AM
      return tomorrow;
    }
    
    const now = new Date();
    const lowerDateText = dateText.toLowerCase();
    
    // Handle relative dates
    if (lowerDateText.includes('tomorrow')) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Check for time
      if (lowerDateText.includes('at')) {
        const timeMatch = lowerDateText.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1], 10);
          const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          const ampm = timeMatch[3]?.toLowerCase();
          
          if (ampm === 'pm' && hours < 12) hours += 12;
          if (ampm === 'am' && hours === 12) hours = 0;
          
          tomorrow.setHours(hours, minutes, 0, 0);
        } else {
          tomorrow.setHours(9, 0, 0, 0); // Default to 9 AM
        }
      } else {
        tomorrow.setHours(9, 0, 0, 0); // Default to 9 AM
      }
      
      return tomorrow;
    }
    
    if (lowerDateText.includes('today')) {
      const today = new Date();
      
      // Check for time
      if (lowerDateText.includes('at')) {
        const timeMatch = lowerDateText.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1], 10);
          const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          const ampm = timeMatch[3]?.toLowerCase();
          
          if (ampm === 'pm' && hours < 12) hours += 12;
          if (ampm === 'am' && hours === 12) hours = 0;
          
          today.setHours(hours, minutes, 0, 0);
        } else {
          today.setHours(17, 0, 0, 0); // Default to 5 PM
        }
      } else {
        today.setHours(17, 0, 0, 0); // Default to 5 PM
      }
      
      return today;
    }
    
    // Handle day of week
    const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < daysOfWeek.length; i++) {
      if (lowerDateText.includes(daysOfWeek[i])) {
        const targetDay = i;
        const currentDay = now.getDay();
        let daysToAdd = targetDay - currentDay;
        if (daysToAdd <= 0) daysToAdd += 7; // Next week if day has passed
        
        const date = new Date();
        date.setDate(date.getDate() + daysToAdd);
        
        // Check for time
        if (lowerDateText.includes('at')) {
          const timeMatch = lowerDateText.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
          if (timeMatch) {
            let hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            const ampm = timeMatch[3]?.toLowerCase();
            
            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;
            
            date.setHours(hours, minutes, 0, 0);
          } else {
            date.setHours(9, 0, 0, 0); // Default to 9 AM
          }
        } else {
          date.setHours(9, 0, 0, 0); // Default to 9 AM
        }
        
        return date;
      }
    }
    
    // Try to parse as absolute date
    try {
      const date = new Date(dateText);
      if (!isNaN(date.getTime())) {
        return date;
      }
    } catch (e) {
      // Ignore parsing errors and continue with other methods
    }
    
    // Default to tomorrow if we couldn't parse the date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0); // 9 AM
    return tomorrow;
  }

  /**
   * Determine priority based on content
   * @param title Reminder title
   * @param text Full content text
   * @returns Priority level
   */
  private determinePriority(title: string, text: string): ReminderPriority {
    const lowerTitle = title.toLowerCase();
    const lowerText = text.toLowerCase();
    
    // Check for urgent keywords
    if (
      lowerTitle.includes('urgent') || 
      lowerTitle.includes('asap') || 
      lowerTitle.includes('immediately') ||
      lowerText.includes('urgent') && lowerText.includes(lowerTitle)
    ) {
      return ReminderPriority.URGENT;
    }
    
    // Check for high priority keywords
    if (
      lowerTitle.includes('important') || 
      lowerTitle.includes('critical') ||
      lowerText.includes('important') && lowerText.includes(lowerTitle)
    ) {
      return ReminderPriority.HIGH;
    }
    
    // Check for low priority keywords
    if (
      lowerTitle.includes('maybe') || 
      lowerTitle.includes('if possible') ||
      lowerTitle.includes('when you have time')
    ) {
      return ReminderPriority.LOW;
    }
    
    // Default to medium priority
    return ReminderPriority.MEDIUM;
  }

  /**
   * Send reminders to the queue
   * @param reminders Array of reminder objects
   * @returns Object containing success count and errors
   */
  async sendRemindersToQueue(reminders: Reminder[]) {
    const results = {
      successCount: 0,
      errors: [] as { reminder: Reminder; error: { type: string; message: string } }[]
    };
    
    for (const reminder of reminders) {
      try {
        // Validate reminder
        this.validateReminder(reminder);
        
        // Create queue message
        const message: ReminderQueueMessage = {
          messageId: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          reminderData: reminder,
          attempts: 0,
          timestamp: new Date().toISOString(),
          priority: this.getPriorityValue(reminder.priority),
          metadata: {}
        };
        
        // Send to queue
        await this.REMINDER_QUEUE.send(message);
        results.successCount++;
      } catch (error) {
        results.errors.push({
          reminder,
          error: {
            type: this.determineErrorType(error),
            message: error instanceof Error ? error.message : String(error)
          }
        });
        getLogger().error('Failed to queue reminder', { reminder, error });
      }
    }
    
    return results;
  }

  /**
   * Validate reminder data
   * @param reminder The reminder to validate
   * @throws ValidationError if validation fails
   */
  validateReminder(reminder: Reminder) {
    // Check required fields
    if (!reminder.title) {
      throw new ValidationError('Title is required');
    }
    
    if (!reminder.dueAt) {
      throw new ValidationError('Due date is required');
    }
    
    // Validate due date is in the future
    const dueDate = new Date(reminder.dueAt);
    if (isNaN(dueDate.getTime())) {
      throw new ValidationError('Invalid due date format');
    }
    
    if (dueDate <= new Date()) {
      throw new ValidationError('Due date must be in the future');
    }
    
    // Validate priority
    if (reminder.priority && !Object.values(ReminderPriority).includes(reminder.priority)) {
      throw new ValidationError('Invalid priority value');
    }
    
    // Validate notification channels
    if (reminder.notificationChannels && 
        !Array.isArray(reminder.notificationChannels)) {
      throw new ValidationError('Notification channels must be an array');
    }
    
    if (reminder.notificationChannels && 
        !reminder.notificationChannels.every(channel => 
          Object.values(NotificationChannel).includes(channel))) {
      throw new ValidationError('Invalid notification channel');
    }
    
    // Validate recurrence pattern if present
    if (reminder.recurrence) {
      this.validateRecurrencePattern(reminder.recurrence);
    }
  }

  /**
   * Validate recurrence pattern
   * @param recurrence The recurrence pattern to validate
   * @throws ValidationError if validation fails
   */
  private validateRecurrencePattern(recurrence: RecurrencePattern) {
    const validTypes = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
    
    if (!validTypes.includes(recurrence.type)) {
      throw new ValidationError('Invalid recurrence type');
    }
    
    if (typeof recurrence.interval !== 'number' || recurrence.interval <= 0) {
      throw new ValidationError('Recurrence interval must be a positive number');
    }
    
    if (recurrence.endAfter !== undefined && (typeof recurrence.endAfter !== 'number' || recurrence.endAfter <= 0)) {
      throw new ValidationError('End after must be a positive number');
    }
    
    if (recurrence.endDate !== undefined) {
      const endDate = new Date(recurrence.endDate);
      if (isNaN(endDate.getTime())) {
        throw new ValidationError('Invalid end date format');
      }
    }
    
    // Type-specific validations
    if (recurrence.type === 'weekly' && (!recurrence.daysOfWeek || !Array.isArray(recurrence.daysOfWeek))) {
      throw new ValidationError('Days of week are required for weekly recurrence');
    }
    
    if (recurrence.type === 'monthly' && (recurrence.dayOfMonth === undefined || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31)) {
      throw new ValidationError('Day of month must be between 1 and 31 for monthly recurrence');
    }
    
    if (recurrence.type === 'yearly' && (recurrence.monthOfYear === undefined || recurrence.monthOfYear < 1 || recurrence.monthOfYear > 12)) {
      throw new ValidationError('Month of year must be between 1 and 12 for yearly recurrence');
    }
    
    if (recurrence.type === 'custom' && !recurrence.customExpression) {
      throw new ValidationError('Custom expression is required for custom recurrence');
    }
  }

  /**
   * Get numeric priority value from string priority
   * @param priority The priority string
   * @returns Numeric priority value
   */
  private getPriorityValue(priority: ReminderPriority): number {
    switch (priority) {
      case ReminderPriority.LOW: return 0;
      case ReminderPriority.MEDIUM: return 1;
      case ReminderPriority.HIGH: return 2;
      case ReminderPriority.URGENT: return 3;
      default: return 1; // Default to medium
    }
  }

  /**
   * Determine error type from error object
   * @param error The error object
   * @returns Error type string
   */
  private determineErrorType(error: unknown): string {
    if (error instanceof ValidationError) {
      return 'validation_error';
    } else if (error instanceof Error && error.name === 'QueueError') {
      return 'queue_error';
    } else {
      return 'internal_error';
    }
  }
}

/**
 * Create a new reminder extraction service
 * @param env Environment bindings
 * @returns A new reminder extraction service instance
 */
export function createReminderExtractionService(env: Env): ReminderExtractionService {
  return new ReminderExtractionService(env);
}