import { drizzle } from 'drizzle-orm/d1';
import { Bindings } from '../types';

/**
 * Creates a Drizzle ORM instance for the D1 database
 * @param env Environment bindings containing the D1 database
 * @returns Drizzle ORM instance
 */
export function getDb(env: Bindings) {
  return drizzle(env.D1_DATABASE);
}

/**
 * Error class for database-related errors
 */
export class DatabaseError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/**
 * Handles database errors by wrapping them in a DatabaseError
 * @param error The error to handle
 * @param operation The operation that caused the error
 * @returns A DatabaseError
 */
export function handleDatabaseError(error: unknown, operation: string): DatabaseError {
  console.error(`Database error during ${operation}:`, error);
  return new DatabaseError(`Error during database operation: ${operation}`, error);
}
