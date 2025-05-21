/**
 * Tsunami Client Implementation
 *
 * A client for interacting with the Tsunami service using WorkerEntrypoint RPC
 */
import { metrics, createServiceWrapper } from '@dome/common';
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
  private wrap = createServiceWrapper('tsunami.client');

  private async run<T>(
    operation: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.wrap({ operation, ...meta }, async () => {
      const startTime = performance.now();
      try {
        const result = await fn();
        metrics.increment(`${this.metricsPrefix}.${operation}.success`);
        metrics.timing(
          `${this.metricsPrefix}.${operation}.latency_ms`,
          performance.now() - startTime,
        );
        return result;
      } catch (error) {
        metrics.increment(`${this.metricsPrefix}.${operation}.errors`);
        throw error;
      }
    });
  }

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
    return this.run('create_sync_plan', { providerType, resourceId, userId }, () =>
      this.binding.createSyncPlan(providerType, resourceId, userId),
    );
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
    return this.run('get_sync_plan', { resourceId }, () =>
      this.binding.getSyncPlan(resourceId),
    );
  }

  /**
   * Attaches a user to a sync plan
   *
   * @param syncPlanId - The sync plan ID
   * @param userId - The user ID to attach
   */
  async attachUser(syncPlanId: string, userId: string): Promise<void> {
    await this.run('attach_user', { syncPlanId, userId }, () =>
      this.binding.attachUser(syncPlanId, userId),
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
    return this.run(
      'initialize_resource',
      { ...params, cadenceSecs },
      () => this.binding.initializeResource(params, cadenceSecs),
    );
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
    return this.run(
      'github_repo_registration',
      { owner, repo, userId, cadenceSecs },
      () => this.binding.registerGithubRepo(owner, repo, userId, cadenceSecs),
    );
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
    return this.run(
      'notion_workspace_registration',
      { workspaceId, userId, cadenceSecs },
      () => this.binding.registerNotionWorkspace(workspaceId, userId, cadenceSecs),
    );
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
    return this.run(
      'website_registration',
      { websiteUrl: websiteConfig.url, userId, cadenceSecs },
      () => this.binding.registerWebsite(websiteConfig, userId, cadenceSecs),
    );
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
    const baseConfig = { url: websiteUrl };
    const resourceId = JSON.stringify(baseConfig);

    return this.run(
      'get_website_history',
      { websiteUrl, resourceId, limit },
      async () => {
        const history = await this.binding.getHistoryByResourceId(resourceId, limit);
        return { websiteUrl, resourceId, history };
      },
    );
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
    const resourceId = workspaceId;

    return this.run(
      'get_notion_workspace_history',
      { workspaceId, resourceId, limit },
      async () => {
        const history = await this.binding.getHistoryByResourceId(resourceId, limit);
        return { workspaceId, resourceId, history };
      },
    );
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
    const resourceId = `${owner}/${repo}`;

    return this.run(
      'get_github_repo_history',
      { owner, repo, resourceId, limit },
      async () => {
        const history = await this.binding.getHistoryByResourceId(resourceId, limit);
        return { owner, repo, resourceId, history };
      },
    );
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
    return this.run(
      'get_user_history',
      { userId, limit },
      async () => {
        const history = await this.binding.getHistoryByUserId(userId, limit);
        return { userId, history };
      },
    );
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
    return this.run(
      'get_sync_plan_history',
      { syncPlanId, limit },
      async () => {
        const history = await this.binding.getHistoryBySyncPlanId(syncPlanId, limit);
        return { syncPlanId, history };
      },
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
    return this.run(
      'get_history_by_resource_id',
      { resourceId, limit },
      () => this.binding.getHistoryByResourceId(resourceId, limit),
    );
  }

  /**
   * Gets sync history by user ID
   *
   * @param userId - The user ID
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryByUserId(userId: string, limit: number): Promise<unknown[]> {
    return this.run(
      'get_history_by_user_id',
      { userId, limit },
      () => this.binding.getHistoryByUserId(userId, limit),
    );
  }

  /**
   * Gets sync history by sync plan ID
   *
   * @param syncPlanId - The sync plan ID
   * @param limit - Maximum number of history records to return
   * @returns Array of history records
   */
  async getHistoryBySyncPlanId(syncPlanId: string, limit: number): Promise<unknown[]> {
    return this.run(
      'get_history_by_sync_plan_id',
      { syncPlanId, limit },
      () => this.binding.getHistoryBySyncPlanId(syncPlanId, limit),
    );
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
    return this.run(
      'store_notion_oauth_details',
      { userId: details.userId, workspaceId: details.workspaceId, botId: details.botId },
      () => this.binding.storeNotionOAuthDetails(details),
    );
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
    return this.run(
      'store_github_oauth_details',
      { userId: details.userId, providerAccountId: details.providerAccountId },
      () => this.binding.storeGithubOAuthDetails(details),
    );
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
