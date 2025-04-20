import { Env, GitHubPushEvent, GitHubInstallationEvent, GitHubInstallationRepositoriesEvent } from '../types';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { ulid } from 'ulid';

/**
 * WebhookService handles the business logic for processing GitHub webhook events
 */
export class WebhookService {
  constructor(private env: Env) {}

  /**
   * Process a GitHub push event
   * @param payload Push event payload
   * @returns Whether the event was processed successfully
   */
  async processPushEvent(payload: GitHubPushEvent): Promise<boolean> {
    const { repository, ref, before, after, commits } = payload;
    
    // Only process pushes to the default branch
    const branchName = ref.replace('refs/heads/', '');
    if (branchName !== repository.default_branch) {
      logger().info(
        { repository: repository.full_name, branch: branchName },
        'Ignoring push to non-default branch'
      );
      metrics.counter('webhook.push.ignored', 1, { reason: 'non_default_branch' });
      return false;
    }
    
    logger().info(
      {
        repository: repository.full_name,
        before,
        after,
        commit_count: commits.length,
      },
      'Processing push event'
    );
    
    try {
      // Check if we have this repository in our database
      const repoResult = await this.env.DB.prepare(`
        SELECT id, userId, branch, lastCommitSha, isPrivate, includePatterns, excludePatterns
        FROM provider_repositories
        WHERE provider = 'github' AND owner = ? AND repo = ?
      `)
      .bind(repository.owner.login, repository.name)
      .all();
      
      if (!repoResult.results.length) {
        logger().info(
          { repository: repository.full_name },
          'Repository not found in database, ignoring'
        );
        metrics.counter('webhook.push.ignored', 1, { reason: 'repo_not_found' });
        return false;
      }
      
      // Process each repository configuration (there might be multiple users tracking the same repo)
      for (const repo of repoResult.results) {
        // Skip if the commit is already processed
        if (repo.lastCommitSha === after) {
          logger().info(
            { repository: repository.full_name, commit: after },
            'Commit already processed'
          );
          continue;
        }
        
        // Identify changed files from the commits
        const changedFiles = this.identifyChangedFiles(commits);
        logger().info(
          {
            repository: repository.full_name,
            changedFiles: changedFiles.length
          },
          'Identified changed files'
        );
        
        // Enqueue a job to process the repository
        await this.enqueueRepositoryJob(
          String(repo.id),
          repo.userId as string | null,
          repository.owner.login,
          repository.name,
          branchName,
          repository.private,
          repo.includePatterns ? JSON.parse(repo.includePatterns as string) as string[] : undefined,
          repo.excludePatterns ? JSON.parse(repo.excludePatterns as string) as string[] : undefined
        );
        
        // Update the last commit SHA
        await this.updateLastCommitSha(String(repo.id), after);
        
        logger().info(
          { repository: repository.full_name, repoId: repo.id },
          'Enqueued repository for processing'
        );
        metrics.counter('webhook.push.enqueued', 1);
      }
      
      return true;
    } catch (error) {
      logError(error as Error, 'Error processing push event', {
        repository: repository.full_name,
      });
      metrics.counter('webhook.push.error', 1);
      throw error;
    }
  }

  /**
   * Process a GitHub installation event
   * @param payload Installation event payload
   * @returns Whether the event was processed successfully
   */
  async processInstallationEvent(payload: GitHubInstallationEvent): Promise<boolean> {
    const { action, installation, repositories } = payload;
    
    logger().info(
      {
        action,
        installation_id: installation.id,
        account: installation.account.login,
      },
      'Processing installation event'
    );
    
    try {
      switch (action) {
        case 'created':
          // Store the installation in the database
          await this.storeInstallation(
            installation.account.id.toString(),
            installation.id.toString()
          );
          
          // Process repositories if provided
          if (repositories) {
            for (const repo of repositories) {
              await this.addRepository(
                installation.account.id.toString(),
                installation.account.login,
                repo.name,
                repo.private
              );
            }
          }
          
          metrics.counter('webhook.installation.created', 1);
          break;
          
        case 'deleted':
          // Remove the installation from the database
          await this.removeInstallation(
            installation.account.id.toString(),
            installation.id.toString()
          );
          
          metrics.counter('webhook.installation.deleted', 1);
          break;
          
        default:
          logger().info({ action }, 'Ignoring installation action');
          break;
      }
      
      return true;
    } catch (error) {
      logError(error as Error, 'Error processing installation event', {
        action,
        installation_id: installation.id,
      });
      metrics.counter('webhook.installation.error', 1);
      throw error;
    }
  }

  /**
   * Process a GitHub installation_repositories event
   * @param payload Installation repositories event payload
   * @returns Whether the event was processed successfully
   */
  async processInstallationRepositoriesEvent(
    payload: GitHubInstallationRepositoriesEvent
  ): Promise<boolean> {
    const { action, installation, repositories_added, repositories_removed } = payload;
    
    logger().info(
      {
        action,
        installation_id: installation.id,
        account: installation.account.login,
        added: repositories_added?.length || 0,
        removed: repositories_removed?.length || 0,
      },
      'Processing installation_repositories event'
    );
    
    try {
      // Process added repositories
      if (action === 'added' && repositories_added) {
        for (const repo of repositories_added) {
          await this.addRepository(
            installation.account.id.toString(),
            installation.account.login,
            repo.name,
            repo.private
          );
        }
        metrics.counter('webhook.installation_repositories.added', repositories_added.length);
      }
      
      // Process removed repositories
      if (action === 'removed' && repositories_removed) {
        for (const repo of repositories_removed) {
          await this.removeRepository(
            installation.account.id.toString(),
            installation.account.login,
            repo.name
          );
        }
        metrics.counter('webhook.installation_repositories.removed', repositories_removed.length);
      }
      
      return true;
    } catch (error) {
      logError(error as Error, 'Error processing installation_repositories event', {
        action,
        installation_id: installation.id,
      });
      metrics.counter('webhook.installation_repositories.error', 1);
      throw error;
    }
  }

  /**
   * Identify changed files from commits
   * @param commits Array of commits
   * @returns Array of unique changed file paths
   */
  private identifyChangedFiles(commits: GitHubPushEvent['commits']): string[] {
    const changedFiles = new Set<string>();
    
    for (const commit of commits) {
      // Add new files
      for (const file of commit.added) {
        changedFiles.add(file);
      }
      
      // Add modified files
      for (const file of commit.modified) {
        changedFiles.add(file);
      }
      
      // We don't need to process removed files for ingestion
      // but we could track them for cleanup if needed
    }
    
    return Array.from(changedFiles);
  }

  /**
   * Enqueue a job to process a repository
   * @param repoId Repository ID
   * @param userId User ID
   * @param owner Repository owner
   * @param repo Repository name
   * @param branch Branch name
   * @param isPrivate Whether the repository is private
   * @param includePatterns Glob patterns to include
   * @param excludePatterns Glob patterns to exclude
   */
  private async enqueueRepositoryJob(
    repoId: string,
    userId: string | null,
    owner: string,
    repo: string,
    branch: string,
    isPrivate: boolean,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<void> {
    await this.env.INGEST_QUEUE.send({
      type: 'repository',
      repoId,
      userId,
      provider: 'github',
      owner,
      repo,
      branch,
      isPrivate,
      includePatterns,
      excludePatterns,
    });
  }

  /**
   * Enqueue a job to process a specific file
   * @param repoId Repository ID
   * @param userId User ID
   * @param owner Repository owner
   * @param repo Repository name
   * @param branch Branch name
   * @param path File path
   * @param sha File SHA
   * @param isPrivate Whether the repository is private
   */
  private async enqueueFileJob(
    repoId: string,
    userId: string | null,
    owner: string,
    repo: string,
    branch: string,
    path: string,
    sha: string,
    isPrivate: boolean
  ): Promise<void> {
    await this.env.INGEST_QUEUE.send({
      type: 'file',
      repoId,
      userId,
      provider: 'github',
      owner,
      repo,
      branch,
      path,
      sha,
      isPrivate,
    });
  }

  /**
   * Update the last commit SHA for a repository
   * @param repoId Repository ID
   * @param commitSha Commit SHA
   */
  private async updateLastCommitSha(repoId: string, commitSha: string): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE provider_repositories
      SET lastCommitSha = ?, updatedAt = ?
      WHERE id = ?
    `)
    .bind(commitSha, Math.floor(Date.now() / 1000), repoId)
    .run();
  }

  /**
   * Store a GitHub App installation in the database
   * @param userId User ID
   * @param installationId Installation ID
   */
  private async storeInstallation(userId: string, installationId: string): Promise<void> {
    // Check if the installation already exists
    const existingInstallation = await this.env.DB.prepare(`
      SELECT id FROM provider_credentials
      WHERE provider = 'github' AND userId = ? AND installationId = ?
    `)
    .bind(userId, installationId)
    .all();
    
    if (existingInstallation.results.length > 0) {
      logger().info(
        { userId, installationId },
        'Installation already exists in database'
      );
      return;
    }
    
    // Add the installation to the database
    const now = Math.floor(Date.now() / 1000);
    await this.env.DB.prepare(`
      INSERT INTO provider_credentials (id, userId, provider, installationId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      ulid(),
      userId,
      'github',
      installationId,
      now,
      now
    )
    .run();
    
    logger().info(
      { userId, installationId },
      'Added installation to database'
    );
  }

  /**
   * Remove a GitHub App installation from the database
   * @param userId User ID
   * @param installationId Installation ID
   */
  private async removeInstallation(userId: string, installationId: string): Promise<void> {
    await this.env.DB.prepare(`
      DELETE FROM provider_credentials
      WHERE provider = 'github' AND userId = ? AND installationId = ?
    `)
    .bind(
      userId,
      installationId
    )
    .run();
    
    logger().info(
      { userId, installationId },
      'Removed installation from database'
    );
  }

  /**
   * Add a repository to the database
   * @param userId User ID
   * @param owner Repository owner
   * @param repo Repository name
   * @param isPrivate Whether the repository is private
   */
  private async addRepository(
    userId: string,
    owner: string,
    repo: string,
    isPrivate: boolean
  ): Promise<void> {
    // Check if the repository already exists
    const existingRepo = await this.env.DB.prepare(`
      SELECT id FROM provider_repositories
      WHERE provider = 'github' AND userId = ? AND owner = ? AND repo = ?
    `)
    .bind(userId, owner, repo)
    .all();
    
    if (existingRepo.results.length > 0) {
      logger().info(
        { owner, repo, userId },
        'Repository already exists in database'
      );
      return;
    }
    
    // Add the repository to the database
    const now = Math.floor(Date.now() / 1000);
    await this.env.DB.prepare(`
      INSERT INTO provider_repositories (
        id, userId, provider, owner, repo, branch, isPrivate, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      ulid(),
      userId,
      'github',
      owner,
      repo,
      'main', // Default branch
      isPrivate ? 1 : 0,
      now,
      now
    )
    .run();
    
    logger().info(
      { owner, repo, userId },
      'Added repository to database'
    );
  }

  /**
   * Remove a repository from the database
   * @param userId User ID
   * @param owner Repository owner
   * @param repo Repository name
   */
  private async removeRepository(
    userId: string,
    owner: string,
    repo: string
  ): Promise<void> {
    await this.env.DB.prepare(`
      DELETE FROM provider_repositories
      WHERE provider = 'github' AND userId = ? AND owner = ? AND repo = ?
    `)
    .bind(
      userId,
      owner,
      repo
    )
    .run();
    
    logger().info(
      { owner, repo, userId },
      'Removed repository from database'
    );
  }
}