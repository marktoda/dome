/**
 * Todos Service – using WorkerEntrypoint pattern
 */
import { BaseWorker, ServiceInfo, getLogger, logError, MessageBatch } from '@dome/common';
import { processTodoQueue } from './queueConsumer';
import { TodosService } from './services/todosService';
import {
  Env,
  TodoQueueItem,
  CreateTodoInput,
  UpdateTodoInput,
  TodoFilter,
  Pagination,
  BatchUpdateInput,
} from './types';

/* ─────────── shared utils ─────────── */

const logger = getLogger();

const buildServices = (env: Env) => ({
  todos: new TodosService(env.DB),
});

/* ─────────── service bootstrap ─────────── */

const serviceInfo: ServiceInfo = {
  name: 'todos',
  version: '0.1.0',
  environment: 'development',
};

logger.info(
  {
    event: 'service_start',
    ...serviceInfo,
  },
  'Starting Todos service',
);

/**
 * Todos Service WorkerEntrypoint implementation
 *
 * This service manages user TODO lists, processing AI-enriched content from notes
 * and providing RPC methods for other services to query and update todos.
 */
export default class Todos extends BaseWorker<Env, ReturnType<typeof buildServices>> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env, buildServices, { serviceName: 'todos' });
  }

  /**
   * Create a new todo item
   */
  async createTodo(todo: CreateTodoInput) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'create_todo', userId: todo.userId, requestId },
      () => this.services.todos.createTodo(todo),
    );
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'get_todo', todoId: id, requestId },
      () => this.services.todos.getTodo(id),
    );
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'list_todos', userId: filter.userId, requestId },
      () => this.services.todos.listTodos(filter, pagination),
    );
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'update_todo', todoId: id, requestId },
      () => this.services.todos.updateTodo(id, updates),
    );
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'delete_todo', todoId: id, requestId },
      () => this.services.todos.deleteTodo(id),
    );
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'batch_update_todos', todoCount: ids.length, requestId },
      () => this.services.todos.batchUpdateTodos(ids, updates),
    );
  }

  /**
   * Get todo statistics for a user
   */
  async stats(userId: string) {
    const requestId = crypto.randomUUID();

    return await this.wrap(
      { operation: 'get_todo_stats', userId, requestId },
      () => this.services.todos.getTodoStats(userId),
    );
  }

  /**
   * Queue handler for processing todo items from various sources
   *
   * This method handles todos that are:
   * 1. Directly sent to the todos queue
   * 2. AI-extracted from notes via the ai-processor service
   */
  async queue(batch: any) {
    const typed = batch as MessageBatch<TodoQueueItem>;
    try {
      await processTodoQueue(typed as any, this.env);

      this.metrics?.counter('queue.processed_batches', 1, {
        queueName: typed.queue || 'unknown',
      });
      this.metrics?.counter('queue.received_messages', typed.messages.length, {
        queueName: typed.queue || 'unknown',
      });
    } catch (error) {
      logError(error, 'Error in queue consumer', {
        queueName: typed.queue,
        messageCount: typed.messages.length,
      });

      this.metrics?.counter('queue.errors', 1, {
        queueName: typed.queue || 'unknown',
      });
    }
  }
}

// Export types for clients
export * from './types';
