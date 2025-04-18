import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { getDb, handleDatabaseError } from '../db';
import { Bindings } from '../types';

/**
 * Base repository class with common CRUD operations
 */
export abstract class BaseRepository<T, CreateData, UpdateData> {
  protected table: SQLiteTable;
  protected idField: any; // This will be the actual field from the table schema

  /**
   * Constructor
   * @param table The Drizzle table
   * @param idField The ID field from the table schema
   */
  constructor(table: SQLiteTable, idField: any) {
    this.table = table;
    this.idField = idField;
  }

  /**
   * Find all records
   * @param env Environment bindings
   * @returns Array of records
   */
  async findAll(env: Bindings): Promise<T[]> {
    try {
      const db = getDb(env);
      const results = await db.select().from(this.table).all();
      return results as T[];
    } catch (error) {
      throw handleDatabaseError(error, 'findAll');
    }
  }

  /**
   * Find records by a specific field value
   * @param env Environment bindings
   * @param field The field to filter by
   * @param value The value to filter for
   * @returns Array of records
   */
  async findBy(env: Bindings, field: any, value: string | number): Promise<T[]> {
    try {
      const db = getDb(env);
      const results = await db.select().from(this.table).where(eq(field, value)).all();

      return results as T[];
    } catch (error) {
      throw handleDatabaseError(error, `findBy(${field.name}, ${value})`);
    }
  }

  /**
   * Find a record by ID
   * @param env Environment bindings
   * @param id Record ID
   * @returns Record or null if not found
   */
  async findById(env: Bindings, id: string): Promise<T | null> {
    try {
      const db = getDb(env);
      const results = await db.select().from(this.table).where(eq(this.idField, id)).all();

      return results.length > 0 ? (results[0] as T) : null;
    } catch (error) {
      throw handleDatabaseError(error, `findById(${id})`);
    }
  }

  /**
   * Create a new record
   * @param env Environment bindings
   * @param data Record data
   * @returns Created record
   */
  async create(env: Bindings, data: CreateData): Promise<T> {
    try {
      const db = getDb(env);
      const result = await db
        .insert(this.table)
        .values(data as any)
        .returning()
        .all();
      return result[0] as T;
    } catch (error) {
      throw handleDatabaseError(error, 'create');
    }
  }

  /**
   * Update a record
   * @param env Environment bindings
   * @param id Record ID
   * @param data Update data
   * @returns Updated record
   */
  async update(env: Bindings, id: string, data: UpdateData): Promise<T> {
    try {
      const db = getDb(env);
      const result = await db
        .update(this.table)
        .set(data as any)
        .where(eq(this.idField, id))
        .returning()
        .all();

      if (result.length === 0) {
        throw new Error(`Record with ID ${id} not found`);
      }

      return result[0] as T;
    } catch (error) {
      throw handleDatabaseError(error, `update(${id})`);
    }
  }

  /**
   * Delete a record
   * @param env Environment bindings
   * @param id Record ID
   * @returns True if deleted, false if not found
   */
  async delete(env: Bindings, id: string): Promise<boolean> {
    try {
      const db = getDb(env);
      const result = await db.delete(this.table).where(eq(this.idField, id)).returning().all();

      return result.length > 0;
    } catch (error) {
      throw handleDatabaseError(error, `delete(${id})`);
    }
  }
}
