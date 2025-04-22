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

const CADENCE_SEC = 'cadenceSec';
const DEFAULT_CADENCE_SEC = 3600;
const RESOURCE_CONFIG_KEY = 'resourceConfig';

/**
 * Configuration for a ResourceObject
 *
 * @interface ResourceObjectConfig
 */
type ResourceObjectConfig = {
  /** User ID who owns this resource */
  userId?: string;
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
  userId: undefined,
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
export class ResourceObject extends DurableObject<Env> {
  private silo: SiloService;
  private config: ResourceObjectConfig = DEFAULT_RESOURCE_CONFIG;

  constructor(ctx: DurableObjectState, env: Env) {
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
    // Merge provided config with defaults
    this.config = {
      ...DEFAULT_RESOURCE_CONFIG,
      ...config,
    };

    // Ensure resourceId is set
    if (!this.config.resourceId) {
      throw new Error('resourceId is required for initialization');
    }

    // Store the config
    await this.ctx.storage.put(RESOURCE_CONFIG_KEY, this.config);

    // Set up the first alarm
    await this.ctx.storage.setAlarm(Date.now() + this.config.cadenceSecs * 1000);

    getLogger().info({ config: this.config }, 'ResourceObject initialized');
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
    logger.info(
      { resourceId: this.config.resourceId, cursor: this.config.cursor },
      'Starting sync',
    );
    const { userId, providerType, resourceId, cursor } = this.config;

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

    try {
      // Pull content from the provider
      const { contents, newCursor } = await provider.pull({
        userId,
        resourceId,
        cursor,
      });

      logger.info({ resourceId, contentCount: contents.length }, 'Fetched content from provider');

      if (newCursor) {
        // Update the cursor in the config
        await this.updateConfig({ cursor: newCursor });

        logger.info({ resourceId, oldCursor: cursor, newCursor }, 'Updated cursor');
      }

      if (contents.length > 0) {
        // Upload content to Silo
        const contentIds = await this.silo.upload(contents);
        logger.info({ resourceId, contentIds }, 'Content uploaded to Silo');
      } else {
        logger.info({ resourceId }, 'No new content to sync');
      }

      metrics.increment('tsunami.sync.success', 1);
    } catch (error) {
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
