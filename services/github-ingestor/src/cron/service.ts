import { RepositoryService, RepositoryConfig, RepositorySyncStatus } from '../services/repository-service';
import { GitHubApiClient, GitHubApiError } from '../github/api-client';
import { getInstallationToken, getServiceToken, getUserToken } from '../github/auth';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { Env, IngestMessage } from '../types';

/**
 * Service for handling cron operations
 */
export class CronService {
  private env: Env;
  private repositoryService: RepositoryService;

  /**
   * Create a new cron service
   * @param env Environment
   */
  constructor(env: Env) {
    this.env = env;
    this.repositoryService = new RepositoryService(env);
  }

  /**
   * Get repositories that need to be synced
   * @param limit Maximum number of repositories to return
   * @param provider Provider filter (default: 'github')
   * @returns Array of repository configurations
   */
  async getRepositoriesToSync(limit: number = 50, provider: string = 'github'): Promise<RepositoryConfig[]> {
    const timer = metrics.startTimer('cron_service.get_repositories_to_sync');
    
    try {
      const repositories = await this.repositoryService.getRepositoriesToSync(limit, provider);
      
      logger().info({
        count: repositories.length,
        provider
      }, 'Found repositories to sync');
      
      timer.stop({ count: repositories.length.toString() });
      return repositories;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to get repositories to sync');
      throw error;
    }
  }

  /**
   * Check if a repository needs to be synced by checking for updates
   * @param repository Repository configuration
   * @returns Whether the repository needs to be synced and the latest commit SHA
   */
  async checkRepositoryForUpdates(repository: RepositoryConfig): Promise<{ needsSync: boolean; commitSha?: string; etag?: string }> {
    const timer = metrics.startTimer('cron_service.check_repository_for_updates');
    
    try {
      // Get appropriate token based on repository privacy
      let token: string;
      if (repository.isPrivate && repository.userId) {
        // For private repositories, use user token
        token = await getUserToken(repository.userId, this.env);
      } else if (repository.isPrivate) {
        // For private system repositories, use GitHub App installation token
        const installationId = await this.env.DB.prepare(`
          SELECT installationId
          FROM provider_credentials
          WHERE provider = 'github'
          AND userId = ?
        `)
        .bind(repository.userId || 'system')
        .first<{ installationId: string }>();

        if (!installationId) {
          throw new Error(`No GitHub App installation found for repository ${repository.owner}/${repository.repo}`);
        }

        token = await getInstallationToken(
          this.env.GITHUB_APP_ID,
          this.env.GITHUB_PRIVATE_KEY,
          installationId.installationId
        );
      } else {
        // For public repositories, use service token
        token = getServiceToken(this.env);
      }

      // Create GitHub API client
      const client = new GitHubApiClient(token);

      // Get repository status from database
      const repoStatus = await this.env.DB.prepare(`
        SELECT lastCommitSha, etag
        FROM provider_repositories
        WHERE id = ?
      `)
      .bind(repository.id)
      .first<{ lastCommitSha?: string; etag?: string }>();

      // Get the latest commit for the branch
      const commitResponse = await client.getCommit(
        repository.owner,
        repository.repo,
        repository.branch || 'main',
        repoStatus?.etag
      );
      
      // If we got a 304 Not Modified, no need to sync
      if (!commitResponse.data) {
        logger().info({
          owner: repository.owner,
          repo: repository.repo,
          branch: repository.branch
        }, 'Repository not modified since last sync');
        
        timer.stop({ notModified: 'true' });
        return { needsSync: false };
      }
      
      // Store the new commit SHA and etag
      const newCommitSha = commitResponse.data.sha;
      const newEtag = commitResponse.etag;
      
      // If the commit hasn't changed, no need to sync
      if (repoStatus?.lastCommitSha && repoStatus.lastCommitSha === newCommitSha) {
        logger().info({
          owner: repository.owner,
          repo: repository.repo,
          branch: repository.branch,
          commitSha: newCommitSha
        }, 'Repository commit unchanged since last sync');
        
        timer.stop({ unchanged: 'true' });
        return { needsSync: false };
      }
      
      // Repository needs to be synced
      logger().info({
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch,
        commitSha: newCommitSha
      }, 'Repository has updates and needs to be synced');
      
      timer.stop({ needsSync: 'true' });
      return { needsSync: true, commitSha: newCommitSha, etag: newEtag };
    } catch (error) {
      timer.stop({ error: 'true' });
      
      // Handle rate limit errors
      if (error instanceof GitHubApiError && error.isRateLimitError) {
        const rateLimitReset = (error as any).rateLimit?.reset;
        
        if (rateLimitReset && repository.id) {
          await this.updateRepositoryRateLimit(repository.id, rateLimitReset);
          
          logger().warn({
            owner: repository.owner,
            repo: repository.repo,
            rateLimitReset: new Date(rateLimitReset * 1000).toISOString()
          }, 'Rate limit exceeded, will retry after reset');
        }
      }
      
      logError(error as Error, `Failed to check updates for repository ${repository.owner}/${repository.repo}`);
      return { needsSync: false };
    }
  }

  /**
   * Enqueue a repository for ingestion
   * @param repository Repository configuration
   * @param commitSha Latest commit SHA
   * @param etag ETag for conditional requests
   * @returns Whether the repository was successfully enqueued
   */
  async enqueueRepository(repository: RepositoryConfig, commitSha?: string, etag?: string): Promise<boolean> {
    const timer = metrics.startTimer('cron_service.enqueue_repository');
    
    try {
      // Ensure repository has an ID
      if (!repository.id) {
        throw new Error('Repository ID is required for enqueueing');
      }

      // Create ingest message
      const message: IngestMessage = {
        type: 'repository',
        repoId: repository.id,
        userId: repository.userId,
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch || 'main',
        isPrivate: repository.isPrivate,
        includePatterns: repository.includePatterns,
        excludePatterns: repository.excludePatterns
      };
      
      // Enqueue message
      await this.env.INGEST_QUEUE.send(message);
      
      // Update repository status
      if ((commitSha || etag) && repository.id) {
        const status: Partial<RepositorySyncStatus> = {
          retryCount: 0,
          nextRetryAt: undefined
        };
        
        if (commitSha) {
          status.lastCommitSha = commitSha;
        }
        
        if (etag) {
          status.etag = etag;
        }
        
        await this.repositoryService.updateSyncStatus(repository.id, status);
      }
      
      logger().info({
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch
      }, 'Enqueued repository for ingestion');
      
      metrics.counter('cron_service.repositories_enqueued', 1, {
        provider: repository.provider,
        is_private: repository.isPrivate.toString()
      });
      
      timer.stop();
      return true;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to enqueue repository ${repository.owner}/${repository.repo}`);
      
      // Record sync error if repository has an ID
      if (repository.id) {
        await this.repositoryService.recordSyncError(
          repository.id,
          `Failed to enqueue repository: ${(error as Error).message}`,
          true // Transient error, will retry
        );
      }
      
      return false;
    }
  }

  /**
   * Update repository rate limit reset time
   * @param repoId Repository ID
   * @param rateLimitReset Rate limit reset time (epoch seconds)
   * @returns Whether the update was successful
   */
  async updateRepositoryRateLimit(repoId: string, rateLimitReset: number): Promise<boolean> {
    const timer = metrics.startTimer('cron_service.update_repository_rate_limit');
    
    try {
      const updated = await this.repositoryService.updateSyncStatus(repoId, {
        rateLimitReset
      });
      
      timer.stop({ updated: updated.toString() });
      return updated;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to update rate limit for repository ${repoId}`);
      return false;
    }
  }

  /**
   * Prioritize repositories for syncing
   * @param repositories Array of repository configurations
   * @returns Prioritized array of repository configurations
   */
  prioritizeRepositories(repositories: RepositoryConfig[]): RepositoryConfig[] {
    // Sort repositories by last sync time (oldest first)
    // Repositories that have never been synced (lastSyncedAt is null) come first
    return [...repositories].sort((a, b) => {
      const aLastSynced = (a as any).lastSyncedAt;
      const bLastSynced = (b as any).lastSyncedAt;
      
      if (aLastSynced === null && bLastSynced === null) {
        return 0;
      }
      
      if (aLastSynced === null) {
        return -1;
      }
      
      if (bLastSynced === null) {
        return 1;
      }
      
      return aLastSynced - bLastSynced;
    });
  }
}