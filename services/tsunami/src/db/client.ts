/**
 * Database Client Module
 *
 * This module provides a Drizzle ORM client for interacting with the D1 database.
 * It includes helper functions for common database operations.
 *
 * @module db/client
 */

import { drizzle } from 'drizzle-orm/d1';
import { getLogger } from '@dome/logging';
import { syncPlans } from './schema';

/**
 * Create a Drizzle ORM client for the D1 database
 *
 * @param db - The D1 database binding
 * @returns A Drizzle ORM client
 */
export function createDbClient(db: D1Database) {
  return drizzle(db);
}

/**
 * Database operations for sync plans
 */
export const syncPlanOperations = {
  /**
   * Create a new sync plan
   *
   * @param db - The D1 database binding
   * @param data - The sync plan data
   * @returns The created sync plan
   */
  async create(
    db: D1Database,
    data: {
      id: string;
      userId: string;
      provider: string;
      resourceId: string;
    },
  ) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      const result = await client
        .insert(syncPlans)
        .values({
          id: data.id,
          userId: data.userId,
          provider: data.provider,
          resourceId: data.resourceId,
        })
        .returning();

      logger.info({ id: data.id }, 'Sync plan created');
      return result[0];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, data }, 'Error creating sync plan');
      throw error;
    }
  },
};
