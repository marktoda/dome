import {
  TodosBinding,
  CreateTodoInput,
  UpdateTodoInput,
  TodoFilter,
  Pagination,
  BatchUpdateInput,
  TodosErrorCode,
  Env,
} from './types';
import { TodosService } from './services/todosService';
import { getLogger } from '@dome/common';
import { wrap } from './utils/wrap';

const logger = getLogger();

/**
 * RPC handler for the Todos service
 *
 * Implements the TodosBinding interface to expose methods to other services
 */
export class TodosRPCHandler implements TodosBinding {
  private todosService: TodosService;
  private async run<T>(
    operation: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await wrap({ operation, ...meta }, fn);
    } catch (error) {
      throw this.formatRPCError(error);
    }
  }

  constructor(private readonly env: Env) {
    // Ensure DB binding exists
    if (!env.DB) {
      logger.error('Missing DB binding in environment');
      throw new Error('Missing DB binding. Check wrangler.toml configuration.');
    }

    // Initialize service with DB binding
    this.todosService = new TodosService(env.DB);
    logger.info('Todos RPC Handler initialized');
  }

  /**
   * Create a new todo
   */
  async createTodo(todo: CreateTodoInput) {
    return this.run('create_todo', { userId: todo.userId }, () =>
      this.todosService.createTodo(todo),
    );
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string) {
    return this.run('get_todo', { todoId: id }, () =>
      this.todosService.getTodo(id),
    );
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination) {
    return this.run('list_todos', { userId: filter.userId }, () =>
      this.todosService.listTodos(filter, pagination),
    );
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput) {
    return this.run('update_todo', { todoId: id }, () =>
      this.todosService.updateTodo(id, updates),
    );
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string) {
    return this.run('delete_todo', { todoId: id }, () =>
      this.todosService.deleteTodo(id),
    );
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput) {
    return this.run('batch_update_todos', { todoCount: ids.length }, () =>
      this.todosService.batchUpdateTodos(ids, updates),
    );
  }

  /**
   * Get todo statistics for a user
   */
  async stats(userId: string) {
    return this.run('stats', { userId }, () =>
      this.todosService.getTodoStats(userId),
    );
  }

  /**
   * Format an error for RPC response
   */
  private formatRPCError(error: any): Error {
    // Extract code and message if available
    const code = (error as any).code || TodosErrorCode.INTERNAL_ERROR;
    const message = error.message || 'An unknown error occurred';

    // Create a standardized error response
    const formattedError = {
      error: {
        code,
        message,
        details: (error as any).details,
      },
    };

    // Convert to a real Error object for proper throwing
    const rpcError = new Error(JSON.stringify(formattedError));

    return rpcError;
  }
}
