/**
 * Todos Service Type Definitions
 */
import { z } from 'zod';

/**
 * Enum for todo status values
 */
export enum TodoStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/**
 * Enum for todo priority values
 */
export enum TodoPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Database model for a todo item
 */
export interface TodoItem {
  id: string;
  userId: string;

  title: string;
  description?: string;

  status: TodoStatus;
  priority: TodoPriority;

  category?: string;
  tags?: string; // Stored as comma-separated string

  createdAt: number;
  updatedAt: number;
  dueDate?: number;
  completedAt?: number;

  sourceNoteId?: string;
  sourceText?: string;

  aiGenerated: boolean;
  confidence?: number;

  estimatedEffort?: string;
  actionableSteps?: string; // Stored as JSON string
  context?: string;
}

/**
 * Model for creating a new todo
 */
export interface CreateTodoInput {
  userId: string;
  title: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  category?: string;
  tags?: string[];
  dueDate?: number;
  sourceNoteId?: string;
  sourceText?: string;
  aiGenerated?: boolean;
  confidence?: number;
  estimatedEffort?: string;
  actionableSteps?: string[];
  context?: string;
}

/**
 * Interface for todo items sent to the Todos service queue
 * This must remain in sync with the definition in the Todos service
 */
export const TodoQueueItemSchema = z.object({
  userId: z.string(),
  sourceNoteId: z.string(),
  sourceText: z.string(),

  // AI-enriched content
  title: z.string(),
  description: z.string().optional(),

  // Metadata suggestions
  priority: z.union([z.nativeEnum(TodoPriority), z.string()]).optional(),
  dueDate: z.union([z.string(), z.number()]).optional(),
  estimatedEffort: z.string().optional(),
  actionableSteps: z.array(z.string()).optional(),
  category: z.string().optional(),

  // Processing metadata
  created: z.number().optional(),
});

export type TodoQueueItem = z.infer<typeof TodoQueueItemSchema>;

/**
 * Result of creating a todo
 */
export interface CreateTodoResult {
  id: string;
  success: boolean;
}

/**
 * Model for updating a todo
 */
export interface UpdateTodoInput {
  title?: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  category?: string;
  tags?: string[];
  dueDate?: number | null;
  completedAt?: number | null;
  estimatedEffort?: string;
  actionableSteps?: string[];
  context?: string;
}

/**
 * Result of updating a todo
 */
export interface UpdateTodoResult {
  success: boolean;
}

/**
 * Result of deleting a todo
 */
export interface DeleteTodoResult {
  success: boolean;
}

/**
 * Model for batch updating todos
 */
export interface BatchUpdateInput {
  status?: TodoStatus;
  priority?: TodoPriority;
  category?: string;
  dueDate?: number | null;
  tags?: string[];
}

/**
 * Result of batch updating todos
 */
export interface BatchUpdateResult {
  success: boolean;
  updatedCount: number;
}

/**
 * Filter for listing todos
 */
export interface TodoFilter {
  userId: string;
  status?: TodoStatus | TodoStatus[];
  priority?: TodoPriority | TodoPriority[];
  category?: string;
  tags?: string[];
  dueBefore?: number;
  dueAfter?: number;
  createdBefore?: number;
  createdAfter?: number;
  search?: string; // Full-text search
  sourceNoteId?: string;
}

/**
 * Pagination options
 */
export interface Pagination {
  limit?: number;
  cursor?: string;
}

/**
 * Result of listing todos
 */
export interface ListTodosResult {
  items: TodoItem[];
  nextCursor?: string;
  totalCount?: number;
}

/**
 * Todo statistics
 */
export interface TodoStats {
  totalCount: number;
  byStatus: Record<TodoStatus, number>;
  byPriority: Record<TodoPriority, number>;
  byCategory: Record<string, number>;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
}

/**
 * Internal job format for todo processing
 * Converted from TodoQueueItem for internal processing
 */
export interface TodoJob {
  // Required fields from TodoQueueItem
  userId: string;
  sourceNoteId: string;
  sourceText: string;
  title: string;

  // Optional fields
  description?: string;

  // Structured suggestions that have been processed and normalized
  aiSuggestions?: {
    priority?: TodoPriority;
    dueDate?: number;
    estimatedEffort?: string;
    actionableSteps?: string[];
    category?: string;
  };

  // Processing metadata
  created: number;
  version: number;
}

/**
 * Service binding interface for the Todos service
 */
export interface TodosBinding {
  createTodo(todo: CreateTodoInput): Promise<CreateTodoResult>;
  getTodo(id: string): Promise<TodoItem | null>;
  listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult>;
  updateTodo(id: string, updates: UpdateTodoInput): Promise<UpdateTodoResult>;
  deleteTodo(id: string): Promise<DeleteTodoResult>;
  batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<BatchUpdateResult>;
  stats(userId: string): Promise<TodoStats>;
}

/**
 * Environment bindings for the Todos service
 */
export interface Env {
  // Database binding
  DB: D1Database;

  // Queue binding
  TODOS_QUEUE: Queue<TodoQueueItem>;

  // Configuration variables
  LOG_LEVEL?: string;
  VERSION?: string;
  ENVIRONMENT?: string;
}

/**
 * Error codes for the Todos service
 */
export enum TodosErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  DATABASE_ERROR = 'DATABASE_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Error response from the Todos service
 */
export interface TodosError {
  code: TodosErrorCode;
  message: string;
  details?: Record<string, any>;
}
