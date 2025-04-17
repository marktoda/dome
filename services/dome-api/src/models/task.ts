import { z } from 'zod';

/**
 * Task status enum
 */
export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}

/**
 * Task priority enum
 */
export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent'
}

/**
 * Task interface
 */
export interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * Zod schema for validating task creation
 */
export const createTaskSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  status: z.enum([
    TaskStatus.PENDING,
    TaskStatus.IN_PROGRESS,
    TaskStatus.COMPLETED,
    TaskStatus.CANCELLED
  ]).default(TaskStatus.PENDING),
  priority: z.enum([
    TaskPriority.LOW,
    TaskPriority.MEDIUM,
    TaskPriority.HIGH,
    TaskPriority.URGENT
  ]).default(TaskPriority.MEDIUM),
  dueDate: z.number().optional()
});

/**
 * Type for task creation data
 */
export type CreateTaskData = z.infer<typeof createTaskSchema>;

/**
 * Zod schema for validating task updates
 */
export const updateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').optional(),
  description: z.string().optional(),
  status: z.enum([
    TaskStatus.PENDING,
    TaskStatus.IN_PROGRESS,
    TaskStatus.COMPLETED,
    TaskStatus.CANCELLED
  ]).optional(),
  priority: z.enum([
    TaskPriority.LOW,
    TaskPriority.MEDIUM,
    TaskPriority.HIGH,
    TaskPriority.URGENT
  ]).optional(),
  dueDate: z.number().optional(),
  completedAt: z.number().optional()
});

/**
 * Type for task update data
 */
export type UpdateTaskData = z.infer<typeof updateTaskSchema>;

/**
 * Zod schema for validating task completion
 */
export const completeTaskSchema = z.object({
  completedAt: z.number().default(() => Date.now())
});

/**
 * Type for task completion data
 */
export type CompleteTaskData = z.infer<typeof completeTaskSchema>;