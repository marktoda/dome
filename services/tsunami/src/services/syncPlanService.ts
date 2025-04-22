/**
 * SyncPlanService – simplified
 */
import { ulid } from 'ulid';
import { getLogger, logError, metrics } from '@dome/logging';
import { syncPlanOperations } from '../db/client';
import { ResourceObject } from '../resourceObject';
import { ProviderType } from '../providers';
import { Bindings } from '../types';

export class SyncPlanService {
  private logger = getLogger();
  constructor(private env: Bindings) {}

  /* ---------- public API ---------- */

  async findOrCreateSyncPlan(provider: string, resourceId: string, userId?: string) {
    return this.wrap('findOrCreateSyncPlan', async () => {
      const existing = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, resourceId);

      if (existing) {
        if (userId) await this.addUserToSyncPlan(existing.id, userId);
        return { id: existing.id, isNew: false };
      }

      const id = ulid();
      await syncPlanOperations.create(this.env.SYNC_PLAN, {
        id,
        provider,
        resourceId,
        userId,
      });

      return { id, isNew: true };
    });
  }

  async addUserToSyncPlan(id: string, userId: string) {
    return this.wrap('addUserToSyncPlan', () =>
      syncPlanOperations.addUserToSyncPlan(this.env.SYNC_PLAN, id, userId),
    );
  }

  async initializeOrSyncResource(
    resourceId: string,
    providerType: ProviderType,
    userId?: string,
    cadenceSecs = 3600,
  ): Promise<boolean> {
    return this.wrap('initializeOrSyncResource', async () => {
      // Validate resourceId before proceeding
      if (!resourceId) {
        throw new Error('Empty resourceId. Cannot initialize or sync resource.');
      }

      // For GitHub provider, validate the resourceId format (owner/repo)
      if (providerType === ProviderType.GITHUB) {
        const [owner, repo] = resourceId.split('/');
        if (!owner || !repo) {
          throw new Error(
            `Invalid resourceId format for GitHub: ${resourceId}. Expected format: owner/repo`,
          );
        }
      }

      const obj = this.getDurableObject(resourceId);

      // Try fast‑path (resource already exists)
      try {
        if (userId) await obj.addUser(userId);
        await obj.sync();
        this.logger.info(
          { resourceId, providerType },
          'Resource synced successfully (existing resource)',
        );
        return false;
      } catch (error) {
        this.logger.info(
          {
            resourceId,
            providerType,
            error: error instanceof Error ? error.message : String(error),
          },
          'Resource does not exist or sync failed, attempting initialization',
        );
        /* fallthrough – object does not exist or sync failed */
      }

      try {
        await obj.initialize({
          userIds: userId ? [userId] : [],
          providerType,
          resourceId,
          cadenceSecs,
        });
        await obj.sync();
        this.logger.info(
          { resourceId, providerType },
          'Resource initialized and synced successfully',
        );
        return true;
      } catch (error) {
        this.logger.error(
          {
            resourceId,
            providerType,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to initialize or sync resource',
        );
        throw error;
      }
    });
  }

  /* ---------- private helpers ---------- */

  private getDurableObject(resourceId: string): ResourceObject {
    const id = (this.env as any).RESOURCE_OBJECT.idFromName(resourceId);
    return (this.env as any).RESOURCE_OBJECT.get(id);
  }

  /** standardised try/catch + metrics wrapper */
  private async wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logError(this.logger, err, `SyncPlanService.${op}`);
      metrics.increment(`tsunami.syncplan.${op}.errors`, 1);
      throw err;
    }
  }
}

/** factory used by existing code */
export const createSyncPlanService = (env: Bindings) => new SyncPlanService(env);
