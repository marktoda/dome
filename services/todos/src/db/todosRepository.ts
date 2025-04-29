// Using crypto.randomUUID() instead of nanoid for better compatibility
import {
  TodoItem,
  TodoStatus,
  TodoPriority,
  CreateTodoInput,
  UpdateTodoInput,
  TodoFilter,
  Pagination,
  ListTodosResult,
  BatchUpdateInput,
  TodoStats,
  TodosErrorCode
} from '../types';
import { getLogger } from '@dome/logging';
import { eq, and, gt, lt, like, desc, sql, or, inArray, isNull, isNotNull, gte, lte, not } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { todos } from '../db/schema';

const logger = getLogger();

// Function to generate todo IDs
const generateTodoId = () => `todo_${crypto.randomUUID().replace(/-/g, '')}`;

/**
 * Repository for todos database operations
 */
export class TodosRepository {
  private readonly db: ReturnType<typeof drizzle>;

  constructor(private readonly d1Db: D1Database) {
    this.db = drizzle(d1Db);
  }

  /**
   * Create a new todo item
   */
  async createTodo(input: CreateTodoInput): Promise<TodoItem> {
    const id = generateTodoId();
    const now = Date.now();
    
    // Convert tag array to comma-separated string if provided
    const tagsString = input.tags?.join(',');
    
    // Convert actionable steps array to JSON string if provided
    const actionableSteps = input.actionableSteps ? JSON.stringify(input.actionableSteps) : undefined;
    
    const todo: TodoItem = {
      id,
      userId: input.userId,
      title: input.title,
      description: input.description,
      status: input.status || TodoStatus.PENDING,
      priority: input.priority || TodoPriority.MEDIUM,
      category: input.category,
      tags: tagsString,
      createdAt: now,
      updatedAt: now,
      dueDate: input.dueDate,
      completedAt: input.status === TodoStatus.COMPLETED ? now : undefined,
      sourceNoteId: input.sourceNoteId,
      sourceText: input.sourceText,
      aiGenerated: input.aiGenerated || false,
      confidence: input.confidence,
      estimatedEffort: input.estimatedEffort,
      actionableSteps,
      context: input.context
    };
    
    try {
      await this.db.insert(todos).values({
        id: todo.id,
        userId: todo.userId,
        title: todo.title,
        description: todo.description || null,
        status: todo.status,
        priority: todo.priority,
        category: todo.category || null,
        tags: todo.tags || null,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
        dueDate: todo.dueDate || null,
        completedAt: todo.completedAt || null,
        sourceNoteId: todo.sourceNoteId || null,
        sourceText: todo.sourceText || null,
        aiGenerated: todo.aiGenerated,
        confidence: todo.confidence || null,
        estimatedEffort: todo.estimatedEffort || null,
        actionableSteps: todo.actionableSteps || null,
        context: todo.context || null
      });
      
      return todo;
    } catch (error) {
      logger.error('Failed to create todo', { error, todoId: id, userId: input.userId });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * Get a todo by ID
   */
  async getTodo(id: string): Promise<TodoItem | null> {
    try {
      const results = await this.db.select()
        .from(todos)
        .where(eq(todos.id, id))
        .limit(1);
      
      if (!results.length) {
        return null;
      }
      
      return this.mapDatabaseResultToTodo(results[0]);
    } catch (error) {
      logger.error('Failed to get todo', { error, todoId: id });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * List todos with filtering and pagination
   */
  async listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult> {
    const { userId, status, priority, category, tags, dueBefore, dueAfter, createdBefore, createdAfter, search, sourceNoteId } = filter;
    const { limit = 50, cursor } = pagination || {};
    
    try {
      // Build conditions array for the query
      const conditions: any[] = [eq(todos.userId, userId)];
      
      // Status filter
      if (status) {
        if (Array.isArray(status)) {
          conditions.push(inArray(todos.status, status));
        } else {
          conditions.push(eq(todos.status, status));
        }
      }
      
      // Priority filter
      if (priority) {
        if (Array.isArray(priority)) {
          conditions.push(inArray(todos.priority, priority));
        } else {
          conditions.push(eq(todos.priority, priority));
        }
      }
      
      // Category filter
      if (category) {
        conditions.push(eq(todos.category, category));
      }
      
      // Tags filter (comma-separated values in DB)
      if (tags && tags.length > 0) {
        // Handle each tag with a LIKE condition
        if (tags.length === 1) {
          conditions.push(like(todos.tags, `%${tags[0]}%`));
        } else {
          // Build an array of like conditions
          const tagLikes = tags.map(tag => like(todos.tags, `%${tag}%`));
          // Apply OR between all tag conditions
          conditions.push(or(...tagLikes));
        }
      }
      
      // Due date filters
      if (dueBefore) {
        conditions.push(lt(todos.dueDate, dueBefore));
      }
      
      if (dueAfter) {
        conditions.push(gt(todos.dueDate, dueAfter));
      }
      
      // Created date filters
      if (createdBefore) {
        conditions.push(lt(todos.createdAt, createdBefore));
      }
      
      if (createdAfter) {
        conditions.push(gt(todos.createdAt, createdAfter));
      }
      
      // Source note filter
      if (sourceNoteId) {
        conditions.push(eq(todos.sourceNoteId, sourceNoteId));
      }
      
      // Search filter
      if (search) {
        // Search in title (required) and description (optional)
        conditions.push(
          or(
            like(todos.title, `%${search}%`),
            and(
              isNotNull(todos.description),
              like(todos.description, `%${search}%`)
            )
          )
        );
      }
      
      // Add cursor-based pagination if a cursor is provided
      if (cursor) {
        conditions.push(gt(todos.id, cursor));
      }
      
      // Execute the query with all conditions
      let query = this.db.select()
        .from(todos)
        .where(and(...conditions))
        .orderBy(desc(todos.createdAt))
        .limit(limit + 1); // Fetch one extra to determine if there are more results
      
      const todoItems = await query;
      
      // Determine if there are more results
      const hasMore = todoItems.length > limit;
      if (hasMore) {
        todoItems.pop(); // Remove the extra item
      }
      
      // Get total count
      const countResult = await this.db.select({ count: sql<number>`count(*)` })
        .from(todos)
        .where(eq(todos.userId, userId));
      
      const totalCount = countResult[0]?.count;
      
      return {
        items: todoItems.map(this.mapDatabaseResultToTodo),
        nextCursor: hasMore ? todoItems[todoItems.length - 1].id : undefined,
        totalCount
      };
    } catch (error) {
      logger.error('Failed to list todos', { error, userId });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * Update a todo
   */
  async updateTodo(id: string, updates: UpdateTodoInput): Promise<boolean> {
    try {
      // Get the current todo to ensure it exists
      const currentTodo = await this.getTodo(id);
      if (!currentTodo) {
        return false;
      }
      
      // Prepare update fields
      const updateValues: Record<string, any> = {
        updatedAt: Date.now()
      };
      
      // Add updates for each field
      if (updates.title !== undefined) {
        updateValues.title = updates.title;
      }
      
      if (updates.description !== undefined) {
        updateValues.description = updates.description || null;
      }
      
      if (updates.status !== undefined) {
        updateValues.status = updates.status;
        
        // If marking as completed, set completedAt
        if (updates.status === TodoStatus.COMPLETED && currentTodo.status !== TodoStatus.COMPLETED) {
          updateValues.completedAt = Date.now();
        }
        
        // If marking as not completed, clear completedAt
        if (updates.status !== TodoStatus.COMPLETED && currentTodo.status === TodoStatus.COMPLETED) {
          updateValues.completedAt = null;
        }
      }
      
      if (updates.priority !== undefined) {
        updateValues.priority = updates.priority;
      }
      
      if (updates.category !== undefined) {
        updateValues.category = updates.category || null;
      }
      
      if (updates.tags !== undefined) {
        updateValues.tags = updates.tags.length ? updates.tags.join(',') : null;
      }
      
      if (updates.dueDate !== undefined) {
        updateValues.dueDate = updates.dueDate || null;
      }
      
      if (updates.completedAt !== undefined) {
        updateValues.completedAt = updates.completedAt || null;
      }
      
      if (updates.estimatedEffort !== undefined) {
        updateValues.estimatedEffort = updates.estimatedEffort || null;
      }
      
      if (updates.actionableSteps !== undefined) {
        updateValues.actionableSteps = updates.actionableSteps.length ? JSON.stringify(updates.actionableSteps) : null;
      }
      
      if (updates.context !== undefined) {
        updateValues.context = updates.context || null;
      }
      
      // Build and execute the query
      if (Object.keys(updateValues).length <= 1) {
        return true; // No updates to make (only updatedAt)
      }
      
      const result = await this.db.update(todos)
        .set(updateValues)
        .where(eq(todos.id, id));
      
      return true;
    } catch (error) {
      logger.error('Failed to update todo', { error, todoId: id });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * Delete a todo
   */
  async deleteTodo(id: string): Promise<boolean> {
    try {
      await this.db.delete(todos).where(eq(todos.id, id));
      return true;
    } catch (error) {
      logger.error('Failed to delete todo', { error, todoId: id });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * Batch update multiple todos
   */
  async batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<{ success: boolean; updatedCount: number }> {
    try {
      // Prepare update fields
      const updateValues: Record<string, any> = {
        updatedAt: Date.now()
      };
      
      // Add updates for each field
      if (updates.status !== undefined) {
        updateValues.status = updates.status;
        
        // If marking as completed, set completedAt
        if (updates.status === TodoStatus.COMPLETED) {
          updateValues.completedAt = Date.now();
        }
        
        // If marking as not completed, clear completedAt
        if (updates.status !== TodoStatus.COMPLETED) {
          updateValues.completedAt = null;
        }
      }
      
      if (updates.priority !== undefined) {
        updateValues.priority = updates.priority;
      }
      
      if (updates.category !== undefined) {
        updateValues.category = updates.category || null;
      }
      
      if (updates.dueDate !== undefined) {
        updateValues.dueDate = updates.dueDate || null;
      }
      
      if (updates.tags !== undefined) {
        updateValues.tags = updates.tags.length ? updates.tags.join(',') : null;
      }
      
      // Build and execute the query
      if (Object.keys(updateValues).length <= 1 || ids.length === 0) {
        return { success: true, updatedCount: 0 }; // No updates to make
      }
      
      const result = await this.db.update(todos)
        .set(updateValues)
        .where(inArray(todos.id, ids));
      
      // D1 may not always provide changes property, so default to 0
      return {
        success: true,
        updatedCount: ids.length // Use ids length as an approximation
      };
    } catch (error) {
      logger.error('Failed to batch update todos', { error, todoIds: ids });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * Get todo statistics for a user
   */
  async getTodoStats(userId: string): Promise<TodoStats> {
    try {
      // Get total count
      const countResult = await this.db.select({ count: sql<number>`count(*)` })
        .from(todos)
        .where(eq(todos.userId, userId));
      
      const totalCount = countResult[0]?.count || 0;
      
      // Get counts by status
      const statusCounts = await this.db.select({
        status: todos.status,
        count: sql<number>`count(*)`
      })
      .from(todos)
      .where(eq(todos.userId, userId))
      .groupBy(todos.status);
      
      const byStatus: Record<TodoStatus, number> = {
        [TodoStatus.PENDING]: 0,
        [TodoStatus.IN_PROGRESS]: 0,
        [TodoStatus.COMPLETED]: 0,
        [TodoStatus.CANCELLED]: 0
      };
      
      statusCounts.forEach((result) => {
        byStatus[result.status as TodoStatus] = result.count;
      });
      
      // Get counts by priority
      const priorityCounts = await this.db.select({
        priority: todos.priority,
        count: sql<number>`count(*)`
      })
      .from(todos)
      .where(eq(todos.userId, userId))
      .groupBy(todos.priority);
      
      const byPriority: Record<TodoPriority, number> = {
        [TodoPriority.LOW]: 0,
        [TodoPriority.MEDIUM]: 0,
        [TodoPriority.HIGH]: 0,
        [TodoPriority.URGENT]: 0
      };
      
      priorityCounts.forEach((result) => {
        byPriority[result.priority as TodoPriority] = result.count;
      });
      
      // Get counts by category
      const categoryCounts = await this.db.select({
        category: todos.category,
        count: sql<number>`count(*)`
      })
      .from(todos)
      .where(and(
        eq(todos.userId, userId),
        isNotNull(todos.category)
      ))
      .groupBy(todos.category);
      
      const byCategory: Record<string, number> = {};
      
      categoryCounts.forEach((result) => {
        if (result.category) {
          byCategory[result.category] = result.count;
        }
      });
      
      // Calculate date-based stats
      const now = Date.now();
      const startOfDay = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      const endOfDay = new Date(new Date().setHours(23, 59, 59, 999)).getTime();
      const endOfWeek = startOfDay + 7 * 24 * 60 * 60 * 1000;
      
      // Get overdue count (due date in the past, not completed)
      const overdueResult = await this.db.select({ count: sql<number>`count(*)` })
        .from(todos)
        .where(and(
          eq(todos.userId, userId),
          lt(todos.dueDate, startOfDay),
          isNotNull(todos.dueDate),
          not(inArray(todos.status, [TodoStatus.COMPLETED, TodoStatus.CANCELLED]))
        ));
      
      // Get due today count
      const dueTodayResult = await this.db.select({ count: sql<number>`count(*)` })
        .from(todos)
        .where(and(
          eq(todos.userId, userId),
          gte(todos.dueDate, startOfDay),
          lte(todos.dueDate, endOfDay),
          not(inArray(todos.status, [TodoStatus.COMPLETED, TodoStatus.CANCELLED]))
        ));
      
      // Get due this week count
      const dueThisWeekResult = await this.db.select({ count: sql<number>`count(*)` })
        .from(todos)
        .where(and(
          eq(todos.userId, userId),
          gt(todos.dueDate, endOfDay),
          lte(todos.dueDate, endOfWeek),
          not(inArray(todos.status, [TodoStatus.COMPLETED, TodoStatus.CANCELLED]))
        ));
      
      return {
        totalCount,
        byStatus,
        byPriority,
        byCategory,
        overdue: overdueResult[0]?.count || 0,
        dueToday: dueTodayResult[0]?.count || 0,
        dueThisWeek: dueThisWeekResult[0]?.count || 0
      };
    } catch (error) {
      logger.error('Failed to get todo stats', { error, userId });
      throw this.handleDatabaseError(error);
    }
  }

  /**
   * Map database record to TodoItem
   */
  private mapDatabaseResultToTodo(result: any): TodoItem {
    // Map tags from comma-separated string to array
    const tagsString = result.tags as string | null;
    const tags = tagsString ? tagsString : undefined;
    
    // Map actionable steps from JSON string to array
    let actionableSteps = undefined;
    try {
      if (result.actionableSteps) {
        actionableSteps = JSON.parse(result.actionableSteps as string);
      }
    } catch (e) {
      logger.warn('Failed to parse actionableSteps JSON', { 
        todoId: result.id, 
        actionableSteps: result.actionableSteps 
      });
    }
    
    return {
      id: result.id,
      userId: result.userId,
      title: result.title,
      description: result.description || undefined,
      status: result.status as TodoStatus,
      priority: result.priority as TodoPriority,
      category: result.category || undefined,
      tags,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      dueDate: result.dueDate || undefined,
      completedAt: result.completedAt || undefined,
      sourceNoteId: result.sourceNoteId || undefined,
      sourceText: result.sourceText || undefined,
      aiGenerated: !!result.aiGenerated,
      confidence: result.confidence || undefined,
      estimatedEffort: result.estimatedEffort || undefined,
      actionableSteps,
      context: result.context || undefined
    };
  }

  /**
   * Handle database errors consistently
   */
  private handleDatabaseError(error: any): Error {
    const message = error.message || 'Unknown database error';
    
    // Attach the TodosErrorCode
    const databaseError = new Error(message);
    (databaseError as any).code = TodosErrorCode.DATABASE_ERROR;
    
    return databaseError;
  }
}
