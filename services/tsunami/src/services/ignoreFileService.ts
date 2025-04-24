/**
 * Ignore File Service
 *
 * This service is responsible for fetching and parsing .tsunamiignore files
 * from repositories. It works with the GitHub API to retrieve the ignore file
 * and parse its contents into patterns.
 *
 * @module services/ignoreFileService
 */

import { getLogger } from '@dome/logging';
import { DEFAULT_IGNORE_PATTERNS } from '../config/defaultIgnorePatterns';
import { DEFAULT_FILTER_CONFIG, FilterConfig } from '../config/filterConfig';

/**
 * Service for fetching and parsing .tsunamiignore files
 */
export class IgnoreFileService {
  private logger = getLogger();
  private config: FilterConfig;
  private headers: Record<string, string>;

  /**
   * Creates a new IgnoreFileService instance
   * 
   * @param githubToken - GitHub API token for authentication
   * @param config - Configuration options (optional)
   */
  constructor(githubToken: string, config: Partial<FilterConfig> = {}) {
    this.config = { ...DEFAULT_FILTER_CONFIG, ...config };
    
    // Set up GitHub API headers
    this.headers = {
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Tsunami-Service/1.0.0 (+https://github.com/dome/tsunami)',
      ...(githubToken && { Authorization: `token ${githubToken}` }),
    };
  }

  /**
   * Fetches ignore patterns for a repository
   * 
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Array of ignore patterns
   */
  async getIgnorePatterns(owner: string, repo: string): Promise<string[]> {
    if (!this.config.enabled) {
      this.logger.debug({ owner, repo }, 'File filtering is disabled');
      return [];
    }

    try {
      // Try to fetch the .tsunamiignore file
      const ignorePatterns = await this.fetchIgnoreFile(owner, repo);
      
      if (ignorePatterns) {
        this.logger.info(
          { owner, repo, patternCount: ignorePatterns.length },
          `Found ${this.config.ignoreFileName} file with patterns`
        );
        return ignorePatterns;
      }
      
      // If no ignore file found and default patterns are enabled, use those
      if (this.config.useDefaultPatternsWhenNoIgnoreFile) {
        this.logger.info(
          { owner, repo, patternCount: DEFAULT_IGNORE_PATTERNS.length },
          `No ${this.config.ignoreFileName} file found, using default patterns`
        );
        return DEFAULT_IGNORE_PATTERNS;
      }
      
      // Otherwise, return empty array (no filtering)
      this.logger.info(
        { owner, repo },
        `No ${this.config.ignoreFileName} file found and default patterns disabled`
      );
      return [];
    } catch (error) {
      this.logger.warn(
        { owner, repo, error: (error as Error).message },
        `Error fetching ${this.config.ignoreFileName} file`
      );
      
      // If error occurs and default patterns are enabled, use those
      if (this.config.useDefaultPatternsWhenNoIgnoreFile) {
        return DEFAULT_IGNORE_PATTERNS;
      }
      
      return [];
    }
  }

  /**
   * Fetches the ignore file from a repository
   * 
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Array of patterns from the ignore file, or null if not found
   */
  private async fetchIgnoreFile(owner: string, repo: string): Promise<string[] | null> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${this.config.ignoreFileName}`;
    
    try {
      const response = await fetch(url, { headers: this.headers });
      
      if (!response.ok) {
        if (response.status === 404) {
          // File not found is expected in many cases
          this.logger.debug({ owner, repo }, `${this.config.ignoreFileName} file not found`);
          return null;
        }
        
        // Other errors are unexpected
        const body = await response.text().catch(() => '<no-body>');
        this.logger.error(
          { owner, repo, status: response.status, body },
          `Failed to fetch ${this.config.ignoreFileName} file`
        );
        throw new Error(`GitHub ${response.status}: ${response.statusText}`);
      }
      
      // Define the expected GitHub content response type
      interface GitHubContentResponse {
        content?: string;
        encoding?: string;
        size?: number;
        name?: string;
        path?: string;
      }
      
      const data = await response.json() as GitHubContentResponse;
      
      if (!data.content) {
        this.logger.warn({ owner, repo }, `Empty ${this.config.ignoreFileName} file`);
        return [];
      }
      
      // GitHub API returns base64 encoded content
      const content = atob(data.content.replace(/\n/g, ''));
      
      // Split content into lines and filter out empty lines and comments
      return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
    } catch (error) {
      if ((error as Error).message.includes('404')) {
        // File not found
        return null;
      }
      
      throw error;
    }
  }
}