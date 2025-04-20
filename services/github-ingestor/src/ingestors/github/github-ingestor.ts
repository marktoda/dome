import { BaseIngestor, ContentItem, IngestorConfig, ItemMetadata } from '../base';
import { GitHubApiClient } from '../../github/api-client';
import { getInstallationToken, getServiceToken, getUserToken } from '../../github/auth';
import { calculateSha1, generateR2Key, getMimeType, isBinaryFile, shouldIncludeFile } from '../../github/content-utils';
import { logger, logError } from '../../utils/logging';
import { metrics } from '../../utils/metrics';
import { Env } from '../../types';

// Define ReadableStream type to match the interface in base.ts
type ReadableStream = globalThis.ReadableStream;

/**
 * GitHub-specific ingestor configuration
 */
export interface GitHubIngestorConfig extends IngestorConfig {
  owner: string;
  repo: string;
  branch: string;
  lastCommitSha?: string;
  etag?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  isPrivate: boolean;
}

/**
 * GitHub-specific content item
 */
export class GitHubContentItem implements ContentItem {
  constructor(
    public metadata: ItemMetadata,
    private client: GitHubApiClient,
    private owner: string,
    private repo: string
  ) {}

  /**
   * Get content for this item
   * @returns Content as a string or ReadableStream
   */
  async getContent(): Promise<ReadableStream | string> {
    const timer = metrics.startTimer('github_ingestor.get_content');
    
    try {
      // For small files, get content directly
      if (this.metadata.size < 1024 * 1024) { // Less than 1MB
        const response = await this.client.getBlob(
          this.owner,
          this.repo,
          this.metadata.sha
        );
        
        // Decode base64 content in a way that works in Cloudflare Workers
        // First, remove any whitespace from the base64 string
        const base64 = response.data.content.replace(/\s/g, '');
        
        // Use Cloudflare Workers' built-in base64 decoding
        const content = new TextDecoder().decode(
          Uint8Array.from(atob(base64), c => c.charCodeAt(0))
        );
        timer.stop({ size: this.metadata.size.toString() });
        return content;
      } else {
        // For large files, stream content
        const stream = await this.client.getFileStream(
          this.owner,
          this.repo,
          this.metadata.sha
        );
        
        timer.stop({ size: this.metadata.size.toString() });
        return stream;
      }
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get content for ${this.metadata.path}`);
      throw error;
    }
  }
}

/**
 * GitHub ingestor implementation
 */
export class GitHubIngestor extends BaseIngestor {
  private client: GitHubApiClient;
  private env: Env;
  
  /**
   * Create a new GitHub ingestor
   * @param config Ingestor configuration
   * @param token GitHub API token
   * @param env Environment
   */
  constructor(
    config: GitHubIngestorConfig,
    token: string,
    env: Env
  ) {
    super(config);
    this.client = new GitHubApiClient(token);
    this.env = env;
  }

  /**
   * Create a GitHub ingestor for a repository
   * @param repoId Repository ID
   * @param userId User ID (null for system repositories)
   * @param owner Repository owner
   * @param repo Repository name
   * @param branch Repository branch
   * @param isPrivate Whether the repository is private
   * @param includePatterns Include patterns
   * @param excludePatterns Exclude patterns
   * @param env Environment
   * @returns GitHub ingestor
   */
  static async forRepository(
    repoId: string,
    userId: string | null,
    owner: string,
    repo: string,
    branch: string,
    isPrivate: boolean,
    includePatterns?: string[],
    excludePatterns?: string[],
    env?: Env
  ): Promise<GitHubIngestor> {
    if (!env) {
      throw new Error('Environment is required');
    }

    // Get repository configuration from database
    const repoConfig = await env.DB.prepare(`
      SELECT lastCommitSha, etag
      FROM provider_repositories
      WHERE id = ?
    `)
    .bind(repoId)
    .first<{ lastCommitSha?: string; etag?: string }>();

    // Create ingestor configuration
    const config: GitHubIngestorConfig = {
      id: repoId,
      userId,
      provider: 'github',
      owner,
      repo,
      branch,
      lastCommitSha: repoConfig?.lastCommitSha,
      etag: repoConfig?.etag,
      includePatterns,
      excludePatterns,
      isPrivate
    };

    // Get appropriate token based on repository privacy
    let token: string;
    if (isPrivate && userId) {
      // For private repositories, use user token
      token = await getUserToken(userId, env);
    } else if (isPrivate) {
      // For private system repositories, use GitHub App installation token
      const installationId = await env.DB.prepare(`
        SELECT installationId
        FROM provider_credentials
        WHERE provider = 'github'
        AND userId = ?
      `)
      .bind(userId || 'system')
      .first<{ installationId: string }>();

      if (!installationId) {
        throw new Error(`No GitHub App installation found for repository ${owner}/${repo}`);
      }

      token = await getInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        installationId.installationId
      );
    } else {
      // For public repositories, use service token
      token = getServiceToken(env);
    }

    return new GitHubIngestor(config, token, env);
  }

  /**
   * Get configuration for this ingestor
   */
  getConfig(): GitHubIngestorConfig {
    return this.config as GitHubIngestorConfig;
  }

  /**
   * List all items that need to be ingested
   * @returns Array of item metadata
   */
  async listItems(): Promise<ItemMetadata[]> {
    const timer = metrics.startTimer('github_ingestor.list_items');
    const config = this.getConfig();
    
    try {
      // Get the latest commit for the branch
      const commitResponse = await this.client.getCommit(
        config.owner,
        config.repo,
        config.branch,
        config.etag
      );
      
      // If we got a 304 Not Modified, return empty array
      if (!commitResponse.data) {
        logger.info({
          owner: config.owner,
          repo: config.repo,
          branch: config.branch
        }, 'Repository not modified since last sync');
        
        timer.stop({ notModified: 'true' });
        return [];
      }
      
      // Store the new etag and commit SHA
      const newCommitSha = commitResponse.data.sha;
      const newEtag = commitResponse.etag;
      
      // If the commit hasn't changed, return empty array
      if (config.lastCommitSha && config.lastCommitSha === newCommitSha) {
        logger.info({
          owner: config.owner,
          repo: config.repo,
          branch: config.branch,
          commitSha: newCommitSha
        }, 'Repository commit unchanged since last sync');
        
        timer.stop({ unchanged: 'true' });
        return [];
      }
      
      // Get the repository tree
      const treeResponse = await this.client.getTree(
        config.owner,
        config.repo,
        newCommitSha,
        true // recursive
      );
      
      if (!treeResponse.data) {
        throw new Error(`Failed to get tree for ${config.owner}/${config.repo}@${newCommitSha}`);
      }
      
      // Filter and map tree items to metadata
      const items: ItemMetadata[] = [];
      
      for (const item of treeResponse.data.tree) {
        // Skip directories
        if (item.type !== 'blob') {
          continue;
        }
        
        // Apply include/exclude filters
        if (!shouldIncludeFile(item.path, config.includePatterns, config.excludePatterns)) {
          continue;
        }
        
        // Skip binary files
        if (isBinaryFile(item.path)) {
          continue;
        }
        
        // Create metadata
        items.push({
          id: `${config.id}:${item.path}`,
          path: item.path,
          sha: item.sha,
          size: item.size || 0,
          mimeType: getMimeType(item.path),
          provider: 'github',
          repoId: config.id,
          userId: config.userId,
          commitSha: newCommitSha,
          etag: newEtag,
          owner: config.owner,
          repo: config.repo
        });
      }
      
      logger.info({
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        commitSha: newCommitSha,
        itemCount: items.length
      }, 'Listed repository items');
      
      timer.stop({ itemCount: items.length.toString() });
      return items;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to list items for ${config.owner}/${config.repo}`);
      throw error;
    }
  }

  /**
   * Get content for a specific item
   * @param metadata Item metadata
   * @returns Content item
   */
  async fetchContent(metadata: ItemMetadata): Promise<ContentItem> {
    const config = this.getConfig();
    
    return new GitHubContentItem(
      metadata,
      this.client,
      config.owner,
      config.repo
    );
  }

  /**
   * Check if an item has changed since last sync
   * @param metadata Item metadata
   * @returns Whether the item has changed
   */
  async hasChanged(metadata: ItemMetadata): Promise<boolean> {
    // Check if the file exists in the database with the same SHA
    const existingFile = await this.env.DB.prepare(`
      SELECT sha
      FROM repository_files
      WHERE repoId = ?
      AND path = ?
    `)
    .bind(metadata.repoId, metadata.path)
    .first<{ sha: string }>();
    
    // If the file doesn't exist or the SHA has changed, it has changed
    return !existingFile || existingFile.sha !== metadata.sha;
  }

  /**
   * Update sync status after successful ingestion
   * @param metadata Item metadata
   */
  async updateSyncStatus(metadata: ItemMetadata): Promise<void> {
    const config = this.getConfig();
    const now = Math.floor(Date.now() / 1000);
    
    // Update repository sync status
    await this.env.DB.prepare(`
      UPDATE provider_repositories
      SET lastSyncedAt = ?,
          lastCommitSha = ?,
          etag = ?,
          updatedAt = ?
      WHERE id = ?
    `)
    .bind(
      now,
      metadata.commitSha,
      metadata.etag,
      now,
      config.id
    )
    .run();
    
    // Update or insert file metadata
    const existingFile = await this.env.DB.prepare(`
      SELECT id
      FROM repository_files
      WHERE repoId = ?
      AND path = ?
    `)
    .bind(config.id, metadata.path)
    .first<{ id: string }>();
    
    if (existingFile) {
      // Update existing file
      await this.env.DB.prepare(`
        UPDATE repository_files
        SET sha = ?,
            size = ?,
            mimeType = ?,
            lastModified = ?,
            updatedAt = ?
        WHERE id = ?
      `)
      .bind(
        metadata.sha,
        metadata.size,
        metadata.mimeType,
        now,
        now,
        existingFile.id
      )
      .run();
    } else {
      // Insert new file
      await this.env.DB.prepare(`
        INSERT INTO repository_files (
          id, repoId, path, sha, size, mimeType, lastModified, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        metadata.id,
        metadata.repoId,
        metadata.path,
        metadata.sha,
        metadata.size,
        metadata.mimeType,
        now,
        now,
        now
      )
      .run();
    }
  }
}