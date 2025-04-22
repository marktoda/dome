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
import { Provider, PullOpts } from '.';
import { getLogger, metrics } from '@dome/logging';

/**
 * GitHub API constants
 */
const GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_HEADERS = {
  'Accept': 'application/vnd.github.v3+json',
  'X-GitHub-Api-Version': '2022-11-28'
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

  constructor(private env: Env) { }

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
  async pull(opts: PullOpts): Promise<SiloSimplePutInput[]> {
    const { userId, resourceId, cursor } = opts;
    const startTime = Date.now();
    
    try {
      this.logger.info({ userId, resourceId, cursor }, 'Starting GitHub pull');
      
      // Parse resourceId (expected format: owner/repo)
      const [owner, repo] = resourceId.split('/');
      if (!owner || !repo) {
        throw new Error(`Invalid resourceId format: ${resourceId}. Expected format: owner/repo`);
      }
      
      // Get GitHub token from environment
      // In a real implementation, this would come from environment variables or a secrets store
      // For now, we'll use a placeholder token for development
      const token = (this.env as any).GITHUB_TOKEN || 'placeholder_token';
      
      // In production, we should validate the token exists
      if (token === 'placeholder_token') {
        this.logger.warn({ resourceId }, 'Using placeholder GitHub token - this will not work with the real GitHub API');
      }
      
      // Fetch commits since cursor
      const commits = await this.fetchCommitsSinceCursor(owner, repo, cursor, token);
      if (commits.length === 0) {
        this.logger.info({ resourceId }, 'No new commits found');
        return [];
      }
      
      this.logger.info({ resourceId, commitCount: commits.length }, 'Found new commits');
      
      // Get changed files from each commit
      const results: SiloSimplePutInput[] = [];
      
      for (const commit of commits) {
        const files = await this.fetchFilesFromCommit(owner, repo, commit.sha, token);
        
        for (const file of files) {
          // Skip files that are too large or deleted
          if (file.status === 'removed' || file.changes > MAX_FILE_SIZE) {
            continue;
          }
          
          // Fetch file content
          const content = await this.fetchFileContent(owner, repo, file.filename, commit.sha, token);
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
            }
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
      
      return results;
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
   * @param token - GitHub API token
   * @returns Array of GitHub commits
   * @throws Error if the API request fails
   * @private
   */
  private async fetchCommitsSinceCursor(
    owner: string,
    repo: string,
    cursor: string | null,
    token: string
  ): Promise<GitHubCommit[]> {
    // If no cursor is provided, fetch only the latest commit
    if (!cursor) {
      const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits?per_page=1`;
      const response = await fetch(url, {
        headers: {
          ...DEFAULT_HEADERS,
          'Authorization': `token ${token}`
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch commits: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    }
    
    // Fetch all commits since the cursor
    const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits?sha=HEAD&since=${cursor}`;
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `token ${token}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch commits: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  }
  
  /**
   * Fetch files changed in a specific commit
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param commitSha - Commit SHA
   * @param token - GitHub API token
   * @returns Array of GitHub files
   * @throws Error if the API request fails
   * @private
   */
  private async fetchFilesFromCommit(
    owner: string,
    repo: string,
    commitSha: string,
    token: string
  ): Promise<GitHubFile[]> {
    const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/commits/${commitSha}`;
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `token ${token}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch commit details: ${response.status} ${response.statusText}`);
    }
    
    const commitData = await response.json() as { files?: GitHubFile[] };
    return commitData.files || [];
  }
  
  /**
   * Fetch content of a specific file at a specific commit
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param path - File path
   * @param commitSha - Commit SHA
   * @param token - GitHub API token
   * @returns File content as string, or null if the file cannot be fetched
   * @private
   */
  private async fetchFileContent(
    owner: string,
    repo: string,
    path: string,
    commitSha: string,
    token: string
  ): Promise<string | null> {
    const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${commitSha}`;
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `token ${token}`
      }
    });
    
    if (!response.ok) {
      this.logger.warn({ owner, repo, path, commitSha, status: response.status }, 'Failed to fetch file content');
      return null;
    }
    
    const data: GitHubContent = await response.json();
    
    // Skip binary files or files without content
    if (!data.content || data.size > MAX_FILE_SIZE) {
      return null;
    }
    
    // GitHub API returns content as base64 encoded
    if (data.encoding === 'base64') {
      return atob(data.content.replace(/\n/g, ''));
    }
    
    return data.content;
  }
}
