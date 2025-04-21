import {
  BaseIngestor,
  ContentItem,
  ContentMetadata,
  IngestionOptions,
  IngestionResult,
} from '../base';
import { GitHubApiClient } from '../../github/api-client';
import { getInstallationToken, getServiceToken, getUserToken } from '../../github/auth';
import { getMimeType, isBinaryFile, shouldIncludeFile } from '../../github/content-utils';
import { logger as getLogger, logError } from '../../utils/logging';
import { metrics } from '../../utils/metrics';
import { Env } from '../../types';
import { wrap } from '../../utils/wrap';

// Define ReadableStream type to match the interface in base.ts
type ReadableStream = globalThis.ReadableStream;

/**
 * GitHub-specific ingestion options
 */
export interface GitHubIngestionOptions extends IngestionOptions {
  owner: string;
  repo: string;
  branch: string;
  lastCommitSha?: string;
  etag?: string;
  isPrivate: boolean;
}

/**
 * GitHub-specific content item
 */
export class GitHubContentItem implements ContentItem {
  public content: string = '';

  constructor(
    public metadata: ContentMetadata,
    private client: GitHubApiClient,
    private owner: string,
    private repo: string,
  ) {}

  /**
   * Get content for this item
   * @returns Content as a string or ReadableStream
   */
  async getContent(): Promise<ReadableStream | string> {
    const timer = metrics.startTimer('github_ingestor.get_content');

    try {
      // For small files, get content directly
      if (this.metadata.size < 1024 * 1024) {
        // Less than 1MB
        const response = await this.client.getBlob(this.owner, this.repo, this.metadata.sha);

        // Decode base64 content in a way that works in Cloudflare Workers
        // First, remove any whitespace from the base64 string
        const base64 = response.data.content.replace(/\s/g, '');

        // Use Cloudflare Workers' built-in base64 decoding
        const content = new TextDecoder().decode(
          Uint8Array.from(atob(base64), c => c.charCodeAt(0)),
        );
        timer.stop({ size: this.metadata.size.toString() });
        return content;
      } else {
        // For large files, stream content
        const stream = await this.client.getFileStream(this.owner, this.repo, this.metadata.sha);

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
/**
 * GitHub ingestor implementation
 * Extends the BaseIngestor to provide GitHub-specific functionality
 */
export class GitHubIngestor extends BaseIngestor {
  private client: GitHubApiClient | null = null;
  protected env: Env | null = null;
  protected options: GitHubIngestionOptions = {
    owner: '',
    repo: '',
    branch: '',
    isPrivate: false,
  };

  /**
   * Get the provider name
   */
  getProviderName(): string {
    return 'github';
  }

  /**
   * Get the provider type
   */
  getProviderType(): string {
    return 'repository';
  }

  /**
   * Initialize the ingestor with environment and options
   */
  async initialize(env: Env, options?: GitHubIngestionOptions): Promise<void> {
    await super.initialize(env, options);

    this.env = env;

    if (options) {
      this.options = {
        ...this.options,
        ...options,
      };
    }

    // Get appropriate token based on repository privacy
    let token: string;
    if (this.options.isPrivate && this.options.userId) {
      // For private repositories, use user token
      token = await getUserToken(this.options.userId, env);
    } else if (this.options.isPrivate) {
      // For private system repositories, use GitHub App installation token
      const installationId = await env.DB.prepare(
        `
        SELECT installationId
        FROM provider_credentials
        WHERE provider = 'github'
        AND userId = ?
      `,
      )
        .bind(this.options.userId || 'system')
        .first<{ installationId: string }>();

      if (!installationId) {
        throw new Error(
          `No GitHub App installation found for repository ${this.options.owner}/${this.options.repo}`,
        );
      }

      token = await getInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        installationId.installationId,
      );
    } else {
      // For public repositories, use service token
      token = getServiceToken(env);
    }

    this.client = new GitHubApiClient(token);
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
  /**
   * Create a GitHub ingestor for a repository
   * Factory method to create and initialize a GitHub ingestor
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
    env?: Env,
  ): Promise<GitHubIngestor> {
    if (!env) {
      throw new Error('Environment is required');
    }

    // Get repository configuration from database
    const repoConfig = await env.DB.prepare(
      `
      SELECT lastCommitSha, etag
      FROM provider_repositories
      WHERE id = ?
    `,
    )
      .bind(repoId)
      .first<{ lastCommitSha?: string; etag?: string }>();

    // Create ingestor and initialize it
    const ingestor = new GitHubIngestor();

    await ingestor.initialize(env, {
      userId: userId || undefined,
      owner,
      repo,
      branch,
      lastCommitSha: repoConfig?.lastCommitSha,
      etag: repoConfig?.etag,
      includePatterns,
      excludePatterns,
      isPrivate,
      id: repoId,
    });

    return ingestor;
  }

  /**
   * List all items that need to be ingested
   * @returns Array of item metadata
   */
  /**
   * Test the connection to GitHub
   */
  async testConnection(): Promise<boolean> {
    if (!this.client || !this.env) {
      throw new Error('Ingestor not initialized');
    }

    try {
      // Try to get the repository info to test the connection
      await this.client.getCommit(this.options.owner, this.options.repo, this.options.branch);
      return true;
    } catch (error) {
      getLogger().error({ error }, 'Failed to connect to GitHub');
      return false;
    }
  }

  /**
   * Check if an item has changed since last ingestion
   * @param metadata Content metadata
   * @returns Whether the item has changed
   */
  async hasChanged(metadata: ContentMetadata): Promise<boolean> {
    if (!this.client || !this.env) {
      throw new Error('Ingestor not initialized');
    }

    // If no SHA is provided, assume it has changed
    if (!metadata.sha) {
      return true;
    }

    try {
      // Check if the file exists in the database with the same SHA
      const existingContent = await this.env.DB.prepare(
        `
        SELECT sha FROM content_blobs
        WHERE id = ?
      `,
      )
        .bind(metadata.id)
        .first<{ sha: string }>();

      // If the content doesn't exist or has a different SHA, it has changed
      return !existingContent || existingContent.sha !== metadata.sha;
    } catch (error) {
      // If there's an error, assume it has changed
      getLogger().warn({ error, path: metadata.path }, 'Error checking if content has changed');
      return true;
    }
  }

  /**
   * Fetch content for an item
   * @param metadata Content metadata
   * @returns Content item
   */
  async fetchContent(metadata: ContentMetadata): Promise<ContentItem> {
    if (!this.client || !this.env) {
      throw new Error('Ingestor not initialized');
    }

    if (!metadata.path || !metadata.sha) {
      throw new Error('Missing required metadata: path or sha');
    }

    try {
      // Get the file content from GitHub
      const content = await this.client.getContent(
        this.options.owner,
        this.options.repo,
        metadata.path,
        this.options.branch,
      );

      if (!content) {
        throw new Error(`Failed to fetch content for ${metadata.path}`);
      }

      // Create a GitHubContentItem
      const contentItem = new GitHubContentItem(
        metadata,
        this.client,
        this.options.owner,
        this.options.repo,
      );

      // Set the content directly if available
      if (typeof content === 'object' && (content as any).content) {
        contentItem.content = (content as any).content;
      }

      return contentItem;
    } catch (error) {
      getLogger().error({ error, path: metadata.path }, 'Failed to fetch content');
      throw error;
    }
  }

  /**
   * Ingest content from GitHub
   */
  async ingest(options: IngestionOptions): Promise<IngestionResult> {
    return wrap(
      {
        operation: 'ingest',
        provider: this.getProviderName(),
        owner: this.options.owner,
        repo: this.options.repo,
      },
      async () => {
        if (!this.client || !this.env) {
          throw new Error('Ingestor not initialized');
        }

        const result = this.createDefaultResult();
        const startTime = performance.now();

        try {
          // List items to ingest
          const items = await this.listItems(options);
          result.itemsProcessed = items.length;

          // Process each item
          for (const item of items) {
            try {
              const contentItem = await this.ingestItem(item.id, options);
              if (contentItem) {
                result.itemsIngested++;
                result.totalSize += item.size;
              } else {
                result.itemsSkipped++;
              }
            } catch (error) {
              result.itemsFailed++;
              result.errors.push(error as Error);
              getLogger().error({ error, item }, 'Failed to ingest item');
            }
          }

          // Update metrics
          result.duration = Math.round(performance.now() - startTime);
          this.trackIngestionMetrics(result, options);

          return result;
        } catch (error) {
          result.success = false;
          result.errors.push(error as Error);
          result.duration = Math.round(performance.now() - startTime);
          this.trackIngestionMetrics(result, options);
          throw error;
        }
      },
    );
  }

  /**
   * Ingest a specific item from GitHub
   */
  async ingestItem(itemId: string, options?: IngestionOptions): Promise<ContentItem | null> {
    if (!this.client || !this.env) {
      throw new Error('Ingestor not initialized');
    }

    // Parse the item ID to get the path
    const parts = itemId.split(':');
    if (parts.length !== 2) {
      throw new Error(`Invalid item ID: ${itemId}`);
    }

    const repoId = parts[0];
    const path = parts[1];

    // Get the file content
    const content = await this.client.getContent(
      this.options.owner,
      this.options.repo,
      path,
      this.options.branch,
    );

    if (!content) {
      return null;
    }

    // Create metadata
    const metadata: ContentMetadata = {
      id: itemId,
      title: path.split('/').pop() || '',
      url: `https://github.com/${this.options.owner}/${this.options.repo}/blob/${this.options.branch}/${path}`,
      provider: this.getProviderName(),
      providerType: this.getProviderType(),
      owner: this.options.owner,
      repository: this.options.repo,
      path,
      createdAt: new Date(),
      updatedAt: new Date(),
      size: typeof content === 'object' ? (content as any).size || 0 : 0,
      contentType: getMimeType(path),
    };

    // Create a GitHubContentItem
    const contentItem = new GitHubContentItem(
      metadata,
      this.client,
      this.options.owner,
      this.options.repo,
    );

    // Set the content directly if available
    if (typeof content === 'object' && (content as any).content) {
      contentItem.content = (content as any).content;
    }

    return contentItem;
  }

  /**
   * List available items from GitHub
   */
  async listItems(options?: IngestionOptions): Promise<ContentMetadata[]> {
    if (!this.client || !this.env) {
      throw new Error('Ingestor not initialized');
    }

    const timer = metrics.startTimer('github_ingestor.list_items');

    try {
      // Get the latest commit for the branch
      const commitResponse = await this.client.getCommit(
        this.options.owner,
        this.options.repo,
        this.options.branch,
        this.options.etag,
      );

      // If we got a 304 Not Modified, return empty array
      if (!commitResponse.data) {
        getLogger().info(
          {
            owner: this.options.owner,
            repo: this.options.repo,
            branch: this.options.branch,
          },
          'Repository not modified since last sync',
        );

        timer.stop({ notModified: 'true' });
        return [];
      }

      // Store the new etag and commit SHA
      const newCommitSha = commitResponse.data.sha;
      const newEtag = commitResponse.etag;

      // If the commit hasn't changed, return empty array
      if (this.options.lastCommitSha && this.options.lastCommitSha === newCommitSha) {
        getLogger().info(
          {
            owner: this.options.owner,
            repo: this.options.repo,
            branch: this.options.branch,
            commitSha: newCommitSha,
          },
          'Repository commit unchanged since last sync',
        );

        timer.stop({ unchanged: 'true' });
        return [];
      }

      // Get the repository tree
      const treeResponse = await this.client.getTree(
        this.options.owner,
        this.options.repo,
        newCommitSha,
        true, // recursive
      );

      if (!treeResponse.data) {
        throw new Error(
          `Failed to get tree for ${this.options.owner}/${this.options.repo}@${newCommitSha}`,
        );
      }

      // Filter and map tree items to metadata
      const items: ContentMetadata[] = [];

      for (const item of treeResponse.data.tree) {
        // Skip directories
        if (item.type !== 'blob') {
          continue;
        }

        // Apply include/exclude filters
        if (!this.shouldIncludePath(item.path, options || this.options)) {
          continue;
        }

        // Skip binary files
        if (isBinaryFile(item.path)) {
          continue;
        }

        // Create metadata
        items.push({
          id: `${this.options.id}:${item.path}`,
          title: item.path.split('/').pop() || '',
          url: `https://github.com/${this.options.owner}/${this.options.repo}/blob/${this.options.branch}/${item.path}`,
          provider: this.getProviderName(),
          providerType: this.getProviderType(),
          owner: this.options.owner,
          repository: this.options.repo,
          path: item.path,
          createdAt: new Date(),
          updatedAt: new Date(),
          size: item.size || 0,
          contentType: getMimeType(item.path),
          sha: item.sha,
          commitSha: newCommitSha,
          etag: newEtag,
          repoId: this.options.id,
          userId: this.options.userId,
        });
      }

      getLogger().info(
        {
          owner: this.options.owner,
          repo: this.options.repo,
          branch: this.options.branch,
          commitSha: newCommitSha,
          itemCount: items.length,
        },
        'Listed repository items',
      );

      timer.stop({ itemCount: items.length.toString() });
      return items;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(
        error as Error,
        `Failed to list items for ${this.options.owner}/${this.options.repo}`,
      );
      throw error;
    }
  }

  /**
   * Update sync status after successful ingestion
   * Helper method to update the database with sync status
   */
  async updateSyncStatus(metadata: ContentMetadata): Promise<void> {
    if (!this.env) {
      throw new Error('Ingestor not initialized');
    }

    const now = Math.floor(Date.now() / 1000);

    // Update repository sync status
    await this.env.DB.prepare(
      `
      UPDATE provider_repositories
      SET lastSyncedAt = ?,
          lastCommitSha = ?,
          etag = ?,
          updatedAt = ?
      WHERE id = ?
    `,
    )
      .bind(now, metadata.commitSha, metadata.etag, now, this.options.id)
      .run();

    // Update or insert file metadata
    const existingFile = await this.env.DB.prepare(
      `
      SELECT id
      FROM repository_files
      WHERE repoId = ?
      AND path = ?
    `,
    )
      .bind(this.options.id, metadata.path)
      .first<{ id: string }>();

    if (existingFile) {
      // Update existing file
      await this.env.DB.prepare(
        `
        UPDATE repository_files
        SET sha = ?,
            size = ?,
            mimeType = ?,
            lastModified = ?,
            updatedAt = ?
        WHERE id = ?
      `,
      )
        .bind(metadata.sha, metadata.size, metadata.contentType, now, now, existingFile.id)
        .run();
    } else {
      // Insert new file
      await this.env.DB.prepare(
        `
        INSERT INTO repository_files (
          id, repoId, path, sha, size, mimeType, lastModified, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
        .bind(
          metadata.id,
          metadata.repoId,
          metadata.path,
          metadata.sha,
          metadata.size,
          metadata.contentType,
          now,
          now,
          now,
        )
        .run();
    }
  }
}
