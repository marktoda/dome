// Using crypto.randomUUID() instead of nanoid for better compatibility
import {
  TodoItem,
  CreateTodoInput,
  UpdateTodoInput,
  TodoFilter,
  Pagination,
  BatchUpdateInput,
  TodoStats,
  TodosErrorCode,
  TodoJob,
} from '../types';
import { TodosRepository } from '../db/todosRepository';
import { getLogger } from '@dome/common';

const logger = getLogger();

/**
 * Service for handling todo business logic
 */
export class TodosService {
  private repository: TodosRepository;

  constructor(db: D1Database) {
    this.repository = new TodosRepository(db);
  }

  /**
   * Create a new todo item
   */
  async createTodo(input: CreateTodoInput): Promise<{ id: string; success: boolean }> {
    try {
      logger.debug('Creating todo', { userId: input.userId });

      // Validate input
      this.validateCreateTodoInput(input);

      // Create the todo in the database
      const todo = await this.repository.createTodo(input);

      logger.info('Todo created successfully', { todoId: todo.id, userId: input.userId });

      return {
        id: todo.id,
        success: true,
      };
    } catch (error) {
      logger.error('Failed to create todo', { error, userId: input.userId });
      throw this.handleServiceError(error, 'Failed to create todo');
    }
  }

  /**
   * Process a todo job from the queue
   */
  async processTodoJob(job: TodoJob): Promise<{ id: string; success: boolean }> {
    try {
      logger.debug('Processing todo job', { userId: job.userId, sourceNoteId: job.sourceNoteId });

      // Create a todo from the job
      const todoInput: CreateTodoInput = {
        userId: job.userId,
        title: job.title,
        description: job.description,
        sourceNoteId: job.sourceNoteId,
        sourceText: job.sourceText,
        aiGenerated: true,
        // Apply AI suggestions if available
        ...(job.aiSuggestions && {
          priority: job.aiSuggestions.priority,
          dueDate: job.aiSuggestions.dueDate,
          estimatedEffort: job.aiSuggestions.estimatedEffort,
          actionableSteps: job.aiSuggestions.actionableSteps,
          category: job.aiSuggestions.category,
        }),
      };

      // Create the todo
      const result = await this.createTodo(todoInput);

      logger.info('Todo job processed successfully', {
        todoId: result.id,
        userId: job.userId,
        sourceNoteId: job.sourceNoteId,
      });

      return result;
    } catch (error) {
      logger.error('Failed to process todo job', {
        error,
        userId: job.userId,
        sourceNoteId: job.sourceNoteId,
      });
      throw this.handleServiceError(error, 'Failed to process todo job');
    }
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string): Promise<TodoItem | null> {
    try {
      logger.debug('Getting todo', { todoId: id });

      const todo = await this.repository.getTodo(id);

      if (!todo) {
        logger.debug('Todo not found', { todoId: id });
        return null;
      }

      logger.debug('Todo retrieved successfully', { todoId: id, userId: todo.userId });

      return todo;
    } catch (error) {
      logger.error('Failed to get todo', { error, todoId: id });
      throw this.handleServiceError(error, 'Failed to get todo');
    }
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination) {
    try {
      logger.debug('Listing todos', { userId: filter.userId, filter });

      // Validate filter
      this.validateTodoFilter(filter);

      const result = await this.repository.listTodos(filter, pagination);

      logger.debug('Todos listed successfully', {
        userId: filter.userId,
        count: result.items.length,
        totalCount: result.totalCount,
      });

      return result;
    } catch (error) {
      logger.error('Failed to list todos', { error, userId: filter.userId });
      throw this.handleServiceError(error, 'Failed to list todos');
    }
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput): Promise<{ success: boolean }> {
    try {
      logger.debug('Updating todo', { todoId: id });

      // Validate updates
      this.validateUpdateTodoInput(updates);

      // Get the current todo to ensure it exists
      const currentTodo = await this.repository.getTodo(id);
      if (!currentTodo) {
        logger.debug('Todo not found for update', { todoId: id });

        const notFoundError = new Error('Todo not found');
        (notFoundError as any).code = TodosErrorCode.NOT_FOUND;
        throw notFoundError;
      }

      // Update the todo
      const success = await this.repository.updateTodo(id, updates);

      logger.info('Todo updated successfully', { todoId: id, userId: currentTodo.userId });

      return { success };
    } catch (error) {
      logger.error('Failed to update todo', { error, todoId: id });
      throw this.handleServiceError(error, 'Failed to update todo');
    }
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string): Promise<{ success: boolean }> {
    try {
      logger.debug('Deleting todo', { todoId: id });

      // Get the current todo to ensure it exists
      const currentTodo = await this.repository.getTodo(id);
      if (!currentTodo) {
        logger.debug('Todo not found for deletion', { todoId: id });

        const notFoundError = new Error('Todo not found');
        (notFoundError as any).code = TodosErrorCode.NOT_FOUND;
        throw notFoundError;
      }

      // Delete the todo
      const success = await this.repository.deleteTodo(id);

      logger.info('Todo deleted successfully', { todoId: id, userId: currentTodo.userId });

      return { success };
    } catch (error) {
      logger.error('Failed to delete todo', { error, todoId: id });
      throw this.handleServiceError(error, 'Failed to delete todo');
    }
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(
    ids: string[],
    updates: BatchUpdateInput,
  ): Promise<{ success: boolean; updatedCount: number }> {
    try {
      logger.debug('Batch updating todos', { todoIds: ids });

      // Validate updates
      this.validateBatchUpdateInput(updates);

      // Check if any of the todos exist
      if (ids.length === 0) {
        return { success: true, updatedCount: 0 };
      }

      // Perform the batch update
      const result = await this.repository.batchUpdateTodos(ids, updates);

      logger.info('Todos batch updated successfully', {
        todoIds: ids,
        updatedCount: result.updatedCount,
      });

      return result;
    } catch (error) {
      logger.error('Failed to batch update todos', { error, todoIds: ids });
      throw this.handleServiceError(error, 'Failed to batch update todos');
    }
  }

  /**
   * Get todo statistics for a user
   */
  async getTodoStats(userId: string): Promise<TodoStats> {
    try {
      logger.debug('Getting todo stats', { userId });

      const stats = await this.repository.getTodoStats(userId);

      logger.debug('Todo stats retrieved successfully', {
        userId,
        totalCount: stats.totalCount,
      });

      return stats;
    } catch (error) {
      logger.error('Failed to get todo stats', { error, userId });
      throw this.handleServiceError(error, 'Failed to get todo stats');
    }
  }

  /**
   * Validate create todo input
   */
  private validateCreateTodoInput(input: CreateTodoInput): void {
    if (!input.userId) {
      this.throwValidationError('userId is required');
    }

    if (!input.title || input.title.trim() === '') {
      this.throwValidationError('title is required and cannot be empty');
    }

    // Add additional validation as needed
  }

  /**
   * Validate update todo input
   */
  private validateUpdateTodoInput(updates: UpdateTodoInput): void {
    if (updates.title !== undefined && updates.title.trim() === '') {
      this.throwValidationError('title cannot be empty');
    }

    // Add additional validation as needed
  }

  /**
   * Validate batch update input
   */
  private validateBatchUpdateInput(updates: BatchUpdateInput): void {
    // No validation needed at this time, but can be added if needed
  }

  /**
   * Validate todo filter
   */
  private validateTodoFilter(filter: TodoFilter): void {
    if (!filter.userId) {
      this.throwValidationError('userId is required in filter');
    }

    // Add additional validation as needed
  }

  /**
   * Throw a validation error
   */
  private throwValidationError(message: string): never {
    const error = new Error(message);
    (error as any).code = TodosErrorCode.VALIDATION_ERROR;
    throw error;
  }

  /**
   * Handle service errors
   */
  private handleServiceError(error: any, defaultMessage: string): Error {
    // If the error already has a code, pass it through
    if ((error as any).code) {
      return error;
    }

    // Otherwise, create a standardized error
    const serviceError = new Error(error.message || defaultMessage);
    (serviceError as any).code = TodosErrorCode.INTERNAL_ERROR;
    (serviceError as any).details = { originalError: error };

    return serviceError;
  }
}
