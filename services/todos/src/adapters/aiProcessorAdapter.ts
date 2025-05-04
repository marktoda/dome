import { TodoJob, TodoPriority } from '../types';
import { TodoQueueItem } from '../client';

/**
 * Interface representing a todo extracted by the AI Processor
 */
export interface AiExtractedTodo {
  text: string;
  dueDate?: string;
  priority?: string;
  location?: string;
}

/**
 * Adapter to transform between different todo formats
 */
export class AiProcessorAdapter {
  /**
   * Transform raw todos from AI Processor into TodoJob objects for internal processing
   *
   * @param rawTodos Array of todos extracted by AI
   * @param sourceNoteId ID of the source note
   * @param userId ID of the user
   * @returns Array of TodoJob objects
   */
  static transformTodos(
    rawTodos: Array<AiExtractedTodo>,
    sourceNoteId: string,
    userId: string,
  ): TodoJob[] {
    if (!Array.isArray(rawTodos) || rawTodos.length === 0) {
      return [];
    }

    return rawTodos.map(todo => {
      const now = Date.now();

      // Convert string date formats to timestamps if present
      let dueDateTimestamp: number | undefined = undefined;
      if (todo.dueDate) {
        const parsedDate = new Date(todo.dueDate);
        if (!isNaN(parsedDate.getTime())) {
          dueDateTimestamp = parsedDate.getTime();
        }
      }

      // Map priority string to enum value
      let priority: TodoPriority | undefined = undefined;
      if (todo.priority) {
        const priorityLower = todo.priority.toLowerCase();
        switch (priorityLower) {
          case 'high':
            priority = TodoPriority.HIGH;
            break;
          case 'medium':
            priority = TodoPriority.MEDIUM;
            break;
          case 'low':
            priority = TodoPriority.LOW;
            break;
          case 'urgent':
            priority = TodoPriority.URGENT;
            break;
          default:
            priority = TodoPriority.MEDIUM;
        }
      }

      // Create TodoJob
      return {
        userId,
        sourceNoteId,
        sourceText: todo.text,
        title: todo.text.slice(0, Math.min(todo.text.length, 100)), // Use the text as title, truncated if needed
        created: now,
        version: 1,
        aiSuggestions: {
          priority,
          dueDate: dueDateTimestamp,
        },
      };
    });
  }

  /**
   * Transform raw todos directly into TodoQueueItem format
   * for sending to the queue by the AI Processor
   *
   * @param rawTodos Array of todos extracted by AI
   * @param sourceNoteId ID of the source note
   * @param userId ID of the user
   * @returns Array of TodoQueueItem objects
   */
  static transformToQueueItems(
    rawTodos: Array<AiExtractedTodo>,
    sourceNoteId: string,
    userId: string,
  ): TodoQueueItem[] {
    if (!Array.isArray(rawTodos) || rawTodos.length === 0) {
      return [];
    }

    return rawTodos.map(todo => {
      // Map priority string to enum value if possible
      let priority: TodoPriority | undefined = undefined;
      if (todo.priority) {
        const priorityLower = todo.priority.toLowerCase();
        switch (priorityLower) {
          case 'high':
            priority = TodoPriority.HIGH;
            break;
          case 'medium':
            priority = TodoPriority.MEDIUM;
            break;
          case 'low':
            priority = TodoPriority.LOW;
            break;
          case 'urgent':
            priority = TodoPriority.URGENT;
            break;
          default:
            // Keep the original string if it doesn't match known values
            priority = priorityLower as any;
        }
      }

      // Create TodoQueueItem - matches the shared format
      return {
        userId,
        sourceNoteId,
        sourceText: todo.text,
        title: todo.text.slice(0, Math.min(todo.text.length, 100)), // Use the text as title, truncated if needed
        priority,
        dueDate: todo.dueDate,
        created: Date.now(),
      };
    });
  }

  /**
   * Transform a TodoQueueItem into a TodoJob
   *
   * @param item The queue item from the queue
   * @returns A TodoJob object
   */
  static queueItemToJob(item: TodoQueueItem): TodoJob {
    // Process the priority
    let priority: TodoPriority | undefined = undefined;
    if (item.priority) {
      if (typeof item.priority === 'string') {
        const priorityLower = item.priority.toLowerCase();
        switch (priorityLower) {
          case 'high':
            priority = TodoPriority.HIGH;
            break;
          case 'medium':
            priority = TodoPriority.MEDIUM;
            break;
          case 'low':
            priority = TodoPriority.LOW;
            break;
          case 'urgent':
            priority = TodoPriority.URGENT;
            break;
          default:
            priority = TodoPriority.MEDIUM;
        }
      } else {
        // It's already a TodoPriority enum
        priority = item.priority as TodoPriority;
      }
    }

    // Process the due date
    let dueDate: number | undefined = undefined;
    if (item.dueDate) {
      if (typeof item.dueDate === 'string') {
        const parsedDate = new Date(item.dueDate);
        if (!isNaN(parsedDate.getTime())) {
          dueDate = parsedDate.getTime();
        }
      } else {
        // It's already a timestamp
        dueDate = item.dueDate;
      }
    }

    // Create the TodoJob
    return {
      userId: item.userId,
      sourceNoteId: item.sourceNoteId,
      sourceText: item.sourceText,
      title: item.title,
      description: item.description,
      created: item.created || Date.now(),
      version: 1,
      aiSuggestions: {
        priority,
        dueDate,
        estimatedEffort: item.estimatedEffort,
        actionableSteps: item.actionableSteps,
        category: item.category,
      },
    };
  }
}
