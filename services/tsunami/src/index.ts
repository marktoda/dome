/**
 * Tsunami Service – using WorkerEntrypoint pattern
 */
import { BaseWorker, getLogger, ServiceInfo, logError } from '@dome/common';
import { toDomeError } from './utils/errors';
import { ConflictError, ValidationError } from '@dome/common/errors';
import { createSyncPlanService } from './services/syncPlanService';
import { TokenService } from './services/tokenService';
import type { NotionOAuthDetails, GithubOAuthDetails } from './client/types'; // Added GithubOAuthDetails
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { IngestQueue } from '@dome/silo/queues';
import { loadEnv } from '@dome/common/config/env';
import { TsunamiEnvSchema, ServiceEnv } from './config/env';
import { syncHistoryOperations } from './db/client';
import { ProviderType } from './providers';

export { ResourceObject } from './resourceObject';

/* ─────────── shared utils ─────────── */

const logger = getLogger();

const buildServices = (env: ServiceEnv) => ({
  silo: new SiloClient(env.SILO, new IngestQueue(env.SILO_INGEST_QUEUE)),
  syncPlan: createSyncPlanService(env),
  token: new TokenService(env.SYNC_PLAN, env.TOKEN_ENCRYPTION_KEY),
});

/* ─────────── service bootstrap ─────────── */

const serviceInfo: ServiceInfo = {
  name: 'tsunami',
  version: '0.1.0',
  environment: 'development',
};

logger.info(
  {
    event: 'service_start',
    ...serviceInfo,
  },
  'Starting Tsunami service',
);

/**
 * Tsunami Service WorkerEntrypoint implementation
 *
 * This service manages GitHub repository syncing and provides
 * endpoints for registering repos and viewing sync history.
 */
export default class Tsunami extends BaseWorker<ServiceEnv, ReturnType<typeof buildServices>> {
  constructor(ctx: ExecutionContext, env: unknown) {
    const parsedEnv = loadEnv<ServiceEnv>(TsunamiEnvSchema, env);
    super(ctx, parsedEnv, buildServices, { serviceName: 'tsunami' });
  }

  /**
   * Creates a new sync plan
   *
   * @param providerType - The provider type (e.g., 'github')
   * @param resourceId - The resource identifier (e.g., 'owner/repo')
   * @param userId - Optional user ID to associate with the plan
   * @returns The sync plan ID
   */
  async createSyncPlan(providerType: string, resourceId: string, userId?: string): Promise<string> {
    const requestId = crypto.randomUUID();

    return this.wrap(
      {
        operation: 'create_sync_plan',
        resourceId,
        userId,
        requestId,
      },
      () => this.services.syncPlan.createSyncPlan(providerType, resourceId, userId),
    );
  }

  /**
   * Gets an existing sync plan by resource ID
   *
   * @param resourceId - The resource identifier
   * @returns The sync plan details
   */
  async getSyncPlan(resourceId: string): Promise<any> {
    const requestId = crypto.randomUUID();

    return this.wrap(
      {
        operation: 'get_sync_plan',
        resourceId,
        requestId,
      },
      () => this.services.syncPlan.getSyncPlan(resourceId),
    );
  }

  /**
   * Attaches a user to a sync plan
   *
   * @param syncPlanId - The sync plan ID
   * @param userId - The user ID to attach
   */
  async attachUser(syncPlanId: string, userId: string): Promise<void> {
    const requestId = crypto.randomUUID();

    await this.wrap(
      {
        operation: 'attach_user_to_plan',
        syncPlanId,
        userId,
        requestId,
      },
      () => this.services.syncPlan.attachUser(syncPlanId, userId),
    );
  }

  /**
   * Initializes a resource for syncing
   *
   * @param params - The resource parameters
   * @param cadenceSecs - The sync frequency in seconds
   * @returns Boolean indicating if the resource was newly created
   */
  async initializeResource(
    params: { resourceId: string; providerType: string; userId?: string },
    cadenceSecs: number,
  ): Promise<boolean> {
    const requestId = crypto.randomUUID();

    // Convert string provider type to enum
    const providerTypeEnum =
      params.providerType.toUpperCase() === 'GITHUB' ? ProviderType.GITHUB : ProviderType.NOTION;

    return this.wrap(
      {
        operation: 'initialize_resource',
        resourceId: params.resourceId,
        userId: params.userId,
        requestId,
      },
      () =>
        this.services.syncPlan.initializeResource(
          {
            ...params,
            providerType: providerTypeEnum,
          },
          cadenceSecs,
        ),
    );
  }

  /**
   * Gets sync history by resource ID
   *
   * @param resourceId - The resource identifier
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryByResourceId(resourceId: string, limit: number): Promise<unknown[]> {
    return await syncHistoryOperations.getByResourceId(this.env.SYNC_PLAN, resourceId, limit);
  }

  /**
   * Gets sync history by user ID
   *
   * @param userId - The user ID
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryByUserId(userId: string, limit: number): Promise<unknown[]> {
    return await syncHistoryOperations.getByUserId(this.env.SYNC_PLAN, userId, limit);
  }

  /**
   * Gets sync history by sync plan ID
   *
   * @param syncPlanId - The sync plan ID
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryBySyncPlanId(syncPlanId: string, limit: number): Promise<unknown[]> {
    return await syncHistoryOperations.getBySyncPlanId(this.env.SYNC_PLAN, syncPlanId, limit);
  }

  /**
   * Generic helper to register and initialize a resource for syncing.
   * Consolidates shared logic across provider-specific registration methods.
   */
  private async _registerResource(
    providerType: ProviderType,
    resourceId: string,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    const requestId = crypto.randomUUID();

    this.logger.info(
      {
        event: 'resource_registration_start',
        providerType,
        resourceId,
        userId,
        requestId,
      },
      `Starting ${providerType} resource registration`,
    );

    // Create or lookup sync-plan
    let syncPlanId: string;
    try {
      syncPlanId = await this.createSyncPlan(providerType.toLowerCase(), resourceId, userId);
      this.logger.info(
        { event: 'sync_plan_created', syncPlanId, resourceId, providerType, requestId },
        'Sync-plan created successfully',
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        const plan = await this.getSyncPlan(resourceId);
        syncPlanId = plan.id;
        this.logger.info(
          { event: 'sync_plan_exists', syncPlanId, resourceId, providerType, requestId },
          'Sync-plan already exists',
        );
      } else {
        throw toDomeError(err, 'Failed to create or retrieve sync plan', {
          providerType,
          resourceId,
          userId,
          requestId,
        });
      }
    }

    // Attach user if provided (idempotent)
    if (userId) {
      await this.attachUser(syncPlanId, userId);
      this.logger.info(
        { event: 'user_attached', syncPlanId, userId, providerType, requestId },
        'User attached to sync-plan successfully',
      );
    }

    // Initialize resource via Durable Object (creates initial sync)
    const wasInitialised = await this.initializeResource(
      { resourceId, providerType, userId },
      cadenceSecs,
    );

    this.logger.info(
      {
        event: 'resource_initialized',
        syncPlanId,
        resourceId,
        providerType,
        wasInitialised,
        requestId,
      },
      `${providerType} resource initialised & synced successfully`,
    );

      this.metrics?.trackOperation(`${providerType.toLowerCase()}_resource_registration`, true, {
      created: String(wasInitialised),
    });

    return { id: syncPlanId, resourceId, wasInitialised };
  }

  /**
   * Register and initialize a GitHub repository for syncing.
   * Delegates to the generic _registerResource helper.
   */
  async registerGithubRepo(
    owner: string,
    repo: string,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    const resourceId = `${owner}/${repo}`;
    return this._registerResource(ProviderType.GITHUB, resourceId, userId, cadenceSecs);
  }

  /**
   * Register and initialize a Notion workspace for syncing.
   * Delegates to the generic _registerResource helper.
   */
  async registerNotionWorkspace(
    workspaceId: string,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    return this._registerResource(ProviderType.NOTION, workspaceId, userId, cadenceSecs);
  }

  /**
   * Fetch handler for HTTP requests - DEPRECATED
   * Note: Direct HTTP requests are now handled by dome-api
   *
   * @param request Incoming HTTP request
   * @returns Response redirecting to the dome-api
   */
  async fetch(request: Request): Promise<Response> {
    return new Response('Direct HTTP access to Tsunami is deprecated. Please use the dome-api.', {
      status: 301,
      headers: {
        'Content-Type': 'text/plain',
        Location: 'https://api.dome.dev',
      },
    });
  }

  /**
   * Stores Notion OAuth details (access token, workspace info, etc.)
   * This is called by TsunamiClient from dome-api.
   */
  async storeNotionOAuthDetails(
    details: NotionOAuthDetails,
  ): Promise<{ success: boolean; workspaceId: string }> {
    const requestId = crypto.randomUUID();
    this.logger.info(
      {
        event: 'store_notion_oauth_details_entrypoint',
        userId: details.userId,
        workspaceId: details.workspaceId,
        botId: details.botId,
        requestId,
      },
      'Tsunami service: Storing Notion OAuth details',
    );

    return this.wrap(
      {
        operation: 'store_notion_oauth_details',
        userId: details.userId,
        workspaceId: details.workspaceId,
        requestId,
      },
      async () => {
        const result = await this.services.token.storeNotionToken(details);
        this.metrics?.trackOperation('store_notion_oauth_details', true, {
          workspaceId: details.workspaceId,
        });
        return result;
      },
    );
  }

  /**
   * Stores GitHub OAuth details (access token, user info, etc.)
   * This is called by TsunamiClient from dome-api.
   */
  async storeGithubOAuthDetails(
    details: GithubOAuthDetails,
  ): Promise<{ success: boolean; githubUserId: string }> {
    const requestId = crypto.randomUUID();
    this.logger.info(
      {
        event: 'store_github_oauth_details_entrypoint',
        userId: details.userId,
        providerAccountId: details.providerAccountId,
        requestId,
      },
      'Tsunami service: Storing GitHub OAuth details',
    );

    return this.wrap(
      {
        operation: 'store_github_oauth_details',
        userId: details.userId,
        providerAccountId: details.providerAccountId,
        requestId,
      },
      async () => {
        // TODO: Adapt TokenService.storeToken or add a specific storeGithubToken method if structure differs significantly
        // For now, assuming storeNotionToken's structure is adaptable or a generic storeToken exists.
        // This will likely require a new method in TokenService: storeGithubToken(details: GithubOAuthDetails)
        // For this step, we'll call a conceptual 'storeToken' on TokenService.
        // The actual implementation in TokenService would handle provider-specific logic or use generic fields.
        const result = await this.services.token.storeGithubToken(details); // Corrected to use storeGithubToken

        this.metrics?.trackOperation('store_github_oauth_details', true, {
          githubUserId: details.providerAccountId,
        });
        // The return type from a generic storeToken might need adjustment or casting.
        // For now, assuming it can return what's needed or we adapt.
        return { success: result.success, githubUserId: details.providerAccountId };
      },
    );
  }
}
