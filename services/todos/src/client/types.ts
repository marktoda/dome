/**
 * Type definitions for the Todos client
 */

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

/**
 * Interface for Todos service binding
 * Defines the methods available on the Todos service
 */
export interface TodosBinding {
  /**
   * Create a new todo item
   */
  createTodo(todo: CreateTodoInput): Promise<CreateTodoResult>;

  /**
   * Get a todo by ID
   */
  getTodo(id: string): Promise<TodoItem | null>;

  /**
   * List todos with filtering and pagination
   */
  listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult>;

  /**
   * Update a todo
   */
  updateTodo(id: string, updates: UpdateTodoInput): Promise<UpdateTodoResult>;

  /**
   * Delete a todo
   */
  deleteTodo(id: string): Promise<DeleteTodoResult>;

  /**
   * Batch update multiple todos
   */
  batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<BatchUpdateResult>;

  /**
   * Get todo statistics for a user
   */
  stats(userId: string): Promise<TodoStats>;
}

/**
 * Interface for the Todos client service
 * Mirrors the methods available via the binding
 */
export interface TodosService extends TodosBinding {}
