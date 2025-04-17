import { BaseRepository } from './baseRepository';
import { Task, CreateTaskData, UpdateTaskData, TaskStatus } from '../models/task';
import { tasks } from '../db/schema';
import { eq, and, lte, sql } from 'drizzle-orm';
import { getDb, handleDatabaseError } from '../db';
import { Bindings } from '../types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Repository for Task operations
 */
export class TaskRepository extends BaseRepository<Task, CreateTaskData, UpdateTaskData> {
  /**
   * Constructor
   */
  constructor() {
    super(tasks, tasks.id);
  }

  /**
   * Create a new task
   * @param env Environment bindings
   * @param data Task data
   * @returns Created task
   */
  async create(env: Bindings, data: CreateTaskData): Promise<Task> {
    try {
      const now = Date.now();
      const taskData = {
        id: uuidv4(),
        userId: data.userId,
        title: data.title,
        description: data.description,
        status: data.status || TaskStatus.PENDING,
        priority: data.priority || 'medium',
        dueDate: data.dueDate,
        createdAt: now,
        updatedAt: now,
        completedAt: undefined
      };

      const db = getDb(env);
      const result = await db.insert(tasks).values(taskData).returning().all();
      return result[0] as Task;
    } catch (error) {
      throw handleDatabaseError(error, 'create task');
    }
  }

  /**
   * Update a task
   * @param env Environment bindings
   * @param id Task ID
   * @param data Update data
   * @returns Updated task
   */
  async update(env: Bindings, id: string, data: UpdateTaskData): Promise<Task> {
    try {
      const updateData = {
        ...data,
        updatedAt: Date.now()
      };

      const db = getDb(env);
      const result = await db
        .update(tasks)
        .set(updateData)
        .where(eq(tasks.id, id))
        .returning()
        .all();
      
      if (result.length === 0) {
        throw new Error(`Task with ID ${id} not found`);
      }
      
      return result[0] as Task;
    } catch (error) {
      throw handleDatabaseError(error, `update task(${id})`);
    }
  }

  /**
   * Complete a task
   * @param env Environment bindings
   * @param id Task ID
   * @returns Updated task
   */
  async completeTask(env: Bindings, id: string): Promise<Task> {
    try {
      const now = Date.now();
      const updateData = {
        status: TaskStatus.COMPLETED,
        completedAt: now,
        updatedAt: now
      };

      const db = getDb(env);
      const result = await db
        .update(tasks)
        .set(updateData)
        .where(eq(tasks.id, id))
        .returning()
        .all();
      
      if (result.length === 0) {
        throw new Error(`Task with ID ${id} not found`);
      }
      
      return result[0] as Task;
    } catch (error) {
      throw handleDatabaseError(error, `complete task(${id})`);
    }
  }

  /**
   * Find tasks by user ID
   * @param env Environment bindings
   * @param userId User ID
   * @returns Array of tasks
   */
  async findByUserId(env: Bindings, userId: string): Promise<Task[]> {
    return this.findBy(env, tasks.userId, userId);
  }

  /**
   * Find tasks by user ID and status
   * @param env Environment bindings
   * @param userId User ID
   * @param status Task status
   * @returns Array of tasks
   */
  async findByUserIdAndStatus(env: Bindings, userId: string, status: TaskStatus): Promise<Task[]> {
    try {
      const db = getDb(env);
      const results = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), eq(tasks.status, status)))
        .all();
      
      return results as Task[];
    } catch (error) {
      throw handleDatabaseError(error, `findByUserIdAndStatus(${userId}, ${status})`);
    }
  }

  /**
   * Find tasks due by a certain date
   * @param env Environment bindings
   * @param userId User ID
   * @param beforeDate Date in milliseconds
   * @returns Array of tasks
   */
  async findTasksDueBy(env: Bindings, userId: string, beforeDate: number): Promise<Task[]> {
    try {
      const db = getDb(env);
      const results = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.userId, userId),
            eq(tasks.status, TaskStatus.PENDING),
            lte(tasks.dueDate, beforeDate)
          )
        )
        .all();
      
      return results as Task[];
    } catch (error) {
      throw handleDatabaseError(error, `findTasksDueBy(${userId}, ${beforeDate})`);
    }
  }
}