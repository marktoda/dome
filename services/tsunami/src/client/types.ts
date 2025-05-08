/**
 * Type definitions for the Tsunami client
 */

/**
 * Interface for Tsunami service binding
 * Defines the methods available on the Tsunami service
 */
export interface TsunamiBinding {
  /**
   * Creates a new sync plan
   */
  createSyncPlan(providerType: string, resourceId: string, userId?: string): Promise<string>;

  /**
   * Gets an existing sync plan by resource ID
   */
  getSyncPlan(resourceId: string): Promise<any>;

  /**
   * Attaches a user to a sync plan
   */
  attachUser(syncPlanId: string, userId: string): Promise<void>;

  /**
   * Initializes a resource for syncing
   */
  initializeResource(
    params: { resourceId: string; providerType: string; userId?: string },
    cadenceSecs: number,
  ): Promise<boolean>;

  /**
   * Gets sync history by resource ID
   */
  getHistoryByResourceId(resourceId: string, limit: number): Promise<unknown[]>;

  /**
   * Gets sync history by user ID
   */
  getHistoryByUserId(userId: string, limit: number): Promise<unknown[]>;

  /**
   * Gets sync history by sync plan ID
   */
  getHistoryBySyncPlanId(syncPlanId: string, limit: number): Promise<unknown[]>;

  /**
   * Register a GitHub repository and initialize syncing
   */
  registerGithubRepo(
    owner: string,
    repo: string,
    userId?: string,
    cadenceSecs?: number,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>;

  /**
   * Register a Notion workspace and initialize syncing
   */
  registerNotionWorkspace(
    workspaceId: string,
    userId?: string,
    cadenceSecs?: number,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>;

  /**
   * Register a website URL and initialize syncing
   */
  registerWebsite(
    websiteConfig: WebsiteRegistrationConfig,
    userId?: string,
    cadenceSecs?: number,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>;

  /**
   * Stores Notion OAuth details (access token, workspace info, etc.)
   */
  storeNotionOAuthDetails(details: NotionOAuthDetails): Promise<{ success: boolean; workspaceId: string }>;

  /**
   * Stores GitHub OAuth details (access token, user info, etc.)
   */
  storeGithubOAuthDetails(details: GithubOAuthDetails): Promise<{ success: boolean; githubUserId: string }>;
}

/**
 * Details for storing Notion OAuth information.
 */
export interface NotionOAuthDetails {
  userId: string; // The user ID from your application's auth system
  accessToken: string; // The access token obtained from Notion
  workspaceId: string;
  workspaceName?: string | null;
  workspaceIcon?: string | null; // URL
  botId: string;
  owner?: any; // Raw owner object from Notion, can be complex
  duplicatedTemplateId?: string | null;
}

/**
 * Details for storing GitHub OAuth information.
 */
export interface GithubOAuthDetails {
  userId: string; // The user ID from your application's auth system
  accessToken: string; // The access token obtained from GitHub
  providerAccountId: string; // GitHub user ID (as string, though it's a number from API)
  scope?: string | null;
  tokenType?: string | null;
  // refreshToken?: string | null; // If GitHub provides one and we store it
  // expiresAt?: number | null;    // If applicable
  metadata?: { // Store additional useful info like username
    username: string;
    // email?: string | null; // If fetched and needed
  } | null;
}

/**
 * Configuration for website registration
 */
export interface WebsiteRegistrationConfig {
  url: string;
  crawlDepth?: number;
  respectRobotsTxt?: boolean;
  delayMs?: number;
  includeImages?: boolean;
  includeScripts?: boolean;
  includeStyles?: boolean;
  followExternalLinks?: boolean;
  urlPatterns?: string[];
}

/**
 * Interface for the Tsunami client service
 * Mirrors the methods available via the binding
 */
export interface TsunamiService extends TsunamiBinding {}
