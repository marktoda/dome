/**
 * Database Client Module
 *
 * This module provides a Drizzle ORM client for interacting with the D1 database.
 * It includes helper functions for common database operations.
 *
 * @module db/client
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { getLogger, logError } from '@dome/logging';
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
      userId?: string;
      provider: string;
      resourceId: string;
    },
  ) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      // Initialize userIds as an array with the userId if provided
      const userIds = data.userId ? [data.userId] : [];

      const result = await client
        .insert(syncPlans)
        .values({
          id: data.id,
          userIds: JSON.stringify(userIds),
          provider: data.provider,
          resourceId: data.resourceId,
        })
        .returning();

      logger.info({ id: data.id }, 'Sync plan created');
      return result[0];
    } catch (error) {
      logError(logger, error, 'Error creating sync plan', { data });
      throw error;
    }
  },

  /**
   * Find a sync plan by resourceId
   *
   * @param db - The D1 database binding
   * @param resourceId - The resource identifier
   * @returns The sync plan or null if not found
   */
  async findByResourceId(db: D1Database, resourceId: string) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      const result = await client
        .select()
        .from(syncPlans)
        .where(eq(syncPlans.resourceId, resourceId))
        .limit(1);

      logger.info({ resourceId, found: result.length > 0 }, 'Find sync plan by resourceId');
      return result[0] || null;
    } catch (error) {
      logError(logger, error, 'Error finding sync plan by resourceId', { resourceId });
      throw error;
    }
  },

  /**
   * Update a sync plan with a new user ID
   *
   * @param db - The D1 database binding
   * @param id - The sync plan ID
   * @param userId - The user ID to add
   * @returns The updated sync plan
   */
  async addUserToSyncPlan(db: D1Database, id: string, userId: string) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      // First, get the current sync plan to retrieve existing userIds
      const syncPlan = await client.select().from(syncPlans).where(eq(syncPlans.id, id)).limit(1);

      if (!syncPlan.length) {
        throw new Error(`Sync plan with id ${id} not found`);
      }

      // Parse the userIds JSON array
      let userIdsArray: string[] = [];
      try {
        userIdsArray = JSON.parse(syncPlan[0].userIds);
      } catch (error) {
        logger.warn(
          { id, userIds: syncPlan[0].userIds },
          'Failed to parse userIds, using empty array',
        );
      }

      // Add the new userId if it doesn't already exist
      if (!userIdsArray.includes(userId)) {
        userIdsArray.push(userId);
      }

      // Update the sync plan with the new userIds array
      const result = await client
        .update(syncPlans)
        .set({ userIds: JSON.stringify(userIdsArray) })
        .where(eq(syncPlans.id, id))
        .returning();

      logger.info({ id, userId, userIds: userIdsArray }, 'User added to sync plan');
      return result[0];
    } catch (error) {
      logError(logger, error, 'Error adding user to sync plan', { id, userId });
      throw error;
    }
  },
};
