import { BaseRepository } from './baseRepository';
import {
  Reminder,
  CreateReminderData,
  UpdateReminderData,
  DeliveryMethod,
} from '../models/reminder';
import { reminders } from '../db/schema';
import { eq, and, lte } from 'drizzle-orm';
import { getDb, handleDatabaseError } from '../db';
import { Bindings } from '../types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Repository for Reminder operations
 */
export class ReminderRepository extends BaseRepository<
  Reminder,
  CreateReminderData,
  UpdateReminderData
> {
  /**
   * Constructor
   */
  constructor() {
    super(reminders, reminders.id);
  }

  /**
   * Create a new reminder
   * @param env Environment bindings
   * @param data Reminder data
   * @returns Created reminder
   */
  async create(env: Bindings, data: CreateReminderData): Promise<Reminder> {
    try {
      const reminderData = {
        id: uuidv4(),
        taskId: data.taskId,
        remindAt: data.remindAt,
        delivered: false,
        deliveryMethod: data.deliveryMethod || DeliveryMethod.EMAIL,
        createdAt: Date.now(),
      };

      const db = getDb(env);
      const result = await db.insert(reminders).values(reminderData).returning().all();
      return result[0] as Reminder;
    } catch (error) {
      throw handleDatabaseError(error, 'create reminder');
    }
  }

  /**
   * Update a reminder
   * @param env Environment bindings
   * @param id Reminder ID
   * @param data Update data
   * @returns Updated reminder
   */
  async update(env: Bindings, id: string, data: UpdateReminderData): Promise<Reminder> {
    try {
      const db = getDb(env);
      const result = await db
        .update(reminders)
        .set(data)
        .where(eq(reminders.id, id))
        .returning()
        .all();

      if (result.length === 0) {
        throw new Error(`Reminder with ID ${id} not found`);
      }

      return result[0] as Reminder;
    } catch (error) {
      throw handleDatabaseError(error, `update reminder(${id})`);
    }
  }

  /**
   * Mark a reminder as delivered
   * @param env Environment bindings
   * @param id Reminder ID
   * @returns Updated reminder
   */
  async markDelivered(env: Bindings, id: string): Promise<Reminder> {
    try {
      const db = getDb(env);
      const result = await db
        .update(reminders)
        .set({ delivered: true })
        .where(eq(reminders.id, id))
        .returning()
        .all();

      if (result.length === 0) {
        throw new Error(`Reminder with ID ${id} not found`);
      }

      return result[0] as Reminder;
    } catch (error) {
      throw handleDatabaseError(error, `mark reminder delivered(${id})`);
    }
  }

  /**
   * Find reminders by task ID
   * @param env Environment bindings
   * @param taskId Task ID
   * @returns Array of reminders
   */
  async findByTaskId(env: Bindings, taskId: string): Promise<Reminder[]> {
    return this.findBy(env, reminders.taskId, taskId);
  }

  /**
   * Find due reminders that haven't been delivered yet
   * @param env Environment bindings
   * @param currentTime Current time in milliseconds
   * @returns Array of due reminders
   */
  async findDueReminders(env: Bindings, currentTime: number): Promise<Reminder[]> {
    try {
      const db = getDb(env);
      const results = await db
        .select()
        .from(reminders)
        .where(and(eq(reminders.delivered, false), lte(reminders.remindAt, currentTime)))
        .all();

      return results as Reminder[];
    } catch (error) {
      throw handleDatabaseError(error, `findDueReminders(${currentTime})`);
    }
  }

  /**
   * Find reminders by delivery method
   * @param env Environment bindings
   * @param deliveryMethod Delivery method
   * @returns Array of reminders
   */
  async findByDeliveryMethod(env: Bindings, deliveryMethod: DeliveryMethod): Promise<Reminder[]> {
    return this.findBy(env, reminders.deliveryMethod, deliveryMethod);
  }
}
