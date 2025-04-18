import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { TaskRepository } from '../repositories/taskRepository';
import { ReminderRepository } from '../repositories/reminderRepository';
import { ServiceError, UnauthorizedError, ValidationError, NotFoundError } from '@dome/common';
import {
  createTaskSchema,
  updateTaskSchema,
  completeTaskSchema,
  TaskStatus,
  TaskPriority,
} from '../models/task';
import { createReminderSchema, DeliveryMethod } from '../models/reminder';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '@dome/logging';

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
    getLogger().info({ path: c.req.path, method: c.req.method }, 'Task creation started');

    try {
      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received task creation data');
      const validatedData = createTaskSchema.parse(body);

      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId }, 'User ID extracted for task creation');

      if (!userId) {
        getLogger().warn({ path: c.req.path }, 'Missing user ID in task creation request');
        throw new UnauthorizedError(
          'User ID is required. Provide it via x-user-id header or userId query parameter',
        );
      }

      // Create the task
      getLogger().info(
        {
          userId,
          title: validatedData.title,
          dueDate: validatedData.dueDate,
          priority: validatedData.priority,
        },
        'Creating new task',
      );
      const task = await this.taskRepository.create(c.env, {
        ...validatedData,
        userId,
      });

      // Check if a reminder should be created
      const reminderTime = body.reminderTime;
      let reminder = null;

      if (reminderTime && typeof reminderTime === 'number') {
        // Create a reminder for the task
        getLogger().info(
          {
            taskId: task.id,
            reminderTime: new Date(reminderTime).toISOString(),
            deliveryMethod: body.deliveryMethod || DeliveryMethod.EMAIL,
          },
          'Creating reminder for task',
        );
        reminder = await this.reminderRepository.create(c.env, {
          taskId: task.id,
          remindAt: reminderTime,
          deliveryMethod: body.deliveryMethod || DeliveryMethod.EMAIL,
        });
      }

      // Return the created task and reminder
      getLogger().info({ taskId: task.id, hasReminder: !!reminder }, 'Task successfully created');
      return c.json(
        {
          success: true,
          task,
          reminder,
        },
        201,
      );
    } catch (error) {
      getLogger().error(
        {
          err: error,
          path: c.req.path,
          userId: c.req.header('x-user-id') || c.req.query('userId'),
        },
        'Error creating task',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Get a task by ID
   * @param c Hono context
   * @returns Response
   */
  async getTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const taskId = c.req.param('id');
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
        taskId,
      },
      'Task retrieval started',
    );

    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    getLogger().debug({ userId, taskId }, 'User ID extracted for task retrieval');

    if (!userId) {
      getLogger().warn({ taskId, path: c.req.path }, 'Missing user ID in task retrieval request');
      throw new UnauthorizedError(
        'User ID is required. Provide it via x-user-id header or userId query parameter',
      );
    }

    try {
      // Get the task
      getLogger().debug({ taskId }, 'Fetching task from repository');
      const task = await this.taskRepository.findById(c.env, taskId);

      // Check if the task exists and belongs to the user
      if (!task || task.userId !== userId) {
        getLogger().info(
          {
            taskId,
            userId,
            taskExists: !!task,
            taskOwnedByUser: task ? task.userId === userId : false,
          },
          'Task not found or access denied',
        );
        throw new NotFoundError('Task not found');
      }

      // Get reminders for the task
      getLogger().debug({ taskId }, 'Fetching reminders for task');
      const reminders = await this.reminderRepository.findByTaskId(c.env, taskId);

      // Return the task and reminders
      getLogger().info(
        {
          taskId,
          reminderCount: reminders.length,
        },
        'Task successfully retrieved',
      );
      return c.json({
        success: true,
        task,
        reminders,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          taskId,
          path: c.req.path,
        },
        'Error getting task',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * List tasks for a user with filtering and sorting
   * @param c Hono context
   * @returns Response
   */
  async listTasks(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
        query: c.req.query(),
      },
      'Task listing started',
    );

    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    getLogger().debug({ userId }, 'User ID extracted for task listing');
    
    if (!userId) {
      getLogger().warn({ path: c.req.path }, 'Missing user ID in task listing request');
      throw new UnauthorizedError('User ID is required. Provide it via x-user-id header or userId query parameter');
    }

    try {

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

      getLogger().debug(
        {
          filters: {
            status,
            priority,
            dueDate,
            limit,
            offset,
          },
        },
        'Task listing query parameters',
      );

      // Get tasks for the user
      getLogger().debug({ userId }, 'Fetching tasks from repository');
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
          [TaskPriority.LOW]: 3,
        };

        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });

      // Apply pagination
      const paginatedTasks = tasks.slice(offset, offset + limit);

      // Return the tasks
      getLogger().info(
        {
          count: paginatedTasks.length,
          total: tasks.length,
          statusFilter: status || 'none',
          priorityFilter: priority || 'none',
        },
        'Tasks successfully listed',
      );

      return c.json({
        success: true,
        tasks: paginatedTasks,
        count: paginatedTasks.length,
        total: tasks.length,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          userId,
          path: c.req.path,
        },
        'Error listing tasks',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Update a task
   * @param c Hono context
   * @returns Response
   */
  async updateTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const taskId = c.req.param('id');
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
        taskId,
      },
      'Task update started',
    );

    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    getLogger().debug({ userId, taskId }, 'User ID extracted for task update');
    
    if (!userId) {
      getLogger().warn({ taskId, path: c.req.path }, 'Missing user ID in task update request');
      throw new UnauthorizedError('User ID is required. Provide it via x-user-id header or userId query parameter');
    }

    try {
      // Get the task to check ownership
      getLogger().debug({ taskId }, 'Fetching task to verify ownership');
      const existingTask = await this.taskRepository.findById(c.env, taskId);

      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        getLogger().info(
          {
            taskId,
            userId,
            taskExists: !!existingTask,
            taskOwnedByUser: existingTask ? existingTask.userId === userId : false,
          },
          'Task not found or access denied for update',
        );
        throw new NotFoundError('Task not found');
      }

      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received update task data');
      const validatedData = updateTaskSchema.parse(body);

      // Update the task
      getLogger().info(
        {
          taskId,
          fieldsToUpdate: Object.keys(validatedData),
        },
        'Updating task',
      );
      const updatedTask = await this.taskRepository.update(c.env, taskId, validatedData);

      // Check if a reminder should be updated or created
      const reminderTime = body.reminderTime;
      let reminder = null;

      if (reminderTime && typeof reminderTime === 'number') {
        // Check if a reminder already exists
        getLogger().debug({ taskId }, 'Checking for existing reminders');
        const existingReminders = await this.reminderRepository.findByTaskId(c.env, taskId);

        if (existingReminders.length > 0) {
          // Update the existing reminder
          getLogger().info(
            {
              reminderId: existingReminders[0].id,
              reminderTime: new Date(reminderTime).toISOString(),
            },
            'Updating existing reminder',
          );
          reminder = await this.reminderRepository.update(c.env, existingReminders[0].id, {
            remindAt: reminderTime,
            deliveryMethod: body.deliveryMethod || existingReminders[0].deliveryMethod,
          });
        } else {
          // Create a new reminder
          getLogger().info(
            {
              taskId,
              reminderTime: new Date(reminderTime).toISOString(),
            },
            'Creating new reminder for task',
          );
          reminder = await this.reminderRepository.create(c.env, {
            taskId,
            remindAt: reminderTime,
            deliveryMethod: body.deliveryMethod || DeliveryMethod.EMAIL,
          });
        }
      }

      // Return the updated task and reminder
      getLogger().info(
        {
          taskId,
          hasReminder: !!reminder,
        },
        'Task successfully updated',
      );
      return c.json({
        success: true,
        task: updatedTask,
        reminder,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          taskId,
          path: c.req.path,
        },
        'Error updating task',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Complete a task
   * @param c Hono context
   * @returns Response
   */
  async completeTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const taskId = c.req.param('id');
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
        taskId,
      },
      'Task completion started',
    );

    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    getLogger().debug({ userId, taskId }, 'User ID extracted for task completion');
    
    if (!userId) {
      getLogger().warn({ taskId, path: c.req.path }, 'Missing user ID in task completion request');
      throw new UnauthorizedError('User ID is required. Provide it via x-user-id header or userId query parameter');
    }

    try {
      // Get the task to check ownership
      getLogger().debug({ taskId }, 'Fetching task to verify ownership before completion');
      const existingTask = await this.taskRepository.findById(c.env, taskId);

      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        getLogger().info(
          {
            taskId,
            userId,
            taskExists: !!existingTask,
            taskOwnedByUser: existingTask ? existingTask.userId === userId : false,
          },
          'Task not found or access denied for completion',
        );
        throw new NotFoundError('Task not found');
      }

      // Check if the task is already completed
      if (existingTask.status === TaskStatus.COMPLETED) {
        getLogger().warn(
          {
            taskId,
            currentStatus: existingTask.status,
          },
          'Task is already completed',
        );
        throw new ValidationError('Task is already completed');
      }

      // Complete the task
      getLogger().info({ taskId }, 'Completing task');
      const completedTask = await this.taskRepository.completeTask(c.env, taskId);

      // Return the completed task
      getLogger().info(
        {
          taskId,
          title: completedTask.title,
        },
        'Task successfully completed',
      );
      return c.json({
        success: true,
        task: completedTask,
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          taskId,
          path: c.req.path,
        },
        'Error completing task',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Delete a task
   * @param c Hono context
   * @returns Response
   */
  async deleteTask(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const taskId = c.req.param('id');
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
        taskId,
      },
      'Task deletion started',
    );

    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    getLogger().debug({ userId, taskId }, 'User ID extracted for task deletion');
    
    if (!userId) {
      getLogger().warn({ taskId, path: c.req.path }, 'Missing user ID in task deletion request');
      throw new UnauthorizedError('User ID is required. Provide it via x-user-id header or userId query parameter');
    }

    try {
      // Get the task to check ownership
      getLogger().debug({ taskId }, 'Fetching task to verify ownership before deletion');
      const existingTask = await this.taskRepository.findById(c.env, taskId);

      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        getLogger().info(
          {
            taskId,
            userId,
            taskExists: !!existingTask,
            taskOwnedByUser: existingTask ? existingTask.userId === userId : false,
          },
          'Task not found or access denied for deletion',
        );
        throw new NotFoundError('Task not found');
      }

      // Delete the task
      getLogger().info(
        {
          taskId,
          title: existingTask.title,
        },
        'Deleting task',
      );
      await this.taskRepository.delete(c.env, taskId);

      // Return success
      getLogger().info({ taskId }, 'Task successfully deleted');
      return c.json({
        success: true,
        message: 'Task deleted successfully',
      });
    } catch (error) {
      getLogger().error(
        {
          err: error,
          taskId,
          path: c.req.path,
        },
        'Error deleting task',
      );

      // Let the middleware handle the error
      throw error;
    }
  }

  /**
   * Add a reminder to a task
   * @param c Hono context
   * @returns Response
   */
  async addReminder(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    const taskId = c.req.param('id');
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
        taskId,
      },
      'Add reminder started',
    );

    // Get user ID from request headers or query parameters
    const userId = c.req.header('x-user-id') || c.req.query('userId');
    getLogger().debug({ userId, taskId }, 'User ID extracted for adding reminder');
    
    if (!userId) {
      getLogger().warn({ taskId, path: c.req.path }, 'Missing user ID in add reminder request');
      throw new UnauthorizedError('User ID is required. Provide it via x-user-id header or userId query parameter');
    }

    try {
      // Get the task to check ownership
      getLogger().debug({ taskId }, 'Fetching task to verify ownership');
      const existingTask = await this.taskRepository.findById(c.env, taskId);

      // Check if the task exists and belongs to the user
      if (!existingTask || existingTask.userId !== userId) {
        getLogger().info(
          {
            taskId,
            userId,
            taskExists: !!existingTask,
            taskOwnedByUser: existingTask ? existingTask.userId === userId : false,
          },
          'Task not found or access denied for adding reminder',
        );
        throw new NotFoundError('Task not found');
      }

      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received reminder data');
      const validatedData = createReminderSchema.parse({
        ...body,
        taskId,
      });

      // Create the reminder
      getLogger().info(
        {
          taskId,
          remindAt: new Date(validatedData.remindAt).toISOString(),
          deliveryMethod: validatedData.deliveryMethod,
        },
        'Creating reminder for task',
      );
      const reminder = await this.reminderRepository.create(c.env, validatedData);

      // Return the created reminder
      getLogger().info(
        {
          reminderId: reminder.id,
          taskId,
        },
        'Reminder successfully created',
      );
      return c.json(
        {
          success: true,
          reminder,
        },
        201,
      );
    } catch (error) {
      getLogger().error(
        {
          err: error,
          taskId,
          path: c.req.path,
        },
        'Error adding reminder',
      );

      // Let the middleware handle the error
      throw error;
    }
  }
}

// Export singleton instance
export const taskController = new TaskController();
