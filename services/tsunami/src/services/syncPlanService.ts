import { ulid } from 'ulid';
import { getLogger, logError, metrics, trackOperation, getRequestId } from '@dome/common';
import type { ServiceEnv } from '../config/env';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  InternalError,
  toDomeError,
  domeAssertExists as assertExists,
} from '@dome/common';
import { assertValid } from '../utils/errors';
import { syncPlanOperations } from '../db/client';
import { ResourceObject } from '../resourceObject';
import { ProviderType } from '../providers';

export interface InitParams {
  resourceId: string;
  providerType: ProviderType;
  userId?: string;
}

export class SyncPlanService {
  private logger = getLogger();
  private domain = 'tsunami.syncPlanService';

  constructor(private env: ServiceEnv) {}

  /* ─────────── Sync‑plan CRUD ─────────── */

  async getSyncPlan(resourceId: string) {
    return trackOperation(
      'getSyncPlan',
      async () => {
        assertValid(resourceId && resourceId.trim().length > 0, 'ResourceId cannot be empty', {
          resourceId,
        });

        const plan = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, resourceId);
        return assertExists(plan, `Sync‑plan for "${resourceId}" not found`, {
          resourceId,
          operation: 'getSyncPlan',
        });
      },
      { resourceId, requestId: getRequestId() },
    );
  }

  async createSyncPlan(provider: string, resourceId: string, userId?: string) {
    return trackOperation(
      'createSyncPlan',
      async () => {
        assertValid(provider && provider.trim().length > 0, 'Provider cannot be empty', {
          provider,
          resourceId,
        });
        assertValid(resourceId && resourceId.trim().length > 0, 'ResourceId cannot be empty', {
          provider,
          resourceId,
        });

        const exists = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, resourceId);
        if (exists) {
          throw new ConflictError(`Sync‑plan for "${resourceId}" already exists`, {
            resourceId,
            operation: 'createSyncPlan',
            existingPlanId: exists.id,
          });
        }

        const id = ulid();
        await syncPlanOperations.create(this.env.SYNC_PLAN, { id, provider, resourceId, userId });

        this.logger.info(
          {
            event: 'sync_plan_created',
            id,
            provider,
            resourceId,
            userId,
            requestId: getRequestId(),
          },
          `Created new sync plan for ${resourceId}`,
        );

        return id;
      },
      { provider, resourceId, userId, requestId: getRequestId() },
    );
  }

  async attachUser(syncPlanId: string, userId: string) {
    return trackOperation(
      'attachUser',
      async () => {
        assertValid(syncPlanId && syncPlanId.trim().length > 0, 'SyncPlanId cannot be empty', {
          syncPlanId,
          userId,
        });
        assertValid(userId && userId.trim().length > 0, 'UserId cannot be empty', {
          syncPlanId,
          userId,
        });

        try {
          await syncPlanOperations.addUserToSyncPlan(this.env.SYNC_PLAN, syncPlanId, userId);

          this.logger.info(
            {
              event: 'user_attached_to_plan',
              syncPlanId,
              userId,
              requestId: getRequestId(),
            },
            `User ${userId} attached to sync plan ${syncPlanId}`,
          );
        } catch (error) {
          throw toDomeError(error, `Failed to attach user ${userId} to sync plan ${syncPlanId}`, {
            syncPlanId,
            userId,
            operation: 'attachUser',
          });
        }
      },
      { syncPlanId, userId, requestId: getRequestId() },
    );
  }

  /* ─────────── Resource lifecycle ─────────── */

  /** Ensure the Durable Object exists & is configured.
      @returns `true` if it was created on this call. */
  async initializeResource(
    { resourceId, providerType, userId }: InitParams,
    cadenceSecs = 3_600,
  ): Promise<boolean> {
    this.validateResourceId(providerType, resourceId);

    return trackOperation(
      'initializeResource',
      async () => {
        const obj = this.getDurableObject(resourceId);

        try {
          // If `info()` succeeds we assume the object already exists.
          const { resourceId: configResourceId } = obj.info();
          this.logger.info(
            {
              event: 'initialize_resource_check',
              resourceId,
              configResourceId,
              requestId: getRequestId(),
            },
            'Checking if resource already exists',
          );

          if (resourceId === configResourceId) {
            throw new ConflictError(`Resource already exists: ${resourceId}`, {
              resourceId,
              configResourceId,
              operation: 'initializeResource',
            });
          }
        } catch (error) {
          // If the error is not our ConflictError, it means the resource doesn't exist yet
          if (!(error instanceof ConflictError)) {
            this.logger.info(
              {
                event: 'resource_not_exists',
                resourceId,
                requestId: getRequestId(),
              },
              `Resource ${resourceId} doesn't exist yet, will initialize`,
            );
          } else {
            throw error;
          }
        }

        this.logger.info(
          {
            event: 'initializing_resource',
            resourceId,
            providerType,
            userId,
            cadenceSecs,
            requestId: getRequestId(),
          },
          `Initializing new resource object ${resourceId}`,
        );

        await obj.initialize({
          userIds: userId ? [userId] : [],
          providerType,
          resourceId,
          cadenceSecs,
        });

        return true;
      },
      { resourceId, providerType, userId, cadenceSecs, requestId: getRequestId() },
    );
  }

  /** Sync a resource that is already initialised. */
  async syncResource(resourceId: string, providerType: ProviderType, userId?: string) {
    this.validateResourceId(providerType, resourceId);

    return trackOperation(
      'syncResource',
      async () => {
        const obj = this.getDurableObject(resourceId);

        if (userId) {
          this.logger.info(
            {
              event: 'adding_user_to_resource',
              resourceId,
              userId,
              requestId: getRequestId(),
            },
            `Adding user ${userId} to resource ${resourceId}`,
          );

          await obj.addUser(userId);
        }

        this.logger.info(
          {
            event: 'sync_resource_start',
            resourceId,
            providerType,
            userId,
            requestId: getRequestId(),
          },
          `Starting sync for resource ${resourceId}`,
        );

        await obj.sync();

        this.logger.info(
          {
            event: 'sync_resource_complete',
            resourceId,
            providerType,
            userId,
            requestId: getRequestId(),
          },
          `Completed sync for resource ${resourceId}`,
        );
      },
      { resourceId, providerType, userId, requestId: getRequestId() },
    );
  }

  /* ─────────── internals ─────────── */

  private getDurableObject(resourceId: string): ResourceObject {
    const id = (this.env as any).RESOURCE_OBJECT.idFromName(resourceId);
    return (this.env as any).RESOURCE_OBJECT.get(id);
  }

  private validateResourceId(pt: ProviderType, id: string) {
    assertValid(id && id.trim().length > 0, 'ResourceId cannot be empty', {
      providerType: pt,
      operation: 'validateResourceId',
    });

    if (pt === ProviderType.GITHUB) {
      assertValid(
        /^[^/]+\/[^/]+$/.test(id),
        `Invalid GitHub resourceId "${id}" (owner/repo required)`,
        {
          providerType: pt,
          resourceId: id,
          operation: 'validateResourceId',
          pattern: 'owner/repo',
        },
      );
    }
  }

  private async wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const domeError = toDomeError(err, `SyncPlanService.${op} failed`, {
        operation: op,
        service: 'SyncPlanService',
        domain: this.domain,
        requestId: getRequestId(),
      });

      logError(domeError, `SyncPlanService.${op} operation failed`);
      metrics.increment(`tsunami.syncplan.${op}.errors`);
      metrics.trackOperation(`tsunami.syncplan.${op}`, false);

      throw domeError;
    }
  }
}

/* factory so the rest of the codebase changes ⟶ one line */
export const createSyncPlanService = (env: ServiceEnv) => new SyncPlanService(env);
