import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { TaskRepository } from '../repositories/taskRepository';
import { ReminderRepository } from '../repositories/reminderRepository';
import { ServiceError } from '@dome/common';
import { 
  createTaskSchema, 
  updateTaskSchema, 
  completeTaskSchema, 
  TaskStatus, 
  TaskPriority 
} from '../models/task';
import { createReminderSchema, DeliveryMethod } from '../models/reminder';
import { v4 as uuidv4 } from 'uuid';

/**
 * Controller for task operations
 */
export class TaskController {
  private taskRepository: TaskRepository;
  private reminderRepository: ReminderRepository;

  /**
   * Constructor
   */
  constructor() {
    this.taskRepository = new TaskRepository();
    this.reminderRepository = new ReminderRepository();
  }

  /**
   * Create a new task
   * @param c Hono context
   * @returns Response
   */
  async createTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Validate request body
      const body = await c.req.json();
      const validatedData = createTaskSchema.parse(body);
      
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Create the task
      const task = await this.taskRepository.create(c.env, {
        ...validatedData,
        userId
      });

      // Check if a reminder should be created
      const reminderTime = body.reminderTime;
      let reminder = null;
      
      if (reminderTime && typeof reminderTime === 'number') {
        // Create a reminder for the task
        reminder = await this.reminderRepository.create(c.env, {
          taskId: task.id,
          remindAt: reminderTime,
          deliveryMethod: body.deliveryMethod || DeliveryMethod.EMAIL
        });
      }

      // Return the created task and reminder
      return c.json({
        success: true,
        task,
        reminder
      }, 201);
    } catch (error) {
      console.error('Error creating task:', error);
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid task data',
            details: error.errors
          }
        }, 400);
      }
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while creating the task'
        }
      }, 500);
    }
  }

  /**
   * Get a task by ID
   * @param c Hono context
   * @returns Response
   */
  async getTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get task ID from path
      const taskId = c.req.param('id');
      
      // Get the task
      const task = await this.taskRepository.findById(c.env, taskId);
      
      // Check if the task exists and belongs to the user
      if (!task || task.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found'
          }
        }, 404);
      }
      
      // Get reminders for the task
      const reminders = await this.reminderRepository.findByTaskId(c.env, taskId);
      
      // Return the task and reminders
      return c.json({
        success: true,
        task,
        reminders
      });
    } catch (error) {
      console.error('Error getting task:', error);
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while retrieving the task'
        }
      }, 500);
    }
  }

  /**
   * List tasks for a user with filtering and sorting
   * @param c Hono context
   * @returns Response
   */
  async listTasks(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get query parameters for filtering
      const statusParam = c.req.query('status');
      const priorityParam = c.req.query('priority');
      const dueDateParam = c.req.query('dueDate');
      const limitParam = c.req.query('limit');
      const offsetParam = c.req.query('offset');
      
      // Parse parameters
      const status = statusParam as TaskStatus | undefined;
      const priority = priorityParam as TaskPriority | undefined;
      const dueDate = dueDateParam ? parseInt(dueDateParam) : undefined;
      const limit = limitParam ? parseInt(limitParam) : 50;
      const offset = offsetParam ? parseInt(offsetParam) : 0;
      
      // Get tasks for the user
      let tasks = await this.taskRepository.findByUserId(c.env, userId);
      
      // Apply filters
      if (status) {
        tasks = tasks.filter(task => task.status === status);
      }
      
      if (priority) {
        tasks = tasks.filter(task => task.priority === priority);
      }
      
      if (dueDate) {
        tasks = tasks.filter(task => task.dueDate && task.dueDate <= dueDate);
      }
      
      // Sort tasks by due date (ascending) and priority (descending)
      tasks.sort((a, b) => {
        // First sort by due date (tasks with due dates come first)
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (a.dueDate && b.dueDate) {
          if (a.dueDate !== b.dueDate) {
            return a.dueDate - b.dueDate;
          }
        }
        
        // Then sort by priority
        const priorityOrder = {
          [TaskPriority.URGENT]: 0,
          [TaskPriority.HIGH]: 1,
          [TaskPriority.MEDIUM]: 2,
          [TaskPriority.LOW]: 3
        };
        
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
      
      // Apply pagination
      const paginatedTasks = tasks.slice(offset, offset + limit);
      
      // Return the tasks
      return c.json({
        success: true,
        tasks: paginatedTasks,
        count: paginatedTasks.length,
        total: tasks.length
      });
    } catch (error) {
      console.error('Error listing tasks:', error);
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while listing tasks'
        }
      }, 500);
    }
  }

  /**
   * Update a task
   * @param c Hono context
   * @returns Response
   */
  async updateTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get task ID from path
      const taskId = c.req.param('id');
      
      // Get the task to check ownership
      const existingTask = await this.taskRepository.findById(c.env, taskId);
      
      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found'
          }
        }, 404);
      }
      
      // Validate request body
      const body = await c.req.json();
      const validatedData = updateTaskSchema.parse(body);
      
      // Update the task
      const updatedTask = await this.taskRepository.update(c.env, taskId, validatedData);
      
      // Check if a reminder should be updated or created
      const reminderTime = body.reminderTime;
      let reminder = null;
      
      if (reminderTime && typeof reminderTime === 'number') {
        // Check if a reminder already exists
        const existingReminders = await this.reminderRepository.findByTaskId(c.env, taskId);
        
        if (existingReminders.length > 0) {
          // Update the existing reminder
          reminder = await this.reminderRepository.update(c.env, existingReminders[0].id, {
            remindAt: reminderTime,
            deliveryMethod: body.deliveryMethod || existingReminders[0].deliveryMethod
          });
        } else {
          // Create a new reminder
          reminder = await this.reminderRepository.create(c.env, {
            taskId,
            remindAt: reminderTime,
            deliveryMethod: body.deliveryMethod || DeliveryMethod.EMAIL
          });
        }
      }
      
      // Return the updated task and reminder
      return c.json({
        success: true,
        task: updatedTask,
        reminder
      });
    } catch (error) {
      console.error('Error updating task:', error);
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid update data',
            details: error.errors
          }
        }, 400);
      }
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while updating the task'
        }
      }, 500);
    }
  }

  /**
   * Complete a task
   * @param c Hono context
   * @returns Response
   */
  async completeTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get task ID from path
      const taskId = c.req.param('id');
      
      // Get the task to check ownership
      const existingTask = await this.taskRepository.findById(c.env, taskId);
      
      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found'
          }
        }, 404);
      }
      
      // Check if the task is already completed
      if (existingTask.status === TaskStatus.COMPLETED) {
        return c.json({
          success: false,
          error: {
            code: 'INVALID_OPERATION',
            message: 'Task is already completed'
          }
        }, 400);
      }
      
      // Complete the task
      const completedTask = await this.taskRepository.completeTask(c.env, taskId);
      
      // Return the completed task
      return c.json({
        success: true,
        task: completedTask
      });
    } catch (error) {
      console.error('Error completing task:', error);
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while completing the task'
        }
      }, 500);
    }
  }

  /**
   * Delete a task
   * @param c Hono context
   * @returns Response
   */
  async deleteTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get task ID from path
      const taskId = c.req.param('id');
      
      // Get the task to check ownership
      const existingTask = await this.taskRepository.findById(c.env, taskId);
      
      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found'
          }
        }, 404);
      }
      
      // Delete the task
      await this.taskRepository.delete(c.env, taskId);
      
      // Return success
      return c.json({
        success: true,
        message: 'Task deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting task:', error);
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while deleting the task'
        }
      }, 500);
    }
  }

  /**
   * Add a reminder to a task
   * @param c Hono context
   * @returns Response
   */
  async addReminder(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get task ID from path
      const taskId = c.req.param('id');
      
      // Get the task to check ownership
      const existingTask = await this.taskRepository.findById(c.env, taskId);
      
      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        return c.json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found'
          }
        }, 404);
      }
      
      // Validate request body
      const body = await c.req.json();
      const validatedData = createReminderSchema.parse({
        ...body,
        taskId
      });
      
      // Create the reminder
      const reminder = await this.reminderRepository.create(c.env, validatedData);
      
      // Return the created reminder
      return c.json({
        success: true,
        reminder
      }, 201);
    } catch (error) {
      console.error('Error adding reminder:', error);
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid reminder data',
            details: error.errors
          }
        }, 400);
      }
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while adding the reminder'
        }
      }, 500);
    }
  }
}

// Export singleton instance
export const taskController = new TaskController();