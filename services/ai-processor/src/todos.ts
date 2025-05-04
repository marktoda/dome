/**
 * Integration with the Todos service
 *
 * This module handles sending extracted todos to the Todos service queue
 */
import { getLogger, trackOperation } from './utils/logging';
import { TodoQueueItem } from '@dome/todos/client';
import { PUBLIC_USER_ID, EnrichedContentMessage } from '@dome/common';
import { toDomeError } from './utils/errors';

const logger = getLogger();

/**
 * Convert AI-extracted todos into TodoQueueItem format
 * and send them to the todos queue
 *
 * @param conent Enriched content message
 * @param queue Queue binding
 * @returns Result of sending to the queue
 */
export async function sendTodosToQueue(
  content: EnrichedContentMessage,
  queue: Queue<TodoQueueItem>,
): Promise<void> {
  const todos = content.metadata.todos;
  if (!content.userId || content.userId === PUBLIC_USER_ID) {
    logger.debug(
      { contentId: content.id },
      'No user ID found for content, skipping todo processing',
    );
    return;
  }
  if (!Array.isArray(todos) || todos.length === 0) {
    logger.debug({ contentId: content.id, userId: content.userId }, 'No todos to send to queue');
    return;
  }

  const userId = content.userId;
  const contentId = content.id;

  return trackOperation(
    'send_todos_to_queue',
    async () => {
      try {
        // Convert AI-extracted todos to TodoQueueItem format
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

        logger.info(
          {
            contentId,
            userId,
            todoCount: todoItems.length,
            todoItems,
          },
          'Sending todos to queue',
        );

        // Send each todo to the queue
        for (const item of todoItems) {
          await queue.send(item);
        }

        logger.info(
          {
            contentId,
            userId,
            todoCount: todoItems.length,
          },
          'Successfully sent todos to queue',
        );
      } catch (error) {
        const domeError = toDomeError(error, 'Failed to send todos to queue', {
          contentId,
          userId,
          todoCount: todos.length,
        });

        logger.error(
          {
            error: domeError,
            contentId,
            userId,
          },
          'Error sending todos to queue',
        );

        throw domeError;
      }
    },
    { contentId, userId, todoCount: todos.length },
  );
}
