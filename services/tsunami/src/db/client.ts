/**
 * Database Client Module
 *
 * This module provides a Drizzle ORM client for interacting with the D1 database.
 * It includes helper functions for common database operations.
 *
 * @module db/client
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getLogger } from '@dome/logging';
import { syncPlans, syncHistory } from './schema';
import { Bindings } from '../types';

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
  async create(db: D1Database, data: {
    id: string;
    userId: string;
    provider: string;
    resourceId: string;
    cadenceSecs?: number;
  }) {
    const logger = getLogger();
    const client = createDbClient(db);
    
    try {
      const result = await client.insert(syncPlans)
        .values({
          id: data.id,
          userId: data.userId,
          provider: data.provider,
          resourceId: data.resourceId,
          cadenceSecs: data.cadenceSecs,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .returning();
      
      logger.info({ id: data.id }, 'Sync plan created');
      return result[0];
    } catch (error) {
      logger.error({ error, data }, 'Error creating sync plan');
      throw error;
    }
  },

  /**
   * Get a sync plan by ID
   *
   * @param db - The D1 database binding
   * @param id - The sync plan ID
   * @returns The sync plan or null if not found
   */
  async getById(db: D1Database, id: string) {
    const client = createDbClient(db);
    
    const results = await client.select()
      .from(syncPlans)
      .where(eq(syncPlans.id, id))
      .limit(1);
    
    return results[0] || null;
  },

  /**
   * Get sync plans by user ID
   *
   * @param db - The D1 database binding
   * @param userId - The user ID
   * @returns An array of sync plans
   */
  async getByUserId(db: D1Database, userId: string) {
    const client = createDbClient(db);
    
    return await client.select()
      .from(syncPlans)
      .where(eq(syncPlans.userId, userId));
  },

  /**
   * Get a sync plan by provider and resource ID
   *
   * @param db - The D1 database binding
   * @param provider - The provider type
   * @param resourceId - The resource ID
   * @returns The sync plan or null if not found
   */
  async getByProviderAndResourceId(db: D1Database, provider: string, resourceId: string) {
    const client = createDbClient(db);
    
    const results = await client.select()
      .from(syncPlans)
      .where(
        and(
          eq(syncPlans.provider, provider),
          eq(syncPlans.resourceId, resourceId)
        )
      )
      .limit(1);
    
    return results[0] || null;
  },

  /**
   * Delete a sync plan by ID
   *
   * @param db - The D1 database binding
   * @param id - The sync plan ID
   * @returns True if the sync plan was deleted, false otherwise
   */
  async deleteById(db: D1Database, id: string) {
    const client = createDbClient(db);
    
    const result = await client.delete(syncPlans)
      .where(eq(syncPlans.id, id))
      .returning({ id: syncPlans.id });
    
    return result.length > 0;
  },

  /**
   * Update the last synced timestamp and cursor for a sync plan
   *
   * @param db - The D1 database binding
   * @param id - The sync plan ID
   * @param cursor - The new cursor value
   * @returns The updated sync plan
   */
  async updateSyncStatus(db: D1Database, id: string, cursor: string) {
    const client = createDbClient(db);
    
    const now = Math.floor(Date.now() / 1000);
    
    const result = await client.update(syncPlans)
      .set({
        lastSyncedAt: now,
        lastCursor: cursor,
        updatedAt: now,
      })
      .where(eq(syncPlans.id, id))
      .returning();
    
    return result[0];
  }
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
  async create(db: D1Database, data: {
    syncPlanId: string;
    status: 'started' | 'success' | 'error';
    itemCount?: number;
    errorMessage?: string;
  }) {
    const logger = getLogger();
    const client = createDbClient(db);
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      const result = await client.insert(syncHistory)
        .values({
          syncPlanId: data.syncPlanId,
          status: data.status,
          itemCount: data.itemCount,
          errorMessage: data.errorMessage,
          startedAt: now,
          completedAt: data.status !== 'started' ? now : undefined,
        })
        .returning();
      
      logger.info({ id: result[0].id, syncPlanId: data.syncPlanId }, 'Sync history entry created');
      return result[0];
    } catch (error) {
      logger.error({ error, data }, 'Error creating sync history entry');
      throw error;
    }
  },

  /**
   * Update a sync history entry
   *
   * @param db - The D1 database binding
   * @param id - The sync history entry ID
   * @param data - The data to update
   * @returns The updated sync history entry
   */
  async update(db: D1Database, id: string, data: {
    status: 'success' | 'error';
    itemCount?: number;
    errorMessage?: string;
  }) {
    const client = createDbClient(db);
    
    const now = Math.floor(Date.now() / 1000);
    
    const result = await client.update(syncHistory)
      .set({
        status: data.status,
        itemCount: data.itemCount,
        errorMessage: data.errorMessage,
        completedAt: now,
      })
      .where(eq(syncHistory.id, id))
      .returning();
    
    return result[0];
  },

  /**
   * Get the latest sync history entries for a sync plan
   *
   * @param db - The D1 database binding
   * @param syncPlanId - The sync plan ID
   * @param limit - The maximum number of entries to return
   * @returns An array of sync history entries
   */
  async getLatestBySyncPlanId(db: D1Database, syncPlanId: string, limit = 10) {
    const client = createDbClient(db);
    
    return await client.select()
      .from(syncHistory)
      .where(eq(syncHistory.syncPlanId, syncPlanId))
      .orderBy(desc(syncHistory.startedAt))
      .limit(limit);
  }
};