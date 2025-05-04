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
import { getLogger, logError, trackOperation, getRequestId } from '@dome/common';
import { toDomeError, handleDatabaseError, assertExists, NotFoundError } from '@dome/errors';
import { assertValid } from '../utils/errors';
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
    const requestId = getRequestId();
    const client = createDbClient(db);

    return trackOperation(
      'create_sync_plan',
      async () => {
        try {
          // Validate inputs
          assertValid(data.id && data.id.trim().length > 0, 'Sync plan ID cannot be empty', {
            operation: 'create_sync_plan',
            requestId,
          });
          assertValid(
            data.provider && data.provider.trim().length > 0,
            'Provider cannot be empty',
            {
              operation: 'create_sync_plan',
              requestId,
            },
          );
          assertValid(
            data.resourceId && data.resourceId.trim().length > 0,
            'Resource ID cannot be empty',
            {
              operation: 'create_sync_plan',
              requestId,
            },
          );

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

          logger.info(
            {
              event: 'sync_plan_created',
              id: data.id,
              provider: data.provider,
              resourceId: data.resourceId,
              userId: data.userId,
              requestId,
            },
            'Sync plan created successfully',
          );

          return result[0];
        } catch (error) {
          const domeError = handleDatabaseError(error, 'create_sync_plan', {
            resourceId: data.resourceId,
            provider: data.provider,
            requestId,
          });

          logError(domeError, `Error creating sync plan for ${data.resourceId}`);
          throw domeError;
        }
      },
      { resourceId: data.resourceId, provider: data.provider, requestId },
    );
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
    const requestId = getRequestId();
    const client = createDbClient(db);

    return trackOperation(
      'find_sync_plan_by_resource_id',
      async () => {
        try {
          // Validate input
          assertValid(resourceId && resourceId.trim().length > 0, 'Resource ID cannot be empty', {
            operation: 'find_sync_plan_by_resource_id',
            requestId,
          });

          const result = await client
            .select()
            .from(syncPlans)
            .where(eq(syncPlans.resourceId, resourceId))
            .limit(1);

          logger.info(
            {
              event: 'sync_plan_lookup',
              resourceId,
              found: result.length > 0,
              requestId,
            },
            `Sync plan lookup for resource ${resourceId}: ${
              result.length > 0 ? 'found' : 'not found'
            }`,
          );

          return result[0] || null;
        } catch (error) {
          const domeError = handleDatabaseError(error, 'find_sync_plan_by_resource_id', {
            resourceId,
            requestId,
          });

          logError(domeError, `Error finding sync plan for resource ${resourceId}`);
          throw domeError;
        }
      },
      { resourceId, requestId },
    );
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
    const requestId = getRequestId();
    const client = createDbClient(db);

    return trackOperation(
      'add_user_to_sync_plan',
      async () => {
        try {
          // Validate inputs
          assertValid(id && id.trim().length > 0, 'Sync plan ID cannot be empty', {
            operation: 'add_user_to_sync_plan',
            requestId,
          });
          assertValid(userId && userId.trim().length > 0, 'User ID cannot be empty', {
            operation: 'add_user_to_sync_plan',
            id,
            requestId,
          });

          // First, get the current sync plan to retrieve existing userIds
          const syncPlan = await client
            .select()
            .from(syncPlans)
            .where(eq(syncPlans.id, id))
            .limit(1);

          // Check if plan exists
          assertExists(syncPlan[0], `Sync plan with id ${id} not found`, {
            operation: 'add_user_to_sync_plan',
            id,
            userId,
            requestId,
          });

          // Parse the userIds JSON array
          let userIdsArray: string[] = [];
          try {
            userIdsArray = JSON.parse(syncPlan[0].userIds);
          } catch (error) {
            logger.warn(
              {
                event: 'user_ids_parse_error',
                id,
                userIds: syncPlan[0].userIds,
                error: error instanceof Error ? error.message : String(error),
                requestId,
              },
              'Failed to parse userIds, using empty array',
            );
          }

          // Add the new userId if it doesn't already exist
          if (!userIdsArray.includes(userId)) {
            userIdsArray.push(userId);
            logger.debug(
              {
                event: 'adding_user_to_plan',
                id,
                userId,
                requestId,
              },
              `Adding user ${userId} to sync plan ${id}`,
            );
          } else {
            logger.debug(
              {
                event: 'user_already_in_plan',
                id,
                userId,
                requestId,
              },
              `User ${userId} already exists in sync plan ${id}`,
            );
          }

          // Update the sync plan with the new userIds array
          const result = await client
            .update(syncPlans)
            .set({ userIds: JSON.stringify(userIdsArray) })
            .where(eq(syncPlans.id, id))
            .returning();

          logger.info(
            {
              event: 'user_added_to_plan',
              id,
              userId,
              userIdsCount: userIdsArray.length,
              requestId,
            },
            `User ${userId} added to sync plan ${id} (total users: ${userIdsArray.length})`,
          );

          return result[0];
        } catch (error) {
          const domeError = handleDatabaseError(error, 'add_user_to_sync_plan', {
            id,
            userId,
            requestId,
          });

          logError(domeError, `Error adding user ${userId} to sync plan ${id}`);
          throw domeError;
        }
      },
      { id, userId, requestId },
    );
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
    const requestId = getRequestId();
    const client = createDbClient(db);
    const id = ulid();

    return trackOperation(
      'create_sync_history',
      async () => {
        try {
          // Validate inputs
          assertValid(
            data.syncPlanId && data.syncPlanId.trim().length > 0,
            'Sync plan ID cannot be empty',
            {
              operation: 'create_sync_history',
              requestId,
            },
          );
          assertValid(
            data.resourceId && data.resourceId.trim().length > 0,
            'Resource ID cannot be empty',
            {
              operation: 'create_sync_history',
              syncPlanId: data.syncPlanId,
              requestId,
            },
          );
          assertValid(
            data.provider && data.provider.trim().length > 0,
            'Provider cannot be empty',
            {
              operation: 'create_sync_history',
              syncPlanId: data.syncPlanId,
              resourceId: data.resourceId,
              requestId,
            },
          );

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

          logger.info(
            {
              event: 'sync_history_created',
              id,
              syncPlanId: data.syncPlanId,
              resourceId: data.resourceId,
              status: data.status,
              filesProcessed: data.filesProcessed,
              updatedFilesCount: data.updatedFiles.length,
              duration: data.completedAt - data.startedAt,
              requestId,
            },
            `Sync history entry created for ${data.resourceId} (${data.status}, ${data.filesProcessed} files processed)`,
          );

          return result[0];
        } catch (error) {
          const domeError = handleDatabaseError(error, 'create_sync_history', {
            syncPlanId: data.syncPlanId,
            resourceId: data.resourceId,
            status: data.status,
            requestId,
          });

          logError(domeError, `Error creating sync history entry for ${data.resourceId}`);
          throw domeError;
        }
      },
      { syncPlanId: data.syncPlanId, resourceId: data.resourceId, requestId },
    );
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
    const requestId = getRequestId();
    const client = createDbClient(db);

    return trackOperation(
      'get_sync_history_by_resource',
      async () => {
        try {
          // Validate inputs
          assertValid(resourceId && resourceId.trim().length > 0, 'Resource ID cannot be empty', {
            operation: 'get_sync_history_by_resource',
            requestId,
          });
          assertValid(limit > 0, 'Limit must be greater than 0', {
            operation: 'get_sync_history_by_resource',
            resourceId,
            limit,
            requestId,
          });

          const result = await client
            .select()
            .from(syncHistory)
            .where(eq(syncHistory.resourceId, resourceId))
            .orderBy(desc(syncHistory.startedAt))
            .limit(limit);

          logger.info(
            {
              event: 'sync_history_retrieved',
              resourceId,
              count: result.length,
              limit,
              requestId,
            },
            `Retrieved ${result.length} sync history entries for resource ${resourceId}`,
          );

          // Parse the updatedFiles JSON array for each entry
          return result.map(entry => {
            try {
              return {
                ...entry,
                updatedFiles: JSON.parse(entry.updatedFiles),
              };
            } catch (error) {
              logger.warn(
                {
                  event: 'updated_files_parse_error',
                  historyId: entry.id,
                  resourceId,
                  updatedFiles: entry.updatedFiles,
                  requestId,
                },
                `Failed to parse updatedFiles for history entry ${entry.id}`,
              );

              return {
                ...entry,
                updatedFiles: [],
              };
            }
          });
        } catch (error) {
          const domeError = handleDatabaseError(error, 'get_sync_history_by_resource', {
            resourceId,
            limit,
            requestId,
          });

          logError(domeError, `Error retrieving sync history for resource ${resourceId}`);
          throw domeError;
        }
      },
      { resourceId, limit, requestId },
    );
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
    const requestId = getRequestId();
    const client = createDbClient(db);

    return trackOperation(
      'get_sync_history_by_user',
      async () => {
        try {
          // Validate inputs
          assertValid(userId && userId.trim().length > 0, 'User ID cannot be empty', {
            operation: 'get_sync_history_by_user',
            requestId,
          });
          assertValid(limit > 0, 'Limit must be greater than 0', {
            operation: 'get_sync_history_by_user',
            userId,
            limit,
            requestId,
          });

          const result = await client
            .select()
            .from(syncHistory)
            .where(eq(syncHistory.userId, userId))
            .orderBy(desc(syncHistory.startedAt))
            .limit(limit);

          logger.info(
            {
              event: 'user_sync_history_retrieved',
              userId,
              count: result.length,
              limit,
              requestId,
            },
            `Retrieved ${result.length} sync history entries for user ${userId}`,
          );

          // Parse the updatedFiles JSON array for each entry
          return result.map(entry => {
            try {
              return {
                ...entry,
                updatedFiles: JSON.parse(entry.updatedFiles),
              };
            } catch (error) {
              logger.warn(
                {
                  event: 'updated_files_parse_error',
                  historyId: entry.id,
                  userId,
                  updatedFiles: entry.updatedFiles,
                  requestId,
                },
                `Failed to parse updatedFiles for history entry ${entry.id}`,
              );

              return {
                ...entry,
                updatedFiles: [],
              };
            }
          });
        } catch (error) {
          const domeError = handleDatabaseError(error, 'get_sync_history_by_user', {
            userId,
            limit,
            requestId,
          });

          logError(domeError, `Error retrieving sync history for user ${userId}`);
          throw domeError;
        }
      },
      { userId, limit, requestId },
    );
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
    const requestId = getRequestId();
    const client = createDbClient(db);

    return trackOperation(
      'get_sync_history_by_plan',
      async () => {
        try {
          // Validate inputs
          assertValid(syncPlanId && syncPlanId.trim().length > 0, 'Sync plan ID cannot be empty', {
            operation: 'get_sync_history_by_plan',
            requestId,
          });
          assertValid(limit > 0, 'Limit must be greater than 0', {
            operation: 'get_sync_history_by_plan',
            syncPlanId,
            limit,
            requestId,
          });

          const result = await client
            .select()
            .from(syncHistory)
            .where(eq(syncHistory.syncPlanId, syncPlanId))
            .orderBy(desc(syncHistory.startedAt))
            .limit(limit);

          logger.info(
            {
              event: 'plan_sync_history_retrieved',
              syncPlanId,
              count: result.length,
              limit,
              requestId,
            },
            `Retrieved ${result.length} sync history entries for sync plan ${syncPlanId}`,
          );

          // Parse the updatedFiles JSON array for each entry
          return result.map(entry => {
            try {
              return {
                ...entry,
                updatedFiles: JSON.parse(entry.updatedFiles),
              };
            } catch (error) {
              logger.warn(
                {
                  event: 'updated_files_parse_error',
                  historyId: entry.id,
                  syncPlanId,
                  updatedFiles: entry.updatedFiles,
                  requestId,
                },
                `Failed to parse updatedFiles for history entry ${entry.id}`,
              );

              return {
                ...entry,
                updatedFiles: [],
              };
            }
          });
        } catch (error) {
          const domeError = handleDatabaseError(error, 'get_sync_history_by_plan', {
            syncPlanId,
            limit,
            requestId,
          });

          logError(domeError, `Error retrieving sync history for sync plan ${syncPlanId}`);
          throw domeError;
        }
      },
      { syncPlanId, limit, requestId },
    );
  },
};
