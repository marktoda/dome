/**
 * Database Client Module
 *
 * This module provides a Drizzle ORM client for interacting with the D1 database.
 * It includes helper functions for common database operations.
 *
 * @module db/client
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, and } from 'drizzle-orm';
import { getLogger, logError } from '@dome/logging';
import { syncPlans, syncHistory } from './schema';
import { ulid } from 'ulid';

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

/**
 * Database operations for sync history
 */
export const syncHistoryOperations = {
  /**
   * Create a new sync history entry
   *
   * @param db - The D1 database binding
   * @param data - The sync history data
   * @returns The created sync history entry
   */
  async create(
    db: D1Database,
    data: {
      syncPlanId: string;
      resourceId: string;
      provider: string;
      userId?: string;
      startedAt: number;
      completedAt: number;
      previousCursor?: string;
      newCursor?: string;
      filesProcessed: number;
      updatedFiles: string[];
      status: 'success' | 'error';
      errorMessage?: string;
    },
  ) {
    const logger = getLogger();
    const client = createDbClient(db);
    const id = ulid();

    try {
      const result = await client
        .insert(syncHistory)
        .values({
          id,
          syncPlanId: data.syncPlanId,
          resourceId: data.resourceId,
          provider: data.provider,
          userId: data.userId,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          previousCursor: data.previousCursor,
          newCursor: data.newCursor,
          filesProcessed: data.filesProcessed,
          updatedFiles: JSON.stringify(data.updatedFiles),
          status: data.status,
          errorMessage: data.errorMessage,
        })
        .returning();

      logger.info({ id, resourceId: data.resourceId }, 'Sync history entry created');
      return result[0];
    } catch (error) {
      logError(logger, error, 'Error creating sync history entry', { data });
      throw error;
    }
  },

  /**
   * Get sync history for a resource
   *
   * @param db - The D1 database binding
   * @param resourceId - The resource identifier
   * @param limit - Maximum number of entries to return (default: 10)
   * @returns Array of sync history entries
   */
  async getByResourceId(db: D1Database, resourceId: string, limit: number = 10) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      const result = await client
        .select()
        .from(syncHistory)
        .where(eq(syncHistory.resourceId, resourceId))
        .orderBy(desc(syncHistory.startedAt))
        .limit(limit);

      logger.info({ resourceId, count: result.length }, 'Retrieved sync history for resource');

      // Parse the updatedFiles JSON array for each entry
      return result.map(entry => ({
        ...entry,
        updatedFiles: JSON.parse(entry.updatedFiles),
      }));
    } catch (error) {
      logError(logger, error, 'Error getting sync history by resourceId', { resourceId });
      throw error;
    }
  },

  /**
   * Get sync history for a user
   *
   * @param db - The D1 database binding
   * @param userId - The user ID
   * @param limit - Maximum number of entries to return (default: 10)
   * @returns Array of sync history entries
   */
  async getByUserId(db: D1Database, userId: string, limit: number = 10) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      const result = await client
        .select()
        .from(syncHistory)
        .where(eq(syncHistory.userId, userId))
        .orderBy(desc(syncHistory.startedAt))
        .limit(limit);

      logger.info({ userId, count: result.length }, 'Retrieved sync history for user');

      // Parse the updatedFiles JSON array for each entry
      return result.map(entry => ({
        ...entry,
        updatedFiles: JSON.parse(entry.updatedFiles),
      }));
    } catch (error) {
      logError(logger, error, 'Error getting sync history by userId', { userId });
      throw error;
    }
  },

  /**
   * Get sync history for a specific sync plan
   *
   * @param db - The D1 database binding
   * @param syncPlanId - The sync plan ID
   * @param limit - Maximum number of entries to return (default: 10)
   * @returns Array of sync history entries
   */
  async getBySyncPlanId(db: D1Database, syncPlanId: string, limit: number = 10) {
    const logger = getLogger();
    const client = createDbClient(db);

    try {
      const result = await client
        .select()
        .from(syncHistory)
        .where(eq(syncHistory.syncPlanId, syncPlanId))
        .orderBy(desc(syncHistory.startedAt))
        .limit(limit);

      logger.info({ syncPlanId, count: result.length }, 'Retrieved sync history for sync plan');

      // Parse the updatedFiles JSON array for each entry
      return result.map(entry => ({
        ...entry,
        updatedFiles: JSON.parse(entry.updatedFiles),
      }));
    } catch (error) {
      logError(logger, error, 'Error getting sync history by syncPlanId', { syncPlanId });
      throw error;
    }
  },
};
