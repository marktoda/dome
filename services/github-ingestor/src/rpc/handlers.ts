import { Env } from '../types';
import { ServiceFactory } from '../services';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { ulid } from 'ulid';
import {
  CreateRepositoryRequest,
  UpdateRepositoryRequest,
  ListRepositoriesRequest,
  SyncRepositoryRequest,
  GetRepositoryStatusRequest,
  InstallationRequest,
  ListInstallationsRequest,
  GetStatisticsRequest,
  RepositoryResponse,
  RepositoryStatusResponse,
  InstallationResponse,
  StatisticsResponse
} from './schemas';

/**
 * RPC Handlers for the GitHub Ingestor service
 */
export class RpcHandlers {
  private services: ServiceFactory;
  private env: Env;

  /**
   * Create a new RPC handlers instance
   * @param services Service factory
   * @param env Environment
   */
  constructor(services: ServiceFactory, env: Env) {
    this.services = services;
    this.env = env;
  }

  /**
   * Add a new repository configuration
   * @param request Repository configuration
   * @returns Created repository ID and configuration
   */
  async addRepository(request: CreateRepositoryRequest): Promise<RepositoryResponse> {
    const timer = metrics.startTimer('rpc.add_repository');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // Create the repository configuration
      const id = await repositoryService.createRepository({
        userId: request.userId,
        provider: request.provider,
        owner: request.owner,
        repo: request.repo,
        branch: request.branch,
        isPrivate: request.isPrivate,
        includePatterns: request.includePatterns,
        excludePatterns: request.excludePatterns
      });
      
      // Get the created repository
      const repository = await repositoryService.getRepository(id);
      
      if (!repository) {
        throw new Error(`Failed to retrieve created repository: ${id}`);
      }
      
      // Enqueue a sync job for the new repository
      const queueService = this.services.getQueueService();
      await queueService.enqueueRepository(
        id,
        repository.userId,
        repository.provider,
        repository.owner,
        repository.repo,
        repository.branch || 'main',
        repository.isPrivate,
        repository.includePatterns,
        repository.excludePatterns
      );
      
      logger().info({
        id,
        userId: request.userId,
        provider: request.provider,
        owner: request.owner,
        repo: request.repo
      }, 'Added repository configuration via RPC');
      
      // Convert to response format
      const now = Math.floor(Date.now() / 1000);
      const response: RepositoryResponse = {
        id,
        userId: repository.userId,
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch || 'main',
        isPrivate: repository.isPrivate,
        includePatterns: repository.includePatterns,
        excludePatterns: repository.excludePatterns,
        createdAt: now,
        updatedAt: now
      };
      
      timer.stop({ provider: request.provider });
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to add repository via RPC');
      throw error;
    }
  }

  /**
   * Update an existing repository configuration
   * @param request Repository update request
   * @returns Updated repository configuration
   */
  async updateRepository(request: UpdateRepositoryRequest): Promise<RepositoryResponse> {
    const timer = metrics.startTimer('rpc.update_repository');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // Get the existing repository
      const existingRepo = await repositoryService.getRepository(request.id);
      
      if (!existingRepo) {
        throw new Error(`Repository not found: ${request.id}`);
      }
      
      // Update the repository configuration
      const updated = await repositoryService.updateRepository(request.id, {
        branch: request.branch,
        isPrivate: request.isPrivate,
        includePatterns: request.includePatterns,
        excludePatterns: request.excludePatterns
      });
      
      if (!updated) {
        throw new Error(`Failed to update repository: ${request.id}`);
      }
      
      // Get the updated repository
      const repository = await repositoryService.getRepository(request.id);
      
      if (!repository) {
        throw new Error(`Failed to retrieve updated repository: ${request.id}`);
      }
      
      logger().info({
        id: request.id,
        changes: Object.keys(request).filter(k => k !== 'id').join(', ')
      }, 'Updated repository configuration via RPC');
      
      // Convert to response format
      const response: RepositoryResponse = {
        id: repository.id!,
        userId: repository.userId,
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch || 'main',
        isPrivate: repository.isPrivate,
        includePatterns: repository.includePatterns,
        excludePatterns: repository.excludePatterns,
        createdAt: 0, // We don't have this information from the service
        updatedAt: Math.floor(Date.now() / 1000)
      };
      
      timer.stop();
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to update repository via RPC');
      throw error;
    }
  }

  /**
   * Remove a repository configuration
   * @param id Repository ID
   * @returns Whether the removal was successful
   */
  async removeRepository(id: string): Promise<{ success: boolean }> {
    const timer = metrics.startTimer('rpc.remove_repository');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // Delete the repository configuration
      const deleted = await repositoryService.deleteRepository(id);
      
      if (deleted) {
        logger().info({ id }, 'Removed repository configuration via RPC');
      } else {
        logger().warn({ id }, 'Repository not found for removal via RPC');
      }
      
      timer.stop({ deleted: deleted.toString() });
      return { success: deleted };
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to remove repository ${id} via RPC`);
      throw error;
    }
  }

  /**
   * List repositories for a user
   * @param request List repositories request
   * @returns Array of repository configurations
   */
  async listRepositories(request: ListRepositoriesRequest): Promise<RepositoryResponse[]> {
    const timer = metrics.startTimer('rpc.list_repositories');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // List repositories for the user
      const repositories = await repositoryService.listRepositoriesForUser(
        request.userId,
        request.provider
      );
      
      // Convert to response format
      const response: RepositoryResponse[] = repositories.map(repo => ({
        id: repo.id!,
        userId: repo.userId,
        provider: repo.provider,
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.branch || 'main',
        isPrivate: repo.isPrivate,
        includePatterns: repo.includePatterns,
        excludePatterns: repo.excludePatterns,
        createdAt: 0, // We don't have this information from the service
        updatedAt: 0 // We don't have this information from the service
      }));
      
      timer.stop({ count: repositories.length.toString() });
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to list repositories for user ${request.userId} via RPC`);
      throw error;
    }
  }

  /**
   * Get a repository configuration
   * @param id Repository ID
   * @returns Repository configuration
   */
  async getRepository(id: string): Promise<RepositoryResponse> {
    const timer = metrics.startTimer('rpc.get_repository');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // Get the repository
      const repository = await repositoryService.getRepository(id);
      
      if (!repository) {
        throw new Error(`Repository not found: ${id}`);
      }
      
      // Convert to response format
      const response: RepositoryResponse = {
        id: repository.id!,
        userId: repository.userId,
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch || 'main',
        isPrivate: repository.isPrivate,
        includePatterns: repository.includePatterns,
        excludePatterns: repository.excludePatterns,
        createdAt: 0, // We don't have this information from the service
        updatedAt: 0 // We don't have this information from the service
      };
      
      timer.stop();
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get repository ${id} via RPC`);
      throw error;
    }
  }

  /**
   * Trigger a repository sync
   * @param request Sync repository request
   * @returns Success status
   */
  async syncRepository(request: SyncRepositoryRequest): Promise<{ success: boolean }> {
    const timer = metrics.startTimer('rpc.sync_repository');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // Get the repository
      const repository = await repositoryService.getRepository(request.id);
      
      if (!repository) {
        throw new Error(`Repository not found: ${request.id}`);
      }
      
      // If force is true, reset the retry count
      if (request.force) {
        await repositoryService.resetRetryCount(request.id);
      }
      
      // Enqueue a sync job
      const queueService = this.services.getQueueService();
      await queueService.enqueueRepository(
        request.id,
        repository.userId,
        repository.provider,
        repository.owner,
        repository.repo,
        repository.branch || 'main',
        repository.isPrivate,
        repository.includePatterns,
        repository.excludePatterns
      );
      
      logger().info({
        id: request.id,
        force: request.force
      }, 'Triggered repository sync via RPC');
      
      timer.stop();
      return { success: true };
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to sync repository ${request.id} via RPC`);
      throw error;
    }
  }

  /**
   * Get repository sync status
   * @param request Get repository status request
   * @returns Repository status
   */
  async getRepositoryStatus(request: GetRepositoryStatusRequest): Promise<RepositoryStatusResponse> {
    const timer = metrics.startTimer('rpc.get_repository_status');
    
    try {
      const repositoryService = this.services.getRepositoryService();
      
      // Get the repository
      const repository = await repositoryService.getRepository(request.id);
      
      if (!repository) {
        throw new Error(`Repository not found: ${request.id}`);
      }
      
      // Get the sync status
      // Note: We need to query the database directly for this information
      const result = await this.env.DB.prepare(`
        SELECT lastSyncedAt, lastCommitSha, etag, retryCount, nextRetryAt, rateLimitReset
        FROM provider_repositories
        WHERE id = ?
      `)
      .bind(request.id)
      .first<{
        lastSyncedAt: number | null;
        lastCommitSha: string | null;
        etag: string | null;
        retryCount: number;
        nextRetryAt: number | null;
        rateLimitReset: number | null;
      }>();
      
      if (!result) {
        throw new Error(`Failed to get sync status for repository ${request.id}`);
      }
      
      // Determine the status
      let status: 'idle' | 'syncing' | 'failed' | 'rate_limited' = 'idle';
      let error: string | undefined;
      
      const now = Math.floor(Date.now() / 1000);
      
      if (result.retryCount > 0 && result.nextRetryAt && result.nextRetryAt > now) {
        status = 'failed';
        error = `Sync failed, will retry at ${new Date(result.nextRetryAt * 1000).toISOString()}`;
      } else if (result.rateLimitReset && result.rateLimitReset > now) {
        status = 'rate_limited';
        error = `Rate limited, will reset at ${new Date(result.rateLimitReset * 1000).toISOString()}`;
      }
      
      // Check if there's an active sync job in the queue
      // Since we don't have a direct way to check if a repository is queued,
      // we'll assume it's not queued for now
      // In a real implementation, we would need to add this functionality to QueueService
      const isQueued = false;
      
      if (isQueued) {
        status = 'syncing';
      }
      
      // Convert to response format
      const response: RepositoryStatusResponse = {
        id: request.id,
        lastSyncedAt: result.lastSyncedAt || undefined,
        lastCommitSha: result.lastCommitSha || undefined,
        retryCount: result.retryCount,
        nextRetryAt: result.nextRetryAt || undefined,
        rateLimitReset: result.rateLimitReset || undefined,
        status,
        error
      };
      
      timer.stop();
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get repository status ${request.id} via RPC`);
      throw error;
    }
  }

  /**
   * Add a GitHub App installation
   * @param request Installation request
   * @returns Installation response
   */
  async addInstallation(request: InstallationRequest): Promise<InstallationResponse> {
    const timer = metrics.startTimer('rpc.add_installation');
    
    try {
      // Get the installation details from GitHub
      const installationId = request.installationId;
      const userId = request.userId;
      
      // Store the installation in the database
      const now = Math.floor(Date.now() / 1000);
      const id = ulid();
      
      await this.env.DB.prepare(`
        INSERT INTO provider_credentials (
          id, userId, provider, installationId, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (userId, provider) DO UPDATE SET
          installationId = excluded.installationId,
          updatedAt = excluded.updatedAt
      `)
      .bind(
        id,
        userId,
        'github',
        installationId,
        now,
        now
      )
      .run();
      
      logger().info({
        userId,
        installationId
      }, 'Added GitHub App installation via RPC');
      
      // Return the installation details
      const response: InstallationResponse = {
        id,
        userId,
        provider: 'github',
        installationId,
        account: 'unknown', // We would need to fetch this from GitHub
        createdAt: now,
        updatedAt: now
      };
      
      timer.stop();
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to add GitHub App installation via RPC');
      throw error;
    }
  }

  /**
   * List GitHub App installations for a user
   * @param request List installations request
   * @returns Array of installations
   */
  async listInstallations(request: ListInstallationsRequest): Promise<InstallationResponse[]> {
    const timer = metrics.startTimer('rpc.list_installations');
    
    try {
      // Get the installations from the database
      const results = await this.env.DB.prepare(`
        SELECT id, userId, provider, installationId, createdAt, updatedAt
        FROM provider_credentials
        WHERE userId = ? AND provider = 'github'
      `)
      .bind(request.userId)
      .all<{
        id: string;
        userId: string;
        provider: string;
        installationId: string;
        createdAt: number;
        updatedAt: number;
      }>();
      
      // Convert to response format
      const response: InstallationResponse[] = results.results.map(installation => ({
        id: installation.id,
        userId: installation.userId,
        provider: installation.provider,
        installationId: installation.installationId,
        account: 'unknown', // We would need to fetch this from GitHub
        createdAt: installation.createdAt,
        updatedAt: installation.updatedAt
      }));
      
      timer.stop({ count: response.length.toString() });
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to list GitHub App installations for user ${request.userId} via RPC`);
      throw error;
    }
  }

  /**
   * Remove a GitHub App installation
   * @param id Installation ID
   * @returns Whether the removal was successful
   */
  async removeInstallation(id: string): Promise<{ success: boolean }> {
    const timer = metrics.startTimer('rpc.remove_installation');
    
    try {
      // Delete the installation from the database
      const result = await this.env.DB.prepare(`
        DELETE FROM provider_credentials
        WHERE id = ?
      `)
      .bind(id)
      .run();
      
      const deleted = result.meta.changes > 0;
      
      if (deleted) {
        logger().info({ id }, 'Removed GitHub App installation via RPC');
      } else {
        logger().warn({ id }, 'GitHub App installation not found for removal via RPC');
      }
      
      timer.stop({ deleted: deleted.toString() });
      return { success: deleted };
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to remove GitHub App installation ${id} via RPC`);
      throw error;
    }
  }

  /**
   * Get ingestion statistics
   * @param request Get statistics request
   * @returns Statistics response
   */
  async getStatistics(request: GetStatisticsRequest): Promise<StatisticsResponse> {
    const timer = metrics.startTimer('rpc.get_statistics');
    
    try {
      // Calculate the time range
      const now = Math.floor(Date.now() / 1000);
      let startTime: number;
      
      switch (request.timeRange) {
        case 'day':
          startTime = now - 24 * 60 * 60; // 1 day
          break;
        case 'week':
          startTime = now - 7 * 24 * 60 * 60; // 7 days
          break;
        case 'month':
          startTime = now - 30 * 24 * 60 * 60; // 30 days
          break;
        default:
          startTime = now - 24 * 60 * 60; // Default to 1 day
      }
      
      // Build the query conditions
      const conditions: string[] = [];
      const params: any[] = [];
      
      if (request.userId) {
        conditions.push('userId = ?');
        params.push(request.userId);
      }
      
      if (request.provider) {
        conditions.push('provider = ?');
        params.push(request.provider);
      }
      
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      
      // Get repository statistics
      const repoStats = await this.env.DB.prepare(`
        SELECT
          COUNT(*) as totalRepositories,
          SUM(CASE WHEN lastSyncedAt IS NOT NULL THEN 1 ELSE 0 END) as syncedRepositories,
          SUM(CASE WHEN retryCount > 0 AND (nextRetryAt IS NULL OR nextRetryAt > ?) THEN 1 ELSE 0 END) as failedRepositories,
          MAX(lastSyncedAt) as lastSyncTime
        FROM provider_repositories
        ${whereClause}
      `)
      .bind(now, ...params)
      .first<{
        totalRepositories: number;
        syncedRepositories: number;
        failedRepositories: number;
        lastSyncTime: number | null;
      }>();
      
      // Get content statistics
      // This is a simplified version - in a real implementation, we would need to join with content_blobs
      // and filter by repository IDs that match the user/provider criteria
      const contentStats = {
        totalFiles: 0,
        totalSizeBytes: 0
      };
      
      // Construct the response
      const response: StatisticsResponse = {
        totalRepositories: repoStats?.totalRepositories || 0,
        totalFiles: contentStats.totalFiles,
        totalSizeBytes: contentStats.totalSizeBytes,
        syncedRepositories: repoStats?.syncedRepositories || 0,
        failedRepositories: repoStats?.failedRepositories || 0,
        lastSyncTime: repoStats?.lastSyncTime || undefined
      };
      
      timer.stop();
      return response;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to get ingestion statistics via RPC');
      throw error;
    }
  }
}