import { Octokit } from '@octokit/rest';
import { App } from '@octokit/app';
import { initPolyfills } from '../utils/polyfills';

// Initialize polyfills
initPolyfills();
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { GitHubContent, GitHubTree, GitHubCommit } from '../types';

/**
 * Configuration for the GitHub API client
 */
export interface GitHubClientConfig {
  /**
   * Base URL for GitHub API (defaults to https://api.github.com)
   */
  baseUrl?: string;
  
  /**
   * User agent to use for requests
   */
  userAgent?: string;
  
  /**
   * Maximum number of retries for failed requests
   */
  maxRetries?: number;
  
  /**
   * Whether to enable request logging
   */
  debug?: boolean;
}

/**
 * Error thrown by the GitHub API client
 */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly resource?: string,
    public readonly isRateLimitError: boolean = false,
    public readonly isTransient: boolean = false
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * Response with rate limit information
 */
export interface RateLimitedResponse<T> {
  data: T;
  rateLimit: {
    limit: number;
    remaining: number;
    reset: number;
    used: number;
  };
  etag?: string;
}

/**
 * GitHub API client with rate limiting and conditional request support
 */
export class GitHubApiClient {
  private octokit: Octokit;
  private readonly config: Required<GitHubClientConfig>;
  private readonly defaultConfig: Required<GitHubClientConfig> = {
    baseUrl: 'https://api.github.com',
    userAgent: 'dome-github-ingestor',
    maxRetries: 3,
    debug: false,
  };

  /**
   * Create a new GitHub API client
   * @param token GitHub access token
   * @param config Client configuration
   */
  constructor(private token: string, config: GitHubClientConfig = {}) {
    this.config = { ...this.defaultConfig, ...config };
    
    this.octokit = new Octokit({
      auth: token,
      baseUrl: this.config.baseUrl,
      userAgent: this.config.userAgent,
      log: this.config.debug ? console : undefined,
      request: {
        retries: this.config.maxRetries,
      },
    });

    // Add response hooks for rate limit tracking
    this.octokit.hook.after('request', (response: any, options: any) => {
      this.trackRateLimit(response);
    });

    // Add error hooks for error classification
    this.octokit.hook.error('request', (error: any, options: any) => {
      return this.handleRequestError(error, options);
    });
  }

  /**
   * Create a GitHub API client for a GitHub App installation
   * @param appId GitHub App ID
   * @param privateKey GitHub App private key
   * @param installationId GitHub App installation ID
   * @param config Client configuration
   * @returns GitHub API client
   */
  static async forInstallation(
    appId: string,
    privateKey: string,
    installationId: string,
    config: GitHubClientConfig = {}
  ): Promise<GitHubApiClient> {
    const app = new App({
      appId,
      privateKey,
    });

    try {
      const installationOctokit = await app.getInstallationOctokit(Number(installationId));
      
      interface AuthToken {
        token: string;
        type: string;
      }
      
      const token = await installationOctokit.auth({
        type: 'installation',
      }) as AuthToken;

      return new GitHubApiClient(token.token, config);
    } catch (error) {
      logError(error as Error, 'Failed to create GitHub API client for installation');
      throw new GitHubApiError(
        `Failed to authenticate with GitHub App installation: ${(error as Error).message}`,
        401,
        'installation_auth_failed',
        undefined,
        false,
        true
      );
    }
  }

  /**
   * Get repository details
   * @param owner Repository owner
   * @param repo Repository name
   * @param etag Optional ETag for conditional request
   * @returns Repository details with rate limit information
   */
  async getRepository(
    owner: string,
    repo: string,
    etag?: string
  ): Promise<RateLimitedResponse<any>> {
    const timer = metrics.startTimer('github_api.get_repository');
    const headers: Record<string, string> = {};
    
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const response = await this.octokit.repos.get({
        owner,
        repo,
        headers,
      });

      metrics.trackOperation('github_api.get_repository', true, { owner, repo });
      timer.stop({ owner, repo });

      return {
        data: response.data,
        rateLimit: this.extractRateLimit(response),
        etag: response.headers.etag as string,
      };
    } catch (error) {
      metrics.trackOperation('github_api.get_repository', false, { owner, repo });
      timer.stop({ owner, repo });
      
      // If it's a 304 Not Modified, return the cached data
      if ((error as any).status === 304) {
        return {
          data: null,
          rateLimit: this.extractRateLimit(error as any),
          etag,
        };
      }
      
      throw this.normalizeError(error, 'repos.get', { owner, repo });
    }
  }

  /**
   * Get a specific commit
   * @param owner Repository owner
   * @param repo Repository name
   * @param ref Commit reference (SHA, branch, or tag)
   * @param etag Optional ETag for conditional request
   * @returns Commit details with rate limit information
   */
  async getCommit(
    owner: string,
    repo: string,
    ref: string,
    etag?: string
  ): Promise<RateLimitedResponse<GitHubCommit>> {
    const timer = metrics.startTimer('github_api.get_commit');
    const headers: Record<string, string> = {};
    
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const response = await this.octokit.repos.getCommit({
        owner,
        repo,
        ref,
        headers,
      });

      metrics.trackOperation('github_api.get_commit', true, { owner, repo });
      timer.stop({ owner, repo });

      return {
        data: response.data as GitHubCommit,
        rateLimit: this.extractRateLimit(response),
        etag: response.headers.etag as string,
      };
    } catch (error) {
      metrics.trackOperation('github_api.get_commit', false, { owner, repo });
      timer.stop({ owner, repo });
      
      // If it's a 304 Not Modified, return the cached data
      if ((error as any).status === 304) {
        return {
          data: null as any,
          rateLimit: this.extractRateLimit(error as any),
          etag,
        };
      }
      
      throw this.normalizeError(error, 'repos.getCommit', { owner, repo, ref });
    }
  }

  /**
   * Get repository tree (directory structure)
   * @param owner Repository owner
   * @param repo Repository name
   * @param sha Tree SHA (commit, branch, or tag)
   * @param recursive Whether to get the tree recursively
   * @param etag Optional ETag for conditional request
   * @returns Repository tree with rate limit information
   */
  async getTree(
    owner: string,
    repo: string,
    sha: string,
    recursive: boolean = true,
    etag?: string
  ): Promise<RateLimitedResponse<GitHubTree>> {
    const timer = metrics.startTimer('github_api.get_tree');
    const headers: Record<string, string> = {};
    
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const response = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: sha,
        recursive: recursive ? '1' : undefined,
        headers,
      });

      metrics.trackOperation('github_api.get_tree', true, { owner, repo });
      timer.stop({ owner, repo });

      return {
        data: response.data as GitHubTree,
        rateLimit: this.extractRateLimit(response),
        etag: response.headers.etag as string,
      };
    } catch (error) {
      metrics.trackOperation('github_api.get_tree', false, { owner, repo });
      timer.stop({ owner, repo });
      
      // If it's a 304 Not Modified, return the cached data
      if ((error as any).status === 304) {
        return {
          data: null as any,
          rateLimit: this.extractRateLimit(error as any),
          etag,
        };
      }
      
      throw this.normalizeError(error, 'git.getTree', { owner, repo, sha });
    }
  }

  /**
   * Get file content
   * @param owner Repository owner
   * @param repo Repository name
   * @param path File path
   * @param ref Reference (commit SHA, branch, or tag)
   * @param etag Optional ETag for conditional request
   * @returns File content with rate limit information
   */
  async getContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
    etag?: string
  ): Promise<RateLimitedResponse<GitHubContent>> {
    const timer = metrics.startTimer('github_api.get_content');
    const headers: Record<string, string> = {};
    
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
        headers,
      });

      metrics.trackOperation('github_api.get_content', true, { owner, repo });
      timer.stop({ owner, repo, path });

      return {
        data: response.data as GitHubContent,
        rateLimit: this.extractRateLimit(response),
        etag: response.headers.etag as string,
      };
    } catch (error) {
      metrics.trackOperation('github_api.get_content', false, { owner, repo });
      timer.stop({ owner, repo, path });
      
      // If it's a 304 Not Modified, return the cached data
      if ((error as any).status === 304) {
        return {
          data: null as any,
          rateLimit: this.extractRateLimit(error as any),
          etag,
        };
      }
      
      throw this.normalizeError(error, 'repos.getContent', { owner, repo, path });
    }
  }

  /**
   * Get file content as a blob
   * @param owner Repository owner
   * @param repo Repository name
   * @param sha Blob SHA
   * @returns Blob content with rate limit information
   */
  async getBlob(
    owner: string,
    repo: string,
    sha: string
  ): Promise<RateLimitedResponse<{ content: string; encoding: string }>> {
    const timer = metrics.startTimer('github_api.get_blob');

    try {
      const response = await this.octokit.git.getBlob({
        owner,
        repo,
        file_sha: sha,
      });

      metrics.trackOperation('github_api.get_blob', true, { owner, repo });
      timer.stop({ owner, repo });

      return {
        data: {
          content: response.data.content,
          encoding: response.data.encoding,
        },
        rateLimit: this.extractRateLimit(response),
      };
    } catch (error) {
      metrics.trackOperation('github_api.get_blob', false, { owner, repo });
      timer.stop({ owner, repo });
      
      throw this.normalizeError(error, 'git.getBlob', { owner, repo, sha });
    }
  }

  /**
   * Compare two commits to get the difference
   * @param owner Repository owner
   * @param repo Repository name
   * @param base Base commit reference
   * @param head Head commit reference
   * @returns Comparison result with rate limit information
   */
  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<RateLimitedResponse<any>> {
    const timer = metrics.startTimer('github_api.compare_commits');

    try {
      const response = await this.octokit.repos.compareCommits({
        owner,
        repo,
        base,
        head,
      });

      metrics.trackOperation('github_api.compare_commits', true, { owner, repo });
      timer.stop({ owner, repo });

      return {
        data: response.data,
        rateLimit: this.extractRateLimit(response),
      };
    } catch (error) {
      metrics.trackOperation('github_api.compare_commits', false, { owner, repo });
      timer.stop({ owner, repo });
      
      throw this.normalizeError(error, 'repos.compareCommits', { owner, repo, base, head });
    }
  }

  /**
   * Get raw file content as a stream
   * @param owner Repository owner
   * @param repo Repository name
   * @param sha Blob SHA
   * @returns ReadableStream of file content
   */
  async getFileStream(
    owner: string,
    repo: string,
    sha: string
  ): Promise<globalThis.ReadableStream> {
    const timer = metrics.startTimer('github_api.get_file_stream');

    try {
      // First get the blob URL
      const blob = await this.octokit.git.getBlob({
        owner,
        repo,
        file_sha: sha,
      });

      // Then fetch the raw content as a stream
      const response = await globalThis.fetch(blob.data.url, {
        headers: {
          Accept: 'application/vnd.github.raw',
          Authorization: `token ${this.token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get file stream: ${response.status} ${response.statusText}`);
      }

      metrics.trackOperation('github_api.get_file_stream', true, { owner, repo });
      timer.stop({ owner, repo });

      return response.body as globalThis.ReadableStream;
    } catch (error) {
      metrics.trackOperation('github_api.get_file_stream', false, { owner, repo });
      timer.stop({ owner, repo });
      
      throw this.normalizeError(error, 'getFileStream', { owner, repo, sha });
    }
  }

  /**
   * Extract rate limit information from a response
   * @param response API response
   * @returns Rate limit information
   */
  private extractRateLimit(response: any): { limit: number; remaining: number; reset: number; used: number } {
    const headers = response.headers || {};
    
    const limit = parseInt(headers['x-ratelimit-limit'] || '0', 10);
    const remaining = parseInt(headers['x-ratelimit-remaining'] || '0', 10);
    const reset = parseInt(headers['x-ratelimit-reset'] || '0', 10);
    const used = parseInt(headers['x-ratelimit-used'] || '0', 10);
    
    // Track rate limit metrics
    metrics.trackRateLimit(remaining, limit, reset);
    
    return { limit, remaining, reset, used };
  }

  /**
   * Track rate limit information from a response
   * @param response API response
   */
  private trackRateLimit(response: any): void {
    const rateLimit = this.extractRateLimit(response);
    
    // Log rate limit if it's getting low
    if (rateLimit.remaining < rateLimit.limit * 0.1) {
      logger.warn({
        rateLimit,
        resetIn: rateLimit.reset - Math.floor(Date.now() / 1000),
      }, 'GitHub API rate limit is getting low');
    }
  }

  /**
   * Handle request errors
   * @param error Error from Octokit
   * @param options Request options
   * @returns Normalized error
   */
  private handleRequestError(error: any, options: any): Error {
    const normalizedError = this.normalizeError(error, options.method, options.url);
    
    // If it's a rate limit error, log it
    if (normalizedError instanceof GitHubApiError && normalizedError.isRateLimitError) {
      logger.warn({
        error: normalizedError,
        method: options.method,
        url: options.url,
      }, 'GitHub API rate limit exceeded');
    }
    
    return normalizedError;
  }

  /**
   * Normalize an error from the GitHub API
   * @param error Error from Octokit
   * @param method API method that was called
   * @param context Additional context
   * @returns Normalized error
   */
  private normalizeError(error: any, method: string, context: Record<string, any>): Error {
    // If it's already a GitHubApiError, return it
    if (error instanceof GitHubApiError) {
      return error;
    }
    
    const status = error.status || 500;
    const message = error.message || 'Unknown GitHub API error';
    const resource = context.url || `${context.owner}/${context.repo}`;
    
    // Check if it's a rate limit error
    const isRateLimitError = status === 403 && 
      (message.includes('rate limit') || message.includes('API rate limit'));
    
    // Check if it's a transient error
    const isTransient = status >= 500 || status === 429 || isRateLimitError;
    
    // Get error code if available
    const code = error.response?.data?.error || 
                error.response?.data?.message || 
                `github_${method.replace(/\./g, '_')}_error`;
    
    return new GitHubApiError(
      message,
      status,
      code,
      resource,
      isRateLimitError,
      isTransient
    );
  }
}