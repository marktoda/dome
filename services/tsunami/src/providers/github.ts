/**
 * GitHub Provider Module
 *
 * This module implements the GitHub provider for the Tsunami service.
 * It fetches content from GitHub repositories and converts it to a format
 * suitable for storage in Silo.
 *
 * @module providers/github
 */

import { SiloSimplePutInput, ContentCategory, MimeType } from '@dome/common';
import { Provider, PullOpts, PullResult } from '.';
import { getLogger, metrics } from '@dome/logging';
import { Bindings } from '../types';

/**
 * GitHub API constants
 */
const GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github.v3+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Tsunami-Service/1.0.0 (+https://github.com/dome/tsunami)',
};
/** Maximum file size to process (1MB) */
const MAX_FILE_SIZE = 1 * 1024 * 1024;

/**
 * File extensions to MIME type mapping
 * Maps common file extensions to their corresponding MIME types
 */
const MIME_TYPE_MAP: Record<string, MimeType> = {
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.jsx': 'application/javascript',
  '.tsx': 'application/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.py': 'application/python',
  '.txt': 'text/plain',
};

/** Default MIME type for unknown extensions */
const DEFAULT_MIME_TYPE: MimeType = 'text/plain';

/**
 * GitHub Commit information
 * @interface GitHubCommit
 */
interface GitHubCommit {
  /** Commit SHA */
  sha: string;
  /** Commit details */
  commit: {
    /** Commit message */
    message: string;
    /** Author information */
    author: {
      /** Author name */
      name: string;
      /** Author email */
      email: string;
      /** Commit date */
      date: string;
    };
  };
  /** HTML URL to view the commit */
  html_url: string;
}

/**
 * GitHub File information
 * @interface GitHubFile
 */
interface GitHubFile {
  /** File SHA */
  sha: string;
  /** File path */
  filename: string;
  /** File status (added, modified, removed) */
  status: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
  /** Total number of changes */
  changes: number;
  /** URL to view the file */
  blob_url: string;
  /** URL to download the raw file */
  raw_url: string;
  /** URL to get file contents */
  contents_url: string;
  /** Diff patch */
  patch?: string;
}

/**
 * GitHub Content information
 * @interface GitHubContent
 */
interface GitHubContent {
  /** File name */
  name: string;
  /** File path */
  path: string;
  /** Content SHA */
  sha: string;
  /** File size in bytes */
  size: number;
  /** API URL */
  url: string;
  /** HTML URL to view the content */
  html_url: string;
  /** Git URL */
  git_url: string;
  /** URL to download the raw content */
  download_url: string;
  /** Content type (file, dir) */
  type: string;
  /** File content (base64 encoded) */
  content?: string;
  /** Content encoding */
  encoding?: string;
}

/**
 * GitHub Provider
 *
 * Implements the Provider interface for GitHub repositories.
 * Fetches content from GitHub repositories and converts it to a format
 * suitable for storage in Silo.
 *
 * @class
 * @implements {Provider}
 */
export class GithubProvider implements Provider {
  private logger = getLogger();
  private token: string;

  constructor(private env: Bindings) {
    // Get GitHub token from environment
    this.token = (this.env as any).GITHUB_TOKEN || '';
  }

  /**
   * Helper method to fetch data from GitHub API with proper headers and rate limit handling
   *
   * @param url - GitHub API URL to fetch from
   * @returns Promise with the response data
   * @throws Error if the API request fails
   * @private
   */
  private async fetchFromGitHub<T>(url: string): Promise<T> {
    // Create headers with or without authentication
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }

    this.logger.info({ url }, 'Fetching from GitHub API');
    const response = await fetch(url, { headers });

    // Check for rate limiting
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    const rateLimitReset = response.headers.get('x-ratelimit-reset');

    if (rateLimitRemaining) {
      this.logger.info(
        {
          url,
          rateLimitRemaining,
          rateLimitReset,
          authenticated: !!this.token,
        },
        'GitHub API rate limit info',
      );
    }

    // Clone the response before reading it to avoid "Body has already been used" errors
    const responseClone = response.clone();

    if (!response.ok) {
      // Get the response body for error logging
      const responseBody = await responseClone.text();
      getLogger().error({ status: response.status, responseBody }, 'GitHub API request failed');

      // Handle specific error cases
      if (response.status === 403) {
        const resetTime = rateLimitReset
          ? new Date(parseInt(rateLimitReset) * 1000).toISOString()
          : 'unknown';

        if (rateLimitRemaining === '0') {
          throw new Error(
            `GitHub API rate limit exceeded. Resets at ${resetTime}. Consider adding a GitHub token.`,
          );
        } else {
          // Could be other 403 reasons
          throw new Error(`GitHub API access forbidden (403): ${responseBody}`);
        }
      }

      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error({ url, error }, 'Failed to parse JSON response from GitHub API');
      throw new Error(
        `Failed to parse GitHub API response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Pull incremental changes to the repository since `cursor`
   *
   * Fetches commits and file changes from a GitHub repository since the
   * specified cursor (commit SHA) and converts them to SiloSimplePutInput
   * objects for storage in Silo.
   *
   * @param opts - Pull options including userId, resourceId, and cursor
   * @returns Array of SiloSimplePutInput objects
   * @throws Error if the pull operation fails
   */
  async pull(opts: PullOpts): Promise<PullResult> {
    const { userId, resourceId, cursor } = opts;
    const startTime = Date.now();

    try {
      this.logger.info({ userId, resourceId, cursor }, 'Starting GitHub pull');

      // Parse resourceId (expected format: owner/repo)
      const [owner, repo] = resourceId.split('/');
      if (!owner || !repo) {
        throw new Error(`Invalid resourceId format: ${resourceId}. Expected format: owner/repo`);
      }

      // Log whether we're using authentication or not
      if (!this.token) {
        this.logger.warn(
          { resourceId },
          'No GitHub token found, making unauthenticated requests (subject to lower rate limits: 60 req/hr vs 5000 req/hr)',
        );
      } else {
        this.logger.info(
          { resourceId },
          'Using GitHub token for authentication (5000 req/hr rate limit)',
        );
      }

      // Fetch commits since cursor
      const commits = await this.fetchCommitsSinceCursor(owner, repo, cursor);
      if (commits.length === 0) {
        this.logger.info({ resourceId }, 'No new commits found');
        return { contents: [], newCursor: null };
      }

      this.logger.info({ resourceId, commitCount: commits.length }, 'Found new commits');

      // Get changed files from each commit
      const results: SiloSimplePutInput[] = [];
      // Track processed files to avoid duplicates (same file changed in multiple commits)
      const processedFiles = new Set<string>();

      for (const commit of commits) {
        const files = await this.fetchFilesFromCommit(owner, repo, commit.sha);

        for (const file of files) {
          // Skip files that are too large or deleted
          if (file.status === 'removed' || file.changes > MAX_FILE_SIZE) {
            continue;
          }

          // Skip already processed files (from newer commits)
          if (processedFiles.has(file.filename)) {
            continue;
          }
          processedFiles.add(file.filename);

          // Fetch file content
          const content = await this.fetchFileContent(owner, repo, file.filename, commit.sha);
          if (!content) {
            continue;
          }

          // Determine MIME type based on file extension
          const fileExt = file.filename.substring(file.filename.lastIndexOf('.'));
          const mimeType = MIME_TYPE_MAP[fileExt] || DEFAULT_MIME_TYPE;

          // Create SiloSimplePutInput
          results.push({
            content: content,
            category: 'code' as ContentCategory,
            mimeType: mimeType,
            userId: userId,
            metadata: {
              repository: resourceId,
              path: file.filename,
              commitSha: commit.sha,
              commitMessage: commit.commit.message,
              author: commit.commit.author.name,
              authorEmail: commit.commit.author.email,
              commitDate: commit.commit.author.date,
              htmlUrl: `https://github.com/${owner}/${repo}/blob/${commit.sha}/${file.filename}`,
            },
          });
        }
      }

      // Track metrics
      metrics.timing('github.pull.latency_ms', Date.now() - startTime);
      metrics.increment('github.pull.files_processed', results.length);

      this.logger.info({ resourceId, fileCount: results.length }, 'GitHub pull completed');

      // Return the latest commit SHA as the new cursor
      const newCursor = commits[0].sha;
      this.logger.info({ resourceId, newCursor }, 'New cursor for next pull');

      return { contents: results, newCursor };
    } catch (error) {
      metrics.increment('github.pull.errors', 1);
      this.logger.error({ error, userId, resourceId }, 'Error pulling from GitHub');
      throw error;
    }
  }

  /**
   * Fetch commits from a repository since a specific cursor (commit SHA)
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param cursor - Commit SHA to fetch commits since (null for latest commit only)
   * @returns Array of GitHub commits
   * @throws Error if the API request fails
   * @private
   */
  private async fetchCommitsSinceCursor(
    owner: string,
    repo: string,
    cursor: string | null,
  ): Promise<GitHubCommit[]> {
    // If no cursor is provided, fetch a reasonable number of recent commits
    // to index a substantial portion of the repository on first run
    if (!cursor) {
      const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits?per_page=50`;
      const commits = await this.fetchFromGitHub<GitHubCommit[]>(url);
      this.logger.info(
        { owner, repo, commitCount: commits.length },
        'Fetched initial commits for repository indexing',
      );
      return commits;
    }

    // For subsequent runs, we need to get all commits and filter those newer than the cursor
    // First, get the cursor commit to find its date
    try {
      const cursorCommitUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits/${cursor}`;
      const cursorCommit = await this.fetchFromGitHub<GitHubCommit>(cursorCommitUrl);
      const cursorDate = new Date(cursorCommit.commit.author.date);

      // Now fetch commits since that date
      const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits?sha=HEAD&since=${cursorDate.toISOString()}`;
      const commits = await this.fetchFromGitHub<GitHubCommit[]>(url);

      // Filter out the cursor commit itself (we only want newer commits)
      const filteredCommits = commits.filter(commit => commit.sha !== cursor);

      this.logger.info(
        {
          owner,
          repo,
          commitCount: filteredCommits.length,
          cursor,
          cursorDate: cursorDate.toISOString(),
        },
        'Fetched incremental commits since cursor',
      );
      return filteredCommits;
    } catch (error) {
      this.logger.warn(
        { owner, repo, cursor, error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch cursor commit, falling back to recent commits',
      );

      // If we can't get the cursor commit (it might have been force-pushed away),
      // fall back to fetching recent commits
      const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits?per_page=10`;
      const commits = await this.fetchFromGitHub<GitHubCommit[]>(url);
      return commits;
    }
  }

  /**
   * Fetch files changed in a specific commit
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param commitSha - Commit SHA
   * @returns Array of GitHub files
   * @throws Error if the API request fails
   * @private
   */
  private async fetchFilesFromCommit(
    owner: string,
    repo: string,
    commitSha: string,
  ): Promise<GitHubFile[]> {
    const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits/${commitSha}`;
    const commitData = await this.fetchFromGitHub<{ files?: GitHubFile[] }>(url);
    const files = commitData.files || [];
    this.logger.info(
      { owner, repo, commitSha, fileCount: files.length },
      'Fetched files from commit',
    );
    return files;
  }

  /**
   * Fetch content of a specific file at a specific commit
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param path - File path
   * @param commitSha - Commit SHA
   * @returns File content as string, or null if the file cannot be fetched
   * @private
   */
  private async fetchFileContent(
    owner: string,
    repo: string,
    path: string,
    commitSha: string,
  ): Promise<string | null> {
    const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${commitSha}`;

    try {
      const data = await this.fetchFromGitHub<GitHubContent>(url);

      // Skip binary files or files without content
      if (!data.content || data.size > MAX_FILE_SIZE) {
        return null;
      }

      // GitHub API returns content as base64 encoded
      if (data.encoding === 'base64') {
        return atob(data.content.replace(/\n/g, ''));
      }

      return data.content;
    } catch (error) {
      // Don't treat file content fetch failures as fatal
      // Just log and continue with other files
      this.logger.warn(
        {
          owner,
          repo,
          path,
          commitSha,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to fetch file content',
      );
      return null;
    }
  }
}
