/**
 * Todos Service Client
 * 
 * This client allows other services to interact with the Todos service
 * and provides shared types for consistent data exchange.
 */
import { 
  TodoItem,
  TodoStatus,
  TodoPriority,
  CreateTodoInput,
  UpdateTodoInput,
  TodoFilter,
  Pagination,
  ListTodosResult,
  BatchUpdateInput,
  TodoStats
} from '../types';
import { getLogger } from '@dome/logging';
import { createServiceMetrics } from '@dome/logging';

export {
  TodoItem,
  TodoStatus,
  TodoPriority,
  CreateTodoInput,
  UpdateTodoInput,
  TodoFilter,
  Pagination,
  ListTodosResult,
  BatchUpdateInput,
  TodoStats
};

// Export TodoQueueItem type for use by services that send todos to the queue
export interface TodoQueueItem {
  // Required fields
  userId: string;        // User who owns the todo
  sourceNoteId: string;  // ID of the note/content this todo was extracted from
  sourceText: string;    // Original text snippet from which the todo was extracted
  
  // AI-enriched content
  title: string;         // Short title/summary
  description?: string;  // Detailed description (optional)
  
  // Metadata suggestions
  priority?: TodoPriority | string;  // Suggested priority
  dueDate?: string | number;         // Suggested due date (string date or timestamp)
  estimatedEffort?: string;          // Suggested effort (e.g., "5min", "1h")
  actionableSteps?: string[];        // Suggested breakdown of steps
  category?: string;                 // Suggested category
  
  // Processing metadata 
  created?: number;      // When this item was created (timestamp)
}

// Logger for the client
const logger = getLogger();
const metrics = createServiceMetrics('todos.client');

/**
 * Create a client for interacting with the Todos service
 * 
 * @param binding The Cloudflare Worker binding to the Todos service
 * @param metricsPrefix Optional prefix for metrics
 * @returns A client for the Todos service
 */
export function createTodosClient(
  binding: TodosWorkerBinding,
  metricsPrefix = 'todos.client'
): TodosBinding {
  const client: TodosBinding = {
    createTodo: async (todo: CreateTodoInput) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.createTodo.duration_ms`);
        const result = await binding.createTodo(todo);
        timer.stop();
        metrics.counter(`${metricsPrefix}.createTodo.success`, 1);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.createTodo.error`, 1);
        logger.error({ error, todo }, 'Error creating todo');
        throw error;
      }
    },

    getTodo: async (id: string) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.getTodo.duration_ms`);
        const result = await binding.getTodo(id);
        timer.stop();
        metrics.counter(`${metricsPrefix}.getTodo.success`, 1);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.getTodo.error`, 1);
        logger.error({ error, id }, 'Error getting todo');
        throw error;
      }
    },

    listTodos: async (filter: TodoFilter, pagination?: Pagination) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.listTodos.duration_ms`);
        const result = await binding.listTodos(filter, pagination);
        timer.stop();
        metrics.counter(`${metricsPrefix}.listTodos.success`, 1);
        metrics.gauge(`${metricsPrefix}.listTodos.count`, result.items.length);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.listTodos.error`, 1);
        logger.error({ error, filter }, 'Error listing todos');
        throw error;
      }
    },

    updateTodo: async (id: string, updates: UpdateTodoInput) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.updateTodo.duration_ms`);
        const result = await binding.updateTodo(id, updates);
        timer.stop();
        metrics.counter(`${metricsPrefix}.updateTodo.success`, 1);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.updateTodo.error`, 1);
        logger.error({ error, id }, 'Error updating todo');
        throw error;
      }
    },

    deleteTodo: async (id: string) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.deleteTodo.duration_ms`);
        const result = await binding.deleteTodo(id);
        timer.stop();
        metrics.counter(`${metricsPrefix}.deleteTodo.success`, 1);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.deleteTodo.error`, 1);
        logger.error({ error, id }, 'Error deleting todo');
        throw error;
      }
    },

    batchUpdateTodos: async (ids: string[], updates: BatchUpdateInput) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.batchUpdateTodos.duration_ms`);
        const result = await binding.batchUpdateTodos(ids, updates);
        timer.stop();
        metrics.counter(`${metricsPrefix}.batchUpdateTodos.success`, 1);
        metrics.gauge(`${metricsPrefix}.batchUpdateTodos.count`, ids.length);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.batchUpdateTodos.error`, 1);
        logger.error({ error, ids }, 'Error batch updating todos');
        throw error;
      }
    },

    stats: async (userId: string) => {
      try {
        const timer = metrics.startTimer(`${metricsPrefix}.stats.duration_ms`);
        const result = await binding.stats(userId);
        timer.stop();
        metrics.counter(`${metricsPrefix}.stats.success`, 1);
        return result;
      } catch (error) {
        metrics.counter(`${metricsPrefix}.stats.error`, 1);
        logger.error({ error, userId }, 'Error getting todo stats');
        throw error;
      }
    },
  };

  return client;
}

/**
 * Helper function to send todos to the queue in the correct format
 * 
 * @param queue The queue binding
 * @param todos The todos to send
 * @param metadata Additional metadata for the todos
 * @returns The result of sending to the queue
 */
export async function sendTodosToQueue(
  queue: Queue<TodoQueueItem>,
  todos: TodoQueueItem | TodoQueueItem[],
  metadata: Record<string, any> = {}
): Promise<void> {
  const todosArray = Array.isArray(todos) ? todos : [todos];
  
  // Ensure each todo has required fields
  todosArray.forEach(todo => {
    if (!todo.userId) {
      throw new Error('Todo must have a userId');
    }
    if (!todo.sourceNoteId) {
      throw new Error('Todo must have a sourceNoteId');
    }
    if (!todo.sourceText) {
      throw new Error('Todo must have sourceText');
    }
    if (!todo.title) {
      throw new Error('Todo must have a title');
    }
    
    // Set created timestamp if not provided
    if (!todo.created) {
      todo.created = Date.now();
    }
  });

  try {
    // Send each todo individually since queue.send doesn't support arrays
    for (const todo of todosArray) {
      await queue.send(todo);
    }
    
    logger.info({
      count: todosArray.length,
      ...metadata
    }, 'Sent todos to queue');
  } catch (error) {
    logger.error({
      error,
      count: todosArray.length,
      ...metadata
    }, 'Error sending todos to queue');
    throw error;
  }
}

// Types used for binding to the Todos service
export interface TodosBinding {
  createTodo(todo: CreateTodoInput): Promise<{ id: string; success: boolean }>;
  getTodo(id: string): Promise<TodoItem | null>;
  listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult>;
  updateTodo(id: string, updates: UpdateTodoInput): Promise<{ success: boolean }>;
  deleteTodo(id: string): Promise<{ success: boolean }>;
  batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<{ success: boolean; updatedCount: number }>;
  stats(userId: string): Promise<TodoStats>;
}

export interface TodosWorkerBinding {
  createTodo(todo: CreateTodoInput): Promise<{ id: string; success: boolean }>;
  getTodo(id: string): Promise<TodoItem | null>;
  listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult>;
  updateTodo(id: string, updates: UpdateTodoInput): Promise<{ success: boolean }>;
  deleteTodo(id: string): Promise<{ success: boolean }>;
  batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<{ success: boolean; updatedCount: number }>;
  stats(userId: string): Promise<TodoStats>;
}
