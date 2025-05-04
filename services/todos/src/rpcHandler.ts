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

const logger = getLogger();

/**
 * RPC handler for the Todos service
 *
 * Implements the TodosBinding interface to expose methods to other services
 */
export class TodosRPCHandler implements TodosBinding {
  private todosService: TodosService;

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
    try {
      logger.debug('RPC: createTodo', { userId: todo.userId });

      const result = await this.todosService.createTodo(todo);

      logger.debug('RPC: createTodo completed', {
        todoId: result.id,
        userId: todo.userId,
      });

      return result;
    } catch (error) {
      logger.error('RPC: createTodo failed', { error, userId: todo.userId });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string) {
    try {
      logger.debug('RPC: getTodo', { todoId: id });

      const todo = await this.todosService.getTodo(id);

      logger.debug('RPC: getTodo completed', {
        todoId: id,
        found: !!todo,
      });

      return todo;
    } catch (error) {
      logger.error('RPC: getTodo failed', { error, todoId: id });
      throw this.formatRPCError(error);
    }
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination) {
    try {
      logger.debug('RPC: listTodos', { filter });

      const result = await this.todosService.listTodos(filter, pagination);

      logger.debug('RPC: listTodos completed', {
        userId: filter.userId,
        count: result.items.length,
      });

      return result;
    } catch (error) {
      logger.error('RPC: listTodos failed', { error, filter });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput) {
    try {
      logger.debug('RPC: updateTodo', { todoId: id });

      const result = await this.todosService.updateTodo(id, updates);

      logger.debug('RPC: updateTodo completed', {
        todoId: id,
        success: result.success,
      });

      return result;
    } catch (error) {
      logger.error('RPC: updateTodo failed', { error, todoId: id });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string) {
    try {
      logger.debug('RPC: deleteTodo', { todoId: id });

      const result = await this.todosService.deleteTodo(id);

      logger.debug('RPC: deleteTodo completed', {
        todoId: id,
        success: result.success,
      });

      return result;
    } catch (error) {
      logger.error('RPC: deleteTodo failed', { error, todoId: id });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput) {
    try {
      logger.debug('RPC: batchUpdateTodos', {
        todoCount: ids.length,
      });

      const result = await this.todosService.batchUpdateTodos(ids, updates);

      logger.debug('RPC: batchUpdateTodos completed', {
        todoCount: ids.length,
        updatedCount: result.updatedCount,
      });

      return result;
    } catch (error) {
      logger.error('RPC: batchUpdateTodos failed', { error, todoIds: ids });
      throw this.formatRPCError(error);
    }
  }

  /**
   * Get todo statistics for a user
   */
  async stats(userId: string) {
    try {
      logger.debug('RPC: stats', { userId });

      const stats = await this.todosService.getTodoStats(userId);

      logger.debug('RPC: stats completed', {
        userId,
        totalCount: stats.totalCount,
      });

      return stats;
    } catch (error) {
      logger.error('RPC: stats failed', { error, userId });
      throw this.formatRPCError(error);
    }
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
