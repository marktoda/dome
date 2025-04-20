import { Env } from '../types';
import { RepositoryService } from './repository-service';
import { ContentService } from './content-service';
import { QueueService } from '../queue/service';
import { GitHubIngestor } from '../ingestors/github/github-ingestor';
import { Ingestor } from '../ingestors/base';

/**
 * Service Factory for creating and initializing services
 */
export class ServiceFactory {
  private env: Env;
  private repositoryService: RepositoryService | null = null;
  private contentService: ContentService | null = null;
  private queueService: QueueService | null = null;

  /**
   * Create a new service factory
   * @param env Environment
   */
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get the repository service
   * @returns Repository service instance
   */
  getRepositoryService(): RepositoryService {
    if (!this.repositoryService) {
      this.repositoryService = new RepositoryService(this.env);
    }
    return this.repositoryService;
  }

  /**
   * Get the content service
   * @returns Content service instance
   */
  getContentService(): ContentService {
    if (!this.contentService) {
      this.contentService = new ContentService(this.env);
    }
    return this.contentService;
  }

  /**
   * Get the queue service
   * @returns Queue service instance
   */
  getQueueService(): QueueService {
    if (!this.queueService) {
      this.queueService = new QueueService(this.env);
    }
    return this.queueService;
  }

  /**
   * Create an ingestor for a repository
   * @param repoId Repository ID
   * @param userId User ID
   * @param provider Provider (e.g., 'github')
   * @param owner Repository owner
   * @param repo Repository name
   * @param branch Repository branch
   * @param isPrivate Whether the repository is private
   * @param includePatterns Include patterns
   * @param excludePatterns Exclude patterns
   * @returns Ingestor instance
   */
  async createIngestor(
    repoId: string,
    userId: string | null,
    provider: string,
    owner: string,
    repo: string,
    branch: string = 'main',
    isPrivate: boolean = false,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<Ingestor> {
    switch (provider) {
      case 'github':
        return GitHubIngestor.forRepository(
          repoId,
          userId,
          owner,
          repo,
          branch,
          isPrivate,
          includePatterns,
          excludePatterns,
          this.env
        );
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Create an ingestor from a repository configuration
   * @param repoId Repository ID
   * @returns Ingestor instance
   */
  async createIngestorFromRepository(repoId: string): Promise<Ingestor> {
    const repoService = this.getRepositoryService();
    const repo = await repoService.getRepository(repoId);
    
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    
    return this.createIngestor(
      repoId,
      repo.userId,
      repo.provider,
      repo.owner,
      repo.repo,
      repo.branch,
      repo.isPrivate,
      repo.includePatterns,
      repo.excludePatterns
    );
  }
}