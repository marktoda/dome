/**
 * ResourceObject Module
 *
 * This module defines the ResourceObject Durable Object, which manages the state
 * and synchronization of external content sources.
 *
 * @module resourceObject
 */

import { DurableObject } from 'cloudflare:workers';
import { SiloService, createSiloService } from './services/siloService';
import { getLogger, logError, metrics } from '@dome/logging';
import { ProviderType, GithubProvider, Provider } from './providers';
import { Bindings } from './types';
import { syncHistoryOperations, syncPlanOperations } from './db/client';
import { ulid } from 'ulid';

const CADENCE_SEC = 'cadenceSec';
const DEFAULT_CADENCE_SEC = 3600;
const RESOURCE_CONFIG_KEY = 'resourceConfig';

/**
 * Configuration for a ResourceObject
 *
 * @interface ResourceObjectConfig
 */
type ResourceObjectConfig = {
  /** User IDs who have access to this resource */
  userIds: string[];
  /** Sync frequency in seconds */
  cadenceSecs: number;
  /** Type of content provider */
  providerType: ProviderType;
  /** Provider-specific cursor for incremental syncs */
  cursor: string;
  /** Resource identifier (e.g., owner/repo for GitHub) */
  resourceId: string;
};

/**
 * Default configuration for a new ResourceObject
 */
const DEFAULT_RESOURCE_CONFIG: ResourceObjectConfig = {
  userIds: [],
  cadenceSecs: DEFAULT_CADENCE_SEC,
  providerType: ProviderType.GITHUB,
  cursor: '',
  resourceId: '',
};

/**
 * ResourceObject Durable Object
 *
 * Manages the state and synchronization of external content sources.
 * Each ResourceObject instance corresponds to a single external resource
 * (e.g., a GitHub repository) and maintains its sync state.
 *
 * @class
 */
export class ResourceObject extends DurableObject<Bindings> {
  private silo: SiloService;
  private config: ResourceObjectConfig = DEFAULT_RESOURCE_CONFIG;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.silo = createSiloService(this.env);
    // `blockConcurrencyWhile()` ensures no requests are delivered until
    // initialization completes.
    ctx.blockConcurrencyWhile(async () => {
      // Try to load existing config or initialize a new one
      try {
        this.config = await this.getConfig();
        getLogger().info(
          { resourceId: this.config.resourceId },
          'Loaded existing ResourceObject config',
        );
      } catch (error) {
        // Config doesn't exist yet, we'll initialize it when needed
        getLogger().info('No existing ResourceObject config found');
      }
    });
  }

  /**
   * Initialize the ResourceObject with configuration
   *
   * This method should be called when creating a new ResourceObject.
   * It sets up the initial configuration and stores it in durable storage.
   *
   * @param config - Partial configuration to merge with defaults
   * @throws Error if resourceId is not provided
   */
  async initialize(config: Partial<ResourceObjectConfig>): Promise<void> {
    const logger = getLogger();

    // Merge provided config with defaults
    this.config = {
      ...DEFAULT_RESOURCE_CONFIG,
      ...config,
    };

    // Ensure resourceId is set
    if (!this.config.resourceId) {
      throw new Error('resourceId is required for initialization');
    }

    // Validate resourceId format based on provider type
    if (this.config.providerType === ProviderType.GITHUB) {
      // For GitHub, resourceId should be in the format "owner/repo"
      const [owner, repo] = this.config.resourceId.split('/');
      if (!owner || !repo) {
        const error = new Error(
          `Invalid resourceId format for GitHub: ${this.config.resourceId}. Expected format: owner/repo`,
        );
        logger.error(
          { error, resourceId: this.config.resourceId },
          'ResourceObject initialization failed',
        );
        throw error;
      }
    }

    // Store the config
    await this.ctx.storage.put(RESOURCE_CONFIG_KEY, this.config);

    // Set up the first alarm
    await this.ctx.storage.setAlarm(Date.now() + this.config.cadenceSecs * 1000);

    logger.info(
      {
        resourceId: this.config.resourceId,
        providerType: this.config.providerType,
        cadenceSecs: this.config.cadenceSecs,
      },
      'ResourceObject initialized',
    );
  }

  /**
   * Add a user to the ResourceObject
   *
   * This method adds a user ID to the list of users who have access to this resource.
   * If the user already exists, it does nothing.
   *
   * @param userId - The user ID to add
   * @returns Promise that resolves when the user is added
   */
  async addUser(userId: string): Promise<void> {
    if (!userId) {
      return; // No userId provided
    }

    // Get current config
    const config = await this.getConfig();

    // Check if userIds exists, if not create it
    const userIds = config.userIds || [];

    // Check if user already exists
    if (userIds.includes(userId)) {
      return; // User already exists
    }

    // Add the user to the config
    await this.updateConfig({
      userIds: [...userIds, userId],
    });

    getLogger().info(
      { resourceId: this.config.resourceId, userId },
      'User added to ResourceObject',
    );
  }

  /**
   * Synchronize content from the external source
   *
   * This method fetches new content from the external source since the last sync,
   * uploads it to Silo, and updates the cursor for the next sync.
   *
   * @returns Promise that resolves when the sync is complete
   * @throws Error if the sync fails
   */
  async sync(): Promise<void> {
    const logger = getLogger();
    const startTime = Date.now();
    const startTimeSec = Math.floor(startTime / 1000);

    logger.info(
      { resourceId: this.config.resourceId, cursor: this.config.cursor },
      'Starting sync',
    );
    const { userIds, providerType, resourceId, cursor } = this.config;

    // Validate resourceId before proceeding
    if (!resourceId) {
      const error = new Error('Empty resourceId. ResourceObject not properly initialized.');
      logger.error({ error }, 'Error during sync');
      throw error;
    }

    // For GitHub provider, validate the resourceId format (owner/repo)
    if (providerType === ProviderType.GITHUB && !resourceId.includes('/')) {
      const error = new Error(
        `Invalid resourceId format: ${resourceId}. Expected format: owner/repo`,
      );
      logger.error({ error, resourceId }, 'Error during sync');
      throw error;
    }

    // Use the first user ID for authentication if available
    const syncUserId = userIds[0];

    let provider: Provider;
    switch (providerType) {
      case ProviderType.GITHUB: {
        provider = new GithubProvider(this.env);
        break;
      }
      case ProviderType.NOTION: {
        throw new Error('Not implemented');
      }
      default:
        throw new Error(`Unknown providerType: ${providerType}`);
    }

    // Find the sync plan ID for this resource
    let syncPlanId: string;
    try {
      const syncPlan = await syncPlanOperations.findByResourceId(this.env.SYNC_PLAN, resourceId);
      if (!syncPlan) {
        // This shouldn't happen in normal operation, but we'll generate a temporary ID if needed
        syncPlanId = ulid();
        logger.warn({ resourceId }, 'Sync plan not found for resource, using temporary ID');
      } else {
        syncPlanId = syncPlan.id;
      }
    } catch (error) {
      // If we can't find the sync plan, generate a temporary ID
      syncPlanId = ulid();
      logger.warn(
        { resourceId, error: error instanceof Error ? error.message : String(error) },
        'Error finding sync plan for resource, using temporary ID',
      );
    }

    try {
      // Pull content from the provider
      const { contents, newCursor } = await provider.pull({
        userId: syncUserId,
        resourceId,
        cursor,
      });

      logger.info({ resourceId, contentCount: contents.length }, 'Fetched content from provider');

      // Extract file paths from contents for history tracking
      const updatedFiles = contents.map(content => {
        // Extract path from metadata if available
        return content.metadata?.path || 'unknown';
      });

      if (newCursor) {
        // Update the cursor in the config
        await this.updateConfig({ cursor: newCursor });

        logger.info({ resourceId, oldCursor: cursor, newCursor }, 'Updated cursor');
      }

      let contentIds: string[] = [];
      if (contents.length > 0) {
        // Upload content to Silo
        contentIds = await this.silo.upload(contents);
        logger.info({ resourceId, contentIds }, 'Content uploaded to Silo');
      } else {
        logger.info({ resourceId }, 'No new content to sync');
      }

      // Record sync history
      const endTime = Date.now();
      const endTimeSec = Math.floor(endTime / 1000);

      await syncHistoryOperations.create(this.env.SYNC_PLAN, {
        syncPlanId,
        resourceId,
        provider: providerType,
        userId: syncUserId,
        startedAt: startTimeSec,
        completedAt: endTimeSec,
        previousCursor: cursor,
        newCursor: newCursor || cursor,
        filesProcessed: contents.length,
        updatedFiles,
        status: 'success',
      });

      logger.info(
        {
          resourceId,
          syncDurationMs: endTime - startTime,
          filesProcessed: contents.length,
          updatedFiles,
        },
        'Sync history recorded',
      );

      metrics.increment('tsunami.sync.success', 1);
    } catch (error) {
      // Record sync history with error
      const endTime = Date.now();
      const endTimeSec = Math.floor(endTime / 1000);

      try {
        await syncHistoryOperations.create(this.env.SYNC_PLAN, {
          syncPlanId,
          resourceId,
          provider: providerType,
          userId: syncUserId,
          startedAt: startTimeSec,
          completedAt: endTimeSec,
          previousCursor: cursor,
          newCursor: cursor, // No change in cursor on error
          filesProcessed: 0,
          updatedFiles: [],
          status: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        logger.info(
          {
            resourceId,
            syncDurationMs: endTime - startTime,
            error: error instanceof Error ? error.message : String(error),
          },
          'Sync history recorded with error',
        );
      } catch (historyError) {
        // If we can't record the history, just log the error
        logger.error(
          {
            resourceId,
            error: historyError instanceof Error ? historyError.message : String(historyError),
          },
          'Failed to record sync history',
        );
      }

      logError(logger, error, 'Error during sync', { resourceId });
      metrics.increment('tsunami.sync.error', 1);

      // For other errors, rethrow to propagate to the caller
      throw error;
    }
  }

  /**
   * Handle alarm events
   *
   * This method is called when the Durable Object's alarm fires.
   * It triggers a sync operation and schedules the next alarm.
   *
   * @param alarmInfo - Information about the alarm event
   */
  async alarm(alarmInfo: AlarmInvocationInfo): Promise<void> {
    getLogger().info(alarmInfo, 'Durable object alarm info');
    this.sync();
    await this.ctx.storage.setAlarm(Date.now() + this.config.cadenceSecs * 1000);
  }

  /**
   * Get the current configuration from storage
   *
   * @returns The current ResourceObject configuration
   * @throws Error if the configuration is not found
   * @private
   */
  private async getConfig(): Promise<ResourceObjectConfig> {
    const res = await this.ctx.storage.get<ResourceObjectConfig>(RESOURCE_CONFIG_KEY);
    if (!res) {
      throw new Error('Resource config not found');
    }
    return res;
  }

  /**
   * Update the configuration and store it
   *
   * This method updates the configuration with new values and persists
   * the changes to durable storage.
   *
   * @param updates - Partial configuration updates to apply
   * @private
   */
  private async updateConfig(updates: Partial<ResourceObjectConfig>): Promise<void> {
    // Update the config with new values
    this.config = {
      ...this.config,
      ...updates,
    };

    // Store the updated config
    await this.ctx.storage.put(RESOURCE_CONFIG_KEY, this.config);

    getLogger().info({ config: this.config }, 'ResourceObject config updated');
  }
}
