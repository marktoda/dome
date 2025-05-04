/**
 * Todos Client Implementation
 *
 * A client for interacting with the Todos service using WorkerEntrypoint RPC
 */
import { getLogger, logError, metrics } from '@dome/common';
import {
  TodoItem,
  CreateTodoInput,
  CreateTodoResult,
  UpdateTodoInput,
  UpdateTodoResult,
  DeleteTodoResult,
  TodoFilter,
  Pagination,
  ListTodosResult,
  BatchUpdateInput,
  BatchUpdateResult,
  TodoStats,
  TodosErrorCode,
} from '../types';
import { TodosBinding, TodosService } from './types';
export { TodosBinding, TodosService } from './types';

/**
 * Client for interacting with the Todos service
 * Provides methods for managing Todo items
 */
export class TodosClient implements TodosService {
  private logger = getLogger();

  /**
   * Create a new TodosClient
   * @param binding The Cloudflare Worker binding to the Todos service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'todos.client')
   */
  constructor(
    private readonly binding: TodosBinding,
    private readonly metricsPrefix: string = 'todos.client',
  ) {}

  /**
   * Create a new todo item
   */
  async createTodo(todo: CreateTodoInput): Promise<CreateTodoResult> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'create_todo',
          userId: todo.userId,
          title: todo.title,
        },
        'Creating todo',
      );

      const result = await this.binding.createTodo(todo);

      metrics.increment(`${this.metricsPrefix}.create_todo.success`);
      metrics.timing(`${this.metricsPrefix}.create_todo.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.create_todo.error`);
      this.logger.error('Error creating todo', { error, userId: todo.userId });
      throw error;
    }
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string): Promise<TodoItem | null> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_todo',
          todoId: id,
        },
        'Getting todo',
      );

      const result = await this.binding.getTodo(id);

      metrics.increment(`${this.metricsPrefix}.get_todo.success`);
      metrics.timing(`${this.metricsPrefix}.get_todo.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_todo.error`);
      this.logger.error('Error getting todo', { error, todoId: id });
      throw error;
    }
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'list_todos',
          userId: filter.userId,
          filter,
        },
        'Listing todos',
      );

      const result = await this.binding.listTodos(filter, pagination);

      metrics.increment(`${this.metricsPrefix}.list_todos.success`);
      metrics.timing(`${this.metricsPrefix}.list_todos.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.list_todos.error`);
      this.logger.error('Error listing todos', { error, userId: filter.userId });
      throw error;
    }
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput): Promise<UpdateTodoResult> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'update_todo',
          todoId: id,
          updates,
        },
        'Updating todo',
      );

      const result = await this.binding.updateTodo(id, updates);

      metrics.increment(`${this.metricsPrefix}.update_todo.success`);
      metrics.timing(`${this.metricsPrefix}.update_todo.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.update_todo.error`);
      this.logger.error('Error updating todo', { error, todoId: id });
      throw error;
    }
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string): Promise<DeleteTodoResult> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'delete_todo',
          todoId: id,
        },
        'Deleting todo',
      );

      const result = await this.binding.deleteTodo(id);

      metrics.increment(`${this.metricsPrefix}.delete_todo.success`);
      metrics.timing(`${this.metricsPrefix}.delete_todo.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.delete_todo.error`);
      this.logger.error('Error deleting todo', { error, todoId: id });
      throw error;
    }
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<BatchUpdateResult> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'batch_update_todos',
          todoIds: ids,
          updates,
        },
        'Batch updating todos',
      );

      const result = await this.binding.batchUpdateTodos(ids, updates);

      metrics.increment(`${this.metricsPrefix}.batch_update_todos.success`);
      metrics.timing(
        `${this.metricsPrefix}.batch_update_todos.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.batch_update_todos.error`);
      this.logger.error('Error batch updating todos', { error, todoIds: ids });
      throw error;
    }
  }

  /**
   * Get todo statistics for a user
   */
  async stats(userId: string): Promise<TodoStats> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_todo_stats',
          userId,
        },
        'Getting todo statistics',
      );

      const result = await this.binding.stats(userId);

      metrics.increment(`${this.metricsPrefix}.stats.success`);
      metrics.timing(`${this.metricsPrefix}.stats.latency_ms`, performance.now() - startTime);

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.stats.error`);
      this.logger.error('Error getting todo statistics', { error, userId });
      throw error;
    }
  }
}

/**
 * Create a new TodosClient
 * @param binding The Cloudflare Worker binding to the Todos service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'todos.client')
 * @returns A new TodosClient instance
 */
export function createTodosClient(binding: TodosBinding, metricsPrefix?: string): TodosClient {
  return new TodosClient(binding, metricsPrefix);
}
