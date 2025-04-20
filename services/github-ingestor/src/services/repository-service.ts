// Import only what we need for now
import { ulid } from 'ulid';
import { providerRepositories } from '../db/schema';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { Env } from '../types';

/**
 * Repository configuration
 */
export interface RepositoryConfig {
  id?: string;
  userId: string;
  provider: string;
  owner: string;
  repo: string;
  branch?: string;
  isPrivate: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

/**
 * Repository sync status
 */
export interface RepositorySyncStatus {
  lastSyncedAt?: number;
  lastCommitSha?: string;
  etag?: string;
  retryCount: number;
  nextRetryAt?: number;
  rateLimitReset?: number;
}

/**
 * Service for managing repository configurations
 */
export class RepositoryService {
  private env: Env;

  /**
   * Create a new repository service
   * @param env Environment
   */
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Create a new repository configuration
   * @param config Repository configuration
   * @returns Created repository ID
   */
  async createRepository(config: RepositoryConfig): Promise<string> {
    const timer = metrics.startTimer('repository_service.create_repository');
    
    try {
      const now = Math.floor(Date.now() / 1000);
      const id = config.id || ulid();
      
      // Insert repository configuration
      await this.env.DB.prepare(`
        INSERT INTO provider_repositories (
          id, userId, provider, owner, repo, branch, isPrivate, 
          includePatterns, excludePatterns, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        config.userId,
        config.provider,
        config.owner,
        config.repo,
        config.branch || 'main',
        config.isPrivate ? 1 : 0,
        config.includePatterns ? JSON.stringify(config.includePatterns) : null,
        config.excludePatterns ? JSON.stringify(config.excludePatterns) : null,
        now,
        now
      )
      .run();
      
      logger.info({
        id,
        userId: config.userId,
        provider: config.provider,
        owner: config.owner,
        repo: config.repo
      }, 'Created repository configuration');
      
      metrics.counter('repository_service.repositories_created', 1, {
        provider: config.provider,
        is_private: config.isPrivate.toString()
      });
      
      timer.stop({ provider: config.provider });
      return id;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to create repository configuration');
      throw error;
    }
  }

  /**
   * Get a repository configuration by ID
   * @param id Repository ID
   * @returns Repository configuration or null if not found
   */
  async getRepository(id: string): Promise<RepositoryConfig | null> {
    const timer = metrics.startTimer('repository_service.get_repository');
    
    try {
      const result = await this.env.DB.prepare(`
        SELECT id, userId, provider, owner, repo, branch, isPrivate, includePatterns, excludePatterns
        FROM provider_repositories
        WHERE id = ?
      `)
      .bind(id)
      .first();
      
      if (!result) {
        timer.stop({ found: 'false' });
        return null;
      }
      
      const repo = result as any;
      
      const config: RepositoryConfig = {
        id: repo.id,
        userId: repo.userId,
        provider: repo.provider,
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.branch,
        isPrivate: Boolean(repo.isPrivate),
        includePatterns: repo.includePatterns ? JSON.parse(repo.includePatterns) : undefined,
        excludePatterns: repo.excludePatterns ? JSON.parse(repo.excludePatterns) : undefined
      };
      
      timer.stop({ found: 'true' });
      return config;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get repository ${id}`);
      throw error;
    }
  }

  /**
   * Update a repository configuration
   * @param id Repository ID
   * @param config Repository configuration updates
   * @returns Whether the update was successful
   */
  async updateRepository(id: string, config: Partial<RepositoryConfig>): Promise<boolean> {
    const timer = metrics.startTimer('repository_service.update_repository');
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Build update query dynamically based on provided fields
      const updates: string[] = [];
      const values: any[] = [];
      
      if (config.branch !== undefined) {
        updates.push('branch = ?');
        values.push(config.branch);
      }
      
      if (config.isPrivate !== undefined) {
        updates.push('isPrivate = ?');
        values.push(config.isPrivate ? 1 : 0);
      }
      
      if (config.includePatterns !== undefined) {
        updates.push('includePatterns = ?');
        values.push(config.includePatterns ? JSON.stringify(config.includePatterns) : null);
      }
      
      if (config.excludePatterns !== undefined) {
        updates.push('excludePatterns = ?');
        values.push(config.excludePatterns ? JSON.stringify(config.excludePatterns) : null);
      }
      
      // Always update the updatedAt timestamp
      updates.push('updatedAt = ?');
      values.push(now);
      
      // Add the repository ID as the last parameter
      values.push(id);
      
      if (updates.length === 1) {
        // Only updatedAt was added, nothing to update
        timer.stop({ updated: 'false' });
        return false;
      }
      
      const query = `
        UPDATE provider_repositories
        SET ${updates.join(', ')}
        WHERE id = ?
      `;
      
      const result = await this.env.DB.prepare(query)
        .bind(...values)
        .run();
      
      const updated = result.meta.changes > 0;
      
      if (updated) {
        logger.info({ id }, 'Updated repository configuration');
      }
      
      timer.stop({ updated: updated.toString() });
      return updated;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to update repository ${id}`);
      throw error;
    }
  }

  /**
   * Delete a repository configuration
   * @param id Repository ID
   * @returns Whether the deletion was successful
   */
  async deleteRepository(id: string): Promise<boolean> {
    const timer = metrics.startTimer('repository_service.delete_repository');
    
    try {
      const result = await this.env.DB.prepare(`
        DELETE FROM provider_repositories
        WHERE id = ?
      `)
      .bind(id)
      .run();
      
      const deleted = result.meta.changes > 0;
      
      if (deleted) {
        logger.info({ id }, 'Deleted repository configuration');
        metrics.counter('repository_service.repositories_deleted', 1);
      }
      
      timer.stop({ deleted: deleted.toString() });
      return deleted;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to delete repository ${id}`);
      throw error;
    }
  }

  /**
   * List repositories for a user
   * @param userId User ID
   * @param provider Optional provider filter
   * @returns Array of repository configurations
   */
  async listRepositoriesForUser(userId: string, provider?: string): Promise<RepositoryConfig[]> {
    const timer = metrics.startTimer('repository_service.list_repositories_for_user');
    
    try {
      let query = `
        SELECT id, userId, provider, owner, repo, branch, isPrivate, includePatterns, excludePatterns
        FROM provider_repositories
        WHERE userId = ?
      `;
      
      const params: any[] = [userId];
      
      if (provider) {
        query += ' AND provider = ?';
        params.push(provider);
      }
      
      const results = await this.env.DB.prepare(query)
        .bind(...params)
        .all();
      
      const repositories: RepositoryConfig[] = results.results.map((repo: any) => ({
        id: repo.id,
        userId: repo.userId,
        provider: repo.provider,
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.branch,
        isPrivate: Boolean(repo.isPrivate),
        includePatterns: repo.includePatterns ? JSON.parse(repo.includePatterns) : undefined,
        excludePatterns: repo.excludePatterns ? JSON.parse(repo.excludePatterns) : undefined
      }));
      
      timer.stop({ count: repositories.length.toString() });
      return repositories;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to list repositories for user ${userId}`);
      throw error;
    }
  }

  /**
   * Get repositories that need to be synced
   * @param limit Maximum number of repositories to return
   * @param provider Optional provider filter
   * @returns Array of repository configurations
   */
  async getRepositoriesToSync(limit: number = 50, provider?: string): Promise<RepositoryConfig[]> {
    const timer = metrics.startTimer('repository_service.get_repositories_to_sync');
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      let query = `
        SELECT id, userId, provider, owner, repo, branch, isPrivate, includePatterns, excludePatterns
        FROM provider_repositories
        WHERE (
          lastSyncedAt IS NULL
          OR lastSyncedAt < ?
          OR (nextRetryAt IS NOT NULL AND nextRetryAt < ?)
        )
        AND (rateLimitReset IS NULL OR rateLimitReset < ?)
      `;
      
      const params: any[] = [
        now - 3600, // Sync repos not updated in the last hour
        now,        // Retry failed repos whose retry time has passed
        now         // Only sync repos whose rate limit has reset
      ];
      
      if (provider) {
        query += ' AND provider = ?';
        params.push(provider);
      }
      
      query += ' ORDER BY lastSyncedAt ASC NULLS FIRST LIMIT ?';
      params.push(limit);
      
      const results = await this.env.DB.prepare(query)
        .bind(...params)
        .all();
      
      const repositories: RepositoryConfig[] = results.results.map((repo: any) => ({
        id: repo.id,
        userId: repo.userId,
        provider: repo.provider,
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.branch,
        isPrivate: Boolean(repo.isPrivate),
        includePatterns: repo.includePatterns ? JSON.parse(repo.includePatterns) : undefined,
        excludePatterns: repo.excludePatterns ? JSON.parse(repo.excludePatterns) : undefined
      }));
      
      timer.stop({ count: repositories.length.toString() });
      return repositories;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to get repositories to sync');
      throw error;
    }
  }

  /**
   * Update repository sync status
   * @param id Repository ID
   * @param status Sync status updates
   * @returns Whether the update was successful
   */
  async updateSyncStatus(id: string, status: Partial<RepositorySyncStatus>): Promise<boolean> {
    const timer = metrics.startTimer('repository_service.update_sync_status');
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Build update query dynamically based on provided fields
      const updates: string[] = [];
      const values: any[] = [];
      
      if (status.lastSyncedAt !== undefined) {
        updates.push('lastSyncedAt = ?');
        values.push(status.lastSyncedAt);
      }
      
      if (status.lastCommitSha !== undefined) {
        updates.push('lastCommitSha = ?');
        values.push(status.lastCommitSha);
      }
      
      if (status.etag !== undefined) {
        updates.push('etag = ?');
        values.push(status.etag);
      }
      
      if (status.retryCount !== undefined) {
        updates.push('retryCount = ?');
        values.push(status.retryCount);
      }
      
      if (status.nextRetryAt !== undefined) {
        updates.push('nextRetryAt = ?');
        values.push(status.nextRetryAt);
      }
      
      if (status.rateLimitReset !== undefined) {
        updates.push('rateLimitReset = ?');
        values.push(status.rateLimitReset);
      }
      
      // Always update the updatedAt timestamp
      updates.push('updatedAt = ?');
      values.push(now);
      
      // Add the repository ID as the last parameter
      values.push(id);
      
      if (updates.length === 1) {
        // Only updatedAt was added, nothing to update
        timer.stop({ updated: 'false' });
        return false;
      }
      
      const query = `
        UPDATE provider_repositories
        SET ${updates.join(', ')}
        WHERE id = ?
      `;
      
      const result = await this.env.DB.prepare(query)
        .bind(...values)
        .run();
      
      const updated = result.meta.changes > 0;
      
      timer.stop({ updated: updated.toString() });
      return updated;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to update sync status for repository ${id}`);
      throw error;
    }
  }

  /**
   * Record a sync error for a repository
   * @param id Repository ID
   * @param error Error message
   * @param isTransient Whether the error is transient (should be retried)
   * @returns Whether the update was successful
   */
  async recordSyncError(id: string, error: string, isTransient: boolean): Promise<boolean> {
    const timer = metrics.startTimer('repository_service.record_sync_error');
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Get current retry count
      const repo = await this.env.DB.prepare(`
        SELECT retryCount
        FROM provider_repositories
        WHERE id = ?
      `)
      .bind(id)
      .first<{ retryCount: number }>();
      
      if (!repo) {
        timer.stop({ found: 'false' });
        return false;
      }
      
      const retryCount = (repo.retryCount || 0) + 1;
      
      // Calculate next retry time with exponential backoff
      // Base delay is 5 minutes, doubled for each retry, up to 24 hours
      const baseDelay = 5 * 60; // 5 minutes in seconds
      const maxDelay = 24 * 60 * 60; // 24 hours in seconds
      
      let nextRetryAt: number | null = null;
      
      if (isTransient) {
        const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1), maxDelay);
        nextRetryAt = now + delay;
      }
      
      // Update repository with error information
      const result = await this.env.DB.prepare(`
        UPDATE provider_repositories
        SET retryCount = ?,
            nextRetryAt = ?,
            updatedAt = ?
        WHERE id = ?
      `)
      .bind(
        retryCount,
        nextRetryAt,
        now,
        id
      )
      .run();
      
      const updated = result.meta.changes > 0;
      
      if (updated) {
        logger.error({ id, error, retryCount, nextRetryAt }, 'Repository sync error');
        
        metrics.counter('repository_service.sync_errors', 1, {
          transient: isTransient.toString()
        });
      }
      
      timer.stop({ updated: updated.toString() });
      return updated;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to record sync error for repository ${id}`);
      throw error;
    }
  }

  /**
   * Reset retry count for a repository
   * @param id Repository ID
   * @returns Whether the update was successful
   */
  async resetRetryCount(id: string): Promise<boolean> {
    const timer = metrics.startTimer('repository_service.reset_retry_count');
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      const result = await this.env.DB.prepare(`
        UPDATE provider_repositories
        SET retryCount = 0,
            nextRetryAt = NULL,
            updatedAt = ?
        WHERE id = ?
      `)
      .bind(now, id)
      .run();
      
      const updated = result.meta.changes > 0;
      
      if (updated) {
        logger.info({ id }, 'Reset repository retry count');
      }
      
      timer.stop({ updated: updated.toString() });
      return updated;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to reset retry count for repository ${id}`);
      throw error;
    }
  }
}