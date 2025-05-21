/**
 * Tsunami Client Implementation
 *
 * A client for interacting with the Tsunami service using WorkerEntrypoint RPC
 */
import { getLogger, logError, metrics } from '@dome/common';
import { toDomeError } from '@dome/common/errors';
import {
  TsunamiBinding,
  TsunamiService,
  WebsiteRegistrationConfig,
  NotionOAuthDetails,
  GithubOAuthDetails,
} from './types'; // Added GithubOAuthDetails
export {
  TsunamiBinding,
  TsunamiService,
  WebsiteRegistrationConfig,
  NotionOAuthDetails,
  GithubOAuthDetails,
} from './types'; // Added GithubOAuthDetails

/**
 * Client for interacting with the Tsunami service
 * Provides methods for repository syncing and history management
 */
export class TsunamiClient implements TsunamiService {
  private logger = getLogger();

  /**
   * Create a new TsunamiClient
   * @param binding The Cloudflare Worker binding to the Tsunami service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'tsunami.client')
   */
  constructor(
    private readonly binding: TsunamiBinding,
    private readonly metricsPrefix: string = 'tsunami.client',
  ) {}

  /**
   * Creates a new sync plan
   *
   * @param providerType - The provider type (e.g., 'github')
   * @param resourceId - The resource identifier (e.g., 'owner/repo')
   * @param userId - Optional user ID to associate with the plan
   * @returns The sync plan ID
   */
  async createSyncPlan(providerType: string, resourceId: string, userId?: string): Promise<string> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'create_sync_plan',
          providerType,
          resourceId,
          userId,
        },
        'Creating sync plan',
      );

      const result = await this.binding.createSyncPlan(providerType, resourceId, userId);

      metrics.increment(`${this.metricsPrefix}.create_sync_plan.success`);
      metrics.timing(
        `${this.metricsPrefix}.create_sync_plan.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.create_sync_plan.error`);
      this.logger.error(error, 'Error creating sync plan');
      throw toDomeError(error);
    }
  }

  /**
   * Gets an existing sync plan by resource ID
   *
   * @param resourceId - The resource identifier
   * @returns The sync plan details
   */

  /**
   * Gets an existing sync plan by resource ID
   *
   * @param resourceId - The resource identifier
   * @returns The sync plan details
   */
  async getSyncPlan(resourceId: string): Promise<any> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_sync_plan',
          resourceId,
        },
        'Getting sync plan',
      );

      const result = await this.binding.getSyncPlan(resourceId);

      metrics.increment(`${this.metricsPrefix}.get_sync_plan.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_sync_plan.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_sync_plan.errors`);
      logError(error, 'Error getting sync plan');
      throw toDomeError(error);
    }
  }

  /**
   * Attaches a user to a sync plan
   *
   * @param syncPlanId - The sync plan ID
   * @param userId - The user ID to attach
   */
  async attachUser(syncPlanId: string, userId: string): Promise<void> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'attach_user',
          syncPlanId,
          userId,
        },
        'Attaching user to sync plan',
      );

      await this.binding.attachUser(syncPlanId, userId);

      metrics.increment(`${this.metricsPrefix}.attach_user.success`);
      metrics.timing(`${this.metricsPrefix}.attach_user.latency_ms`, performance.now() - startTime);
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.attach_user.errors`);
      logError(error, 'Error attaching user to sync plan');
      throw toDomeError(error);
    }
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
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'initialize_resource',
          resourceId: params.resourceId,
          providerType: params.providerType,
          userId: params.userId,
          cadenceSecs,
        },
        'Initializing resource',
      );

      const result = await this.binding.initializeResource(params, cadenceSecs);

      metrics.increment(`${this.metricsPrefix}.initialize_resource.success`);
      metrics.timing(
        `${this.metricsPrefix}.initialize_resource.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.initialize_resource.errors`);
      logError(error, 'Error initializing resource');
      throw toDomeError(error);
    }
  }

  /**
   * Register a GitHub repository and initialize syncing
   *
   * @param owner GitHub repository owner
   * @param repo GitHub repository name
   * @param userId Optional user ID to associate with the sync plan
   * @param cadenceSecs Optional sync frequency in seconds (defaults to 3600 - 1 hour)
   * @returns Object containing the ID, resourceId, and initialization status
   */
  async registerGithubRepo(
    owner: string,
    repo: string,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'github_repo_registration_start',
          owner,
          repo,
          userId,
          cadenceSecs,
        },
        'Starting GitHub repository registration',
      );

      const result = await this.binding.registerGithubRepo(owner, repo, userId, cadenceSecs);

      metrics.increment(`${this.metricsPrefix}.github_repo_registration.success`);
      metrics.timing(
        `${this.metricsPrefix}.github_repo_registration.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.github_repo_registration.errors`);
      logError(error, 'Error registering GitHub repository');
      throw toDomeError(error);
    }
  }

  /**
   * Register a Notion workspace and initialize syncing
   *
   * @param workspaceId Notion workspace ID
   * @param userId Optional user ID to associate with the sync plan
   * @param cadenceSecs Optional sync frequency in seconds (defaults to 3600 - 1 hour)
   * @returns Object containing the ID, resourceId, and initialization status
   */
  async registerNotionWorkspace(
    workspaceId: string,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'notion_workspace_registration_start',
          workspaceId,
          userId,
          cadenceSecs,
        },
        'Starting Notion workspace registration',
      );

      const result = await this.binding.registerNotionWorkspace(workspaceId, userId, cadenceSecs);

      metrics.increment(`${this.metricsPrefix}.notion_workspace_registration.success`);
      metrics.timing(
        `${this.metricsPrefix}.notion_workspace_registration.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.notion_workspace_registration.errors`);
      logError(error, 'Error registering Notion workspace');
      throw toDomeError(error);
    }
  }

  /**
   * Register a website and initialize syncing
   *
   * @param websiteConfig Website configuration object with URL and crawl options
   * @param userId Optional user ID to associate with the sync plan
   * @param cadenceSecs Optional sync frequency in seconds (defaults to 3600 - 1 hour)
   * @returns Object containing the ID, resourceId, and initialization status
   */
  async registerWebsite(
    websiteConfig: WebsiteRegistrationConfig,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'website_registration_start',
          websiteUrl: websiteConfig.url,
          userId,
          cadenceSecs,
        },
        'Starting website registration',
      );

      const result = await this.binding.registerWebsite(websiteConfig, userId, cadenceSecs);

      metrics.increment(`${this.metricsPrefix}.website_registration.success`);
      metrics.timing(
        `${this.metricsPrefix}.website_registration.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.website_registration.errors`);
      logError(error, 'Error registering website');
      throw toDomeError(error);
    }
  }

  /**
   * Get history for a website
   *
   * @param websiteUrl Website URL
   * @param limit Maximum number of history records to return
   * @returns Website history with metadata
   */
  async getWebsiteHistory(
    websiteUrl: string,
    limit: number = 10,
  ): Promise<{
    websiteUrl: string;
    resourceId: string;
    history: unknown[];
  }> {
    const startTime = performance.now();

    try {
      // For websites, the resourceId is a JSON string with the configuration
      // We need to find the resourceId by looking up the website URL
      // For simplicity, we'll construct a basic config matching search string
      const baseConfig = { url: websiteUrl };
      const resourceId = JSON.stringify(baseConfig);

      this.logger.info(
        {
          event: 'get_website_history',
          websiteUrl,
          resourceId,
          limit,
        },
        'Fetching website history',
      );

      const history = await this.binding.getHistoryByResourceId(resourceId, limit);

      metrics.increment(`${this.metricsPrefix}.get_website_history.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_website_history.latency_ms`,
        performance.now() - startTime,
      );

      return {
        websiteUrl,
        resourceId,
        history,
      };
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_website_history.errors`);
      logError(error, 'Error fetching website history');
      throw toDomeError(error);
    }
  }

  /**
   * Get history for a Notion workspace
   *
   * @param workspaceId Notion workspace ID
   * @param limit Maximum number of history records to return
   * @returns Workspace history with metadata
   */
  async getNotionWorkspaceHistory(
    workspaceId: string,
    limit: number = 10,
  ): Promise<{
    workspaceId: string;
    resourceId: string;
    history: unknown[];
  }> {
    const startTime = performance.now();
    const resourceId = workspaceId;

    try {
      this.logger.info(
        {
          event: 'get_notion_workspace_history',
          workspaceId,
          resourceId,
          limit,
        },
        'Fetching Notion workspace history',
      );

      const history = await this.binding.getHistoryByResourceId(resourceId, limit);

      metrics.increment(`${this.metricsPrefix}.get_notion_workspace_history.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_notion_workspace_history.latency_ms`,
        performance.now() - startTime,
      );

      return {
        workspaceId,
        resourceId,
        history,
      };
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_notion_workspace_history.errors`);
      logError(error, 'Error fetching Notion workspace history');
      throw toDomeError(error);
    }
  }

  /**
   * Get sync history for a GitHub repository
   *
   * @param owner GitHub repository owner
   * @param repo GitHub repository name
   * @param limit Maximum number of history records to return
   * @returns Repository history with metadata
   */
  async getGithubRepoHistory(
    owner: string,
    repo: string,
    limit: number = 10,
  ): Promise<{
    owner: string;
    repo: string;
    resourceId: string;
    history: unknown[];
  }> {
    const startTime = performance.now();
    const resourceId = `${owner}/${repo}`;

    try {
      this.logger.info(
        {
          event: 'get_github_repo_history',
          owner,
          repo,
          resourceId,
          limit,
        },
        'Fetching GitHub repository history',
      );

      const history = await this.binding.getHistoryByResourceId(resourceId, limit);

      metrics.increment(`${this.metricsPrefix}.get_github_repo_history.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_github_repo_history.latency_ms`,
        performance.now() - startTime,
      );

      return {
        owner,
        repo,
        resourceId,
        history,
      };
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_github_repo_history.errors`);
      logError(error, 'Error fetching GitHub repository history');
      throw toDomeError(error);
    }
  }

  /**
   * Get sync history for a user
   *
   * @param userId User ID to get history for
   * @param limit Maximum number of history records to return
   * @returns User's sync history
   */
  async getUserHistory(
    userId: string,
    limit: number = 10,
  ): Promise<{
    userId: string;
    history: unknown[];
  }> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_user_history',
          userId,
          limit,
        },
        'Fetching user sync history',
      );

      const history = await this.binding.getHistoryByUserId(userId, limit);

      metrics.increment(`${this.metricsPrefix}.get_user_history.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_user_history.latency_ms`,
        performance.now() - startTime,
      );

      return {
        userId,
        history,
      };
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_user_history.errors`);
      logError(error, 'Error fetching user sync history');
      throw toDomeError(error);
    }
  }

  /**
   * Get sync history for a specific sync plan
   *
   * @param syncPlanId Sync plan ID to get history for
   * @param limit Maximum number of history records to return
   * @returns Sync plan history
   */
  async getSyncPlanHistory(
    syncPlanId: string,
    limit: number = 10,
  ): Promise<{
    syncPlanId: string;
    history: unknown[];
  }> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_sync_plan_history',
          syncPlanId,
          limit,
        },
        'Fetching sync plan history',
      );

      const history = await this.binding.getHistoryBySyncPlanId(syncPlanId, limit);

      metrics.increment(`${this.metricsPrefix}.get_sync_plan_history.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_sync_plan_history.latency_ms`,
        performance.now() - startTime,
      );

      return {
        syncPlanId,
        history,
      };
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_sync_plan_history.errors`);
      logError(error, 'Error fetching sync plan history');
      throw toDomeError(error);
    }
  }

  /**
   * Gets sync history by resource ID
   *
   * @param resourceId - The resource identifier
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryByResourceId(resourceId: string, limit: number): Promise<unknown[]> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_history_by_resource_id',
          resourceId,
          limit,
        },
        'Getting history by resource ID',
      );

      const result = await this.binding.getHistoryByResourceId(resourceId, limit);

      metrics.increment(`${this.metricsPrefix}.get_history_by_resource_id.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_history_by_resource_id.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_history_by_resource_id.errors`);
      logError(error, 'Error getting history by resource ID');
      throw toDomeError(error);
    }
  }

  /**
   * Gets sync history by user ID
   *
   * @param userId - The user ID
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryByUserId(userId: string, limit: number): Promise<unknown[]> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_history_by_user_id',
          userId,
          limit,
        },
        'Getting history by user ID',
      );

      const result = await this.binding.getHistoryByUserId(userId, limit);

      metrics.increment(`${this.metricsPrefix}.get_history_by_user_id.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_history_by_user_id.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_history_by_user_id.errors`);
      logError(error, 'Error getting history by user ID');
      throw toDomeError(error);
    }
  }

  /**
   * Gets sync history by sync plan ID
   *
   * @param syncPlanId - The sync plan ID
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryBySyncPlanId(syncPlanId: string, limit: number): Promise<unknown[]> {
    const startTime = performance.now();

    try {
      this.logger.info(
        {
          event: 'get_history_by_sync_plan_id',
          syncPlanId,
          limit,
        },
        'Getting history by sync plan ID',
      );

      const result = await this.binding.getHistoryBySyncPlanId(syncPlanId, limit);

      metrics.increment(`${this.metricsPrefix}.get_history_by_sync_plan_id.success`);
      metrics.timing(
        `${this.metricsPrefix}.get_history_by_sync_plan_id.latency_ms`,
        performance.now() - startTime,
      );

      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.get_history_by_sync_plan_id.errors`);
      logError(error, 'Error getting history by sync plan ID');
      throw toDomeError(error);
    }
  }

  /**
   * Stores Notion OAuth details (access token, workspace info, etc.)
   *
   * @param details - The Notion OAuth details to store
   * @returns Object indicating success and the workspaceId
   */
  async storeNotionOAuthDetails(
    details: NotionOAuthDetails,
  ): Promise<{ success: boolean; workspaceId: string }> {
    const startTime = performance.now();
    try {
      this.logger.info(
        {
          event: 'store_notion_oauth_details',
          userId: details.userId,
          workspaceId: details.workspaceId,
          botId: details.botId,
        },
        'Storing Notion OAuth details',
      );

      // The actual call to the Tsunami Durable Object via the binding
      // This assumes `storeNotionOAuthDetails` will be added to the TsunamiBinding interface
      // and implemented by the Tsunami Durable Object.
      const result = await this.binding.storeNotionOAuthDetails(details);

      metrics.increment(`${this.metricsPrefix}.store_notion_oauth_details.success`);
      metrics.timing(
        `${this.metricsPrefix}.store_notion_oauth_details.latency_ms`,
        performance.now() - startTime,
      );
      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.store_notion_oauth_details.error`);
      this.logger.error(error, 'Error storing Notion OAuth details');
      throw toDomeError(error);
    }
  }

  /**
   * Stores GitHub OAuth details (access token, user info, etc.)
   *
   * @param details - The GitHub OAuth details to store
   * @returns Object indicating success and the GitHub user ID (as string)
   */
  async storeGithubOAuthDetails(
    details: GithubOAuthDetails,
  ): Promise<{ success: boolean; githubUserId: string }> {
    const startTime = performance.now();
    try {
      this.logger.info(
        {
          event: 'store_github_oauth_details',
          userId: details.userId, // App user ID
          providerAccountId: details.providerAccountId, // GitHub user ID
        },
        'Storing GitHub OAuth details',
      );

      // This will call the corresponding method on the Tsunami Worker Entrypoint
      const result = await this.binding.storeGithubOAuthDetails(details);

      metrics.increment(`${this.metricsPrefix}.store_github_oauth_details.success`);
      metrics.timing(
        `${this.metricsPrefix}.store_github_oauth_details.latency_ms`,
        performance.now() - startTime,
      );
      return result;
    } catch (error) {
      metrics.increment(`${this.metricsPrefix}.store_github_oauth_details.error`);
      this.logger.error(error, 'Error storing GitHub OAuth details');
      throw toDomeError(error);
    }
  }
}

/**
 * Create a new TsunamiClient
 * @param binding The Cloudflare Worker binding to the Tsunami service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'tsunami.client')
 * @returns A new TsunamiClient instance
 */
export function createTsunamiClient(
  binding: TsunamiBinding,
  metricsPrefix?: string,
): TsunamiClient {
  return new TsunamiClient(binding, metricsPrefix);
}
