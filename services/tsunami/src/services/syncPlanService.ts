import { ulid } from 'ulid';
import { getLogger, logError, metrics } from '@dome/logging';
import { syncPlanOperations } from '../db/client';
import { ResourceObject } from '../resourceObject';
import { ProviderType } from '../providers';
import { Bindings } from '../types';

/* ─────────── custom errors ─────────── */
export class NotFoundError extends Error { }
export class AlreadyExistsError extends Error { }

export interface InitParams {
  resourceId: string;
  providerType: ProviderType;
  userId?: string;
}

export class SyncPlanService {
  private logger = getLogger();
  constructor(private env: Bindings) { }

  /* ─────────── Sync‑plan CRUD ─────────── */

  async getSyncPlan(resourceId: string) {
    const plan = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, resourceId);
    if (!plan) throw new NotFoundError(`Sync‑plan for "${resourceId}" not found`);
    return plan;
  }

  async createSyncPlan(provider: string, resourceId: string, userId?: string) {
    const exists = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, resourceId);
    if (exists) throw new AlreadyExistsError(`Sync‑plan for "${resourceId}" already exists`);

    const id = ulid();
    await syncPlanOperations.create(this.env.SYNC_PLAN, { id, provider, resourceId, userId });
    return id;
  }

  async attachUser(syncPlanId: string, userId: string) {
    await syncPlanOperations.addUserToSyncPlan(this.env.SYNC_PLAN, syncPlanId, userId);
  }

  /* ─────────── Resource lifecycle ─────────── */

  /** Ensure the Durable Object exists & is configured.
      @returns `true` if it was created on this call. */
  async initializeResource(
    { resourceId, providerType, userId }: InitParams,
    cadenceSecs = 3_600,
  ): Promise<boolean> {
    this.validateResourceId(providerType, resourceId);

    return this.wrap('initializeResource', async () => {
      const obj = this.getDurableObject(resourceId);

      // If `info()` succeeds we assume the object already exists.
      const { resourceId: configResourceId } = obj.info();
      getLogger().info({ resourceId, configResourceId }, 'Initialize: Resource id');
      if (resourceId === configResourceId) throw new Error(`Resource already exists: ${resourceId}`);

      console.log(`Initializing new resource object ${resourceId}`);
      await obj.initialize({
        userIds: userId ? [userId] : [],
        providerType,
        resourceId,
        cadenceSecs,
      });
      return true;
    });
  }

  /** Sync a resource that is already initialised. */
  async syncResource(resourceId: string, providerType: ProviderType, userId?: string) {
    this.validateResourceId(providerType, resourceId);

    return this.wrap('syncResource', async () => {
      const obj = this.getDurableObject(resourceId);
      if (userId) await obj.addUser(userId); // optional
      await obj.sync();
    });
  }

  /* ─────────── internals ─────────── */

  private getDurableObject(resourceId: string): ResourceObject {
    const id = (this.env as any).RESOURCE_OBJECT.idFromName(resourceId);
    return (this.env as any).RESOURCE_OBJECT.get(id);
  }

  private validateResourceId(pt: ProviderType, id: string) {
    if (!id) throw new Error('Empty resourceId');
    if (pt === ProviderType.GITHUB && !/^[^/]+\/[^/]+$/.test(id)) {
      throw new Error(`Invalid GitHub resourceId "${id}" (owner/repo required)`);
    }
  }

  private async wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logError(this.logger, err, `SyncPlanService.${op}`);
      metrics.increment(`tsunami.syncplan.${op}.errors`);
      throw err;
    }
  }
}

/* factory so the rest of the codebase changes ⟶ one line */
export const createSyncPlanService = (env: Bindings) => new SyncPlanService(env);
