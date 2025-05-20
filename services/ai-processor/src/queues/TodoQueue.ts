import { AbstractQueue } from '@dome/common/queue';
import { PUBLIC_USER_ID, EnrichedContentMessage } from '@dome/common';
import { TodoQueueItem, TodoQueueItemSchema } from '@dome/todos/client';
import { getLogger } from '../utils/logging';

const logger = getLogger();

export type { TodoQueueItem };

export class TodoQueue extends AbstractQueue<typeof TodoQueueItemSchema> {
  static override schema = TodoQueueItemSchema;

  /**
   * Convert todos in an EnrichedContentMessage and send them to the queue.
   */
  async dispatchFromEnriched(content: EnrichedContentMessage): Promise<void> {
    const todos = content.metadata.todos;
    if (!content.userId || content.userId === PUBLIC_USER_ID) {
      logger.debug(
        { contentId: content.id },
        'No user ID found for content, skipping todo processing',
      );
      return;
    }

    if (!Array.isArray(todos) || todos.length === 0) {
      logger.debug(
        { contentId: content.id, userId: content.userId },
        'No todos to send to queue',
      );
      return;
    }

    const userId = content.userId;
    const contentId = content.id;

    const todoItems: TodoQueueItem[] = todos.map(todo => ({
      userId,
      sourceNoteId: contentId,
      sourceText: content.metadata.summary || content.metadata.title || todo.text,
      description: todo.text,
      title: todo.text.slice(0, Math.min(todo.text.length, 100)),
      priority: todo.priority,
      dueDate: todo.dueDate,
      created: Date.now(),
    }));

    for (const item of todoItems) {
      await this.send(item);
    }
  }
}
