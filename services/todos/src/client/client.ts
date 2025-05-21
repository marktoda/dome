/**
 * Todos Client Implementation
 *
 * A client for interacting with the Todos service using WorkerEntrypoint RPC
 */
import { metrics } from '@dome/common';
import { wrap } from '../utils/wrap';
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
} from '../types';
import { TodosBinding, TodosService } from './types';
export { TodosBinding, TodosService } from './types';

/**
 * Client for interacting with the Todos service
 * Provides methods for managing Todo items
 */
export class TodosClient implements TodosService {

  /**
   * Create a new TodosClient
   * @param binding The Cloudflare Worker binding to the Todos service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'todos.client')
   */
  constructor(
    private readonly binding: TodosBinding,
    private readonly metricsPrefix: string = 'todos.client',
  ) {}

  private async runWithMetrics<T>(
    operation: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startTime = performance.now();
    try {
      const result = await wrap({ operation, ...meta }, fn);
      metrics.increment(`${this.metricsPrefix}.${operation}.success`);
      metrics.timing(
        `${this.metricsPrefix}.${operation}.latency_ms`,
        performance.now() - startTime,
      );
      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.${operation}.error`);
      throw error;
    }
  }

  /**
   * Create a new todo item
   */
  async createTodo(todo: CreateTodoInput): Promise<CreateTodoResult> {
    return this.runWithMetrics('create_todo', { userId: todo.userId }, () =>
      this.binding.createTodo(todo),
    );
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string): Promise<TodoItem | null> {
    return this.runWithMetrics('get_todo', { todoId: id }, () => this.binding.getTodo(id));
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult> {
    return this.runWithMetrics(
      'list_todos',
      { userId: filter.userId },
      () => this.binding.listTodos(filter, pagination),
    );
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput): Promise<UpdateTodoResult> {
    return this.runWithMetrics('update_todo', { todoId: id }, () =>
      this.binding.updateTodo(id, updates),
    );
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string): Promise<DeleteTodoResult> {
    return this.runWithMetrics('delete_todo', { todoId: id }, () =>
      this.binding.deleteTodo(id),
    );
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<BatchUpdateResult> {
    return this.runWithMetrics(
      'batch_update_todos',
      { todoCount: ids.length },
      () => this.binding.batchUpdateTodos(ids, updates),
    );
  }

  /**
   * Get todo statistics for a user
   */
  async stats(userId: string): Promise<TodoStats> {
    return this.runWithMetrics('stats', { userId }, () => this.binding.stats(userId));
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
