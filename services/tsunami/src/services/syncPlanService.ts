/**
 * SyncPlanService Module
 *
 * This module provides a service for managing sync plans and resource objects.
 * It includes generic helpers that can be reused across different resource providers.
 *
 * @module services/syncPlanService
 */

import { ulid } from 'ulid';
import { getLogger, logError, metrics } from '@dome/logging';
import { syncPlanOperations } from '../db/client';
import { ResourceObject } from '../resourceObject';
import { ProviderType } from '../providers';
import { Bindings } from '../types';

/**
 * SyncPlanService
 *
 * Provides generic helpers for sync plan management that can be
 * reused across different resource providers.
 */
export class SyncPlanService {
  constructor(private env: Bindings) {}

  /**
   * Find or create a sync plan for a resource
   *
   * @param provider - The provider type (github, notion, etc.)
   * @param resourceId - The resource identifier
   * @param userId - The user ID (optional)
   * @returns The sync plan ID and whether it was newly created
   */
  async findOrCreateSyncPlan(
    provider: string,
    resourceId: string,
    userId?: string,
  ): Promise<{
    id: string;
    isNew: boolean;
  }> {
    const logger = getLogger();

    try {
      // Check if a sync plan already exists for this resource
      const existingSyncPlan = await syncPlanOperations.findByResourceId(
        this.env.SYNC_PLAN,
        resourceId,
      );

      if (existingSyncPlan) {
        logger.info({ existingSyncPlan, userId, resourceId }, 'Resource already has a sync plan');

        // Add the user to the existing sync plan if provided
        if (userId) {
          await this.addUserToSyncPlan(existingSyncPlan.id, userId);
        }

        return {
          id: existingSyncPlan.id,
          isNew: false,
        };
      }

      // Create a new sync plan
      const id = ulid();

      await syncPlanOperations.create(this.env.SYNC_PLAN, {
        id,
        userId: userId, // This will be converted to an array in the create method
        provider,
        resourceId,
      });

      logger.info({ id, resourceId, provider }, 'New sync plan created');

      return {
        id,
        isNew: true,
      };
    } catch (error) {
      logError(logger, error, 'Error in findOrCreateSyncPlan', { provider, resourceId, userId });
      metrics.increment('tsunami.syncplan.errors', 1);
      throw error;
    }
  }

  /**
   * Add a user to an existing sync plan
   *
   * @param syncPlanId - The sync plan ID
   * @param userId - The user ID to add
   */
  async addUserToSyncPlan(syncPlanId: string, userId: string): Promise<void> {
    const logger = getLogger();

    try {
      await syncPlanOperations.addUserToSyncPlan(this.env.SYNC_PLAN, syncPlanId, userId);
      logger.info({ syncPlanId, userId }, 'User added to sync plan');
    } catch (error) {
      logError(logger, error, 'Error adding user to sync plan', { syncPlanId, userId });
      throw error;
    }
  }

  /**
   * Get a durable object for a resource
   *
   * @param resourceId - The resource identifier
   * @returns The durable object instance
   */
  getDurableObject(resourceId: string): ResourceObject {
    const doId = (this.env as any).RESOURCE_OBJECT.idFromName(resourceId);
    return (this.env as any).RESOURCE_OBJECT.get(doId);
  }

  /**
   * Initialize or sync a resource
   *
   * @param resourceId - The resource identifier
   * @param providerType - The provider type
   * @param userId - The user ID (optional)
   * @param cadenceSecs - The sync frequency in seconds (optional)
   * @returns Whether the resource was newly initialized
   */
  async initializeOrSyncResource(
    resourceId: string,
    providerType: ProviderType,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<boolean> {
    const logger = getLogger();
    const resourceObject = this.getDurableObject(resourceId);

    try {
      // Try to add the user to the existing resource object
      try {
        if (userId) await resourceObject.addUser(userId);
        await resourceObject.sync();

        logger.info({ resourceId, userId }, 'User added to existing resource object');
        return false;
      } catch (error) {
        // If addUser fails, it likely means the resource object doesn't exist yet
        // or hasn't been initialized, so we'll initialize it
        logger.info(
          { resourceId, error: error instanceof Error ? error.message : String(error) },
          'Resource object not initialized, initializing now',
        );
      }

      await resourceObject.initialize({
        userIds: userId ? [userId] : [],
        providerType,
        resourceId,
        cadenceSecs,
      });

      await resourceObject.sync();

      logger.info({ resourceId, providerType }, 'Resource object initialized and synced');
      return true;
    } catch (error) {
      logError(logger, error, 'Error in initializeOrSyncResource', {
        resourceId,
        providerType,
        userId,
      });
      throw error;
    }
  }
}

/**
 * Create a SyncPlanService instance
 *
 * @param env - The environment bindings
 * @returns A SyncPlanService instance
 */
export function createSyncPlanService(env: Bindings) {
  return new SyncPlanService(env);
}
