/**
 * Todos Service – using WorkerEntrypoint pattern
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ServiceInfo } from '@dome/common';
import {
  getLogger,
  logError,
  trackOperation,
  createServiceMetrics
} from '@dome/common';
import { processTodoQueue } from './queueConsumer';
import { TodosService } from './services/todosService';
import { Env, TodoQueueItem, CreateTodoInput, UpdateTodoInput, TodoFilter, Pagination, BatchUpdateInput } from './types';

/* ─────────── shared utils ─────────── */

const logger = getLogger();
const metrics = createServiceMetrics('todos');

const buildServices = (env: Env) => ({
  todos: new TodosService(env.DB)
});

/* ─────────── service bootstrap ─────────── */

const serviceInfo: ServiceInfo = {
  name: 'todos',
  version: '0.1.0',
  environment: 'development'
};

logger.info({
  event: 'service_start',
  ...serviceInfo
}, 'Starting Todos service');

/**
 * Todos Service WorkerEntrypoint implementation
 *
 * This service manages user TODO lists, processing AI-enriched content from notes
 * and providing RPC methods for other services to query and update todos.
 */
export default class Todos extends WorkerEntrypoint<Env> {
  /** Lazily created bundle of service clients (re‑used for every call) */
  private _services?: ReturnType<typeof buildServices>;
  private get services() {
    return (this._services ??= buildServices(this.env));
  }

  /**
   * Create a new todo item
   */
  async createTodo(todo: CreateTodoInput) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'create_todo',
      () => this.services.todos.createTodo(todo),
      { userId: todo.userId, requestId }
    );
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'get_todo',
      () => this.services.todos.getTodo(id),
      { todoId: id, requestId }
    );
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'list_todos',
      () => this.services.todos.listTodos(filter, pagination),
      { userId: filter.userId, requestId }
    );
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'update_todo',
      () => this.services.todos.updateTodo(id, updates),
      { todoId: id, requestId }
    );
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'delete_todo',
      () => this.services.todos.deleteTodo(id),
      { todoId: id, requestId }
    );
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'batch_update_todos',
      () => this.services.todos.batchUpdateTodos(ids, updates),
      { todoCount: ids.length, requestId }
    );
  }

  /**
   * Get todo statistics for a user
   */
  async stats(userId: string) {
    const requestId = crypto.randomUUID();

    return await trackOperation(
      'get_todo_stats',
      () => this.services.todos.getTodoStats(userId),
      { userId, requestId }
    );
  }

  /**
   * Queue handler for processing todo items from various sources
   *
   * This method handles todos that are:
   * 1. Directly sent to the todos queue
   * 2. AI-extracted from notes via the ai-processor service
   */
  async queue(batch: MessageBatch<TodoQueueItem>) {
    try {
      await processTodoQueue(batch, this.env);

      metrics.counter('todos.queue.processed_batches', 1, {
        queueName: batch.queue || 'unknown'
      });
      metrics.counter('todos.queue.received_messages', batch.messages.length, {
        queueName: batch.queue || 'unknown'
      });
    } catch (error) {
      logger.error('Error in queue consumer:', {
        error,
        queueName: batch.queue,
        messageCount: batch.messages.length
      });

      metrics.counter('todos.queue.errors', 1, {
        queueName: batch.queue || 'unknown'
      });
    }
  }
}

// Export types for clients
export * from './types';
