/**
 * Ignore File Service
 *
 * This service is responsible for fetching and parsing .tsunamiignore files
 * from repositories. It works with the GitHub API to retrieve the ignore file
 * and parse its contents into patterns.
 *
 * @module services/ignoreFileService
 */

import { getLogger, trackedFetch, trackOperation, getRequestId } from '@dome/logging';
import {
  ValidationError,
  NotFoundError,
  ServiceUnavailableError,
  toDomeError
} from '@dome/errors';
import { assertValid } from '../utils/errors';
import { DEFAULT_IGNORE_PATTERNS } from '../config/defaultIgnorePatterns';
import { DEFAULT_FILTER_CONFIG, FilterConfig } from '../config/filterConfig';

/**
 * Service for fetching and parsing .tsunamiignore files
 */
export class IgnoreFileService {
  private logger = getLogger();
  private config: FilterConfig;
  private headers: Record<string, string>;
  private domain = 'tsunami.ignoreFileService';

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
    const requestId = getRequestId();
    
    return trackOperation('getIgnorePatterns', async () => {
      // Validate inputs
      assertValid(owner && owner.trim().length > 0, 'Owner cannot be empty', { owner, repo });
      assertValid(repo && repo.trim().length > 0, 'Repository name cannot be empty', { owner, repo });
      
      if (!this.config.enabled) {
        this.logger.debug({
          event: 'file_filtering_disabled',
          owner,
          repo,
          requestId
        }, 'File filtering is disabled');
        return [];
      }
      
      this.logger.info({
        event: 'get_ignore_patterns_start',
        owner,
        repo,
        requestId
      }, `Fetching ignore patterns for ${owner}/${repo}`);

      try {
        // Try to fetch the .tsunamiignore file
        const ignorePatterns = await this.fetchIgnoreFile(owner, repo);

        if (ignorePatterns) {
          this.logger.info(
            {
              event: 'ignore_patterns_found',
              owner,
              repo,
              patternCount: ignorePatterns.length,
              requestId
            },
            `Found ${this.config.ignoreFileName} file with ${ignorePatterns.length} patterns`,
          );
          return ignorePatterns;
        }

        // If no ignore file found and default patterns are enabled, use those
        if (this.config.useDefaultPatternsWhenNoIgnoreFile) {
          this.logger.info(
            {
              event: 'using_default_patterns',
              owner,
              repo,
              patternCount: DEFAULT_IGNORE_PATTERNS.length,
              requestId
            },
            `No ${this.config.ignoreFileName} file found, using ${DEFAULT_IGNORE_PATTERNS.length} default patterns`,
          );
          return DEFAULT_IGNORE_PATTERNS;
        }

        // Otherwise, return empty array (no filtering)
        this.logger.info(
          {
            event: 'no_patterns_applied',
            owner,
            repo,
            requestId
          },
          `No ${this.config.ignoreFileName} file found and default patterns disabled`,
        );
        return [];
      } catch (error) {
        this.logger.warn(
          {
            event: 'ignore_file_fetch_error',
            owner,
            repo,
            error: toDomeError(error).toJSON(),
            requestId
          },
          `Error fetching ${this.config.ignoreFileName} file: ${error instanceof Error ? error.message : String(error)}`,
        );

        // If error occurs and default patterns are enabled, use those
        if (this.config.useDefaultPatternsWhenNoIgnoreFile) {
          return DEFAULT_IGNORE_PATTERNS;
        }

        return [];
      }
    }, { owner, repo, requestId });
  }

  /**
   * Fetches the ignore file from a repository
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Array of patterns from the ignore file, or null if not found
   */
  private async fetchIgnoreFile(owner: string, repo: string): Promise<string[] | null> {
    const requestId = getRequestId();
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${this.config.ignoreFileName}`;
    
    return trackOperation('fetchIgnoreFile', async () => {
      try {
        const response = await trackedFetch(url, {
          headers: this.headers,
          method: 'GET'
        }, {
          owner,
          repo,
          fileName: this.config.ignoreFileName,
          requestId
        });

        if (!response.ok) {
          if (response.status === 404) {
            // File not found is expected in many cases
            this.logger.debug({
              event: 'ignore_file_not_found',
              owner,
              repo,
              fileName: this.config.ignoreFileName,
              requestId
            }, `${this.config.ignoreFileName} file not found`);
            return null;
          }

          // Other errors are unexpected
          const body = await response.text().catch(() => '<no-body>');
          
          // Throw appropriate error based on status code
          if (response.status >= 500) {
            throw new ServiceUnavailableError(`GitHub API error: ${response.status} ${response.statusText}`, {
              owner,
              repo,
              status: response.status,
              body: body.substring(0, 500), // Truncate long responses
              requestId
            });
          } else if (response.status === 403) {
            throw new ValidationError(`GitHub API rate limit or authentication error: ${response.statusText}`, {
              owner,
              repo,
              status: response.status,
              body: body.substring(0, 500),
              requestId
            });
          } else {
            throw new ValidationError(`GitHub API error: ${response.status} ${response.statusText}`, {
              owner,
              repo,
              status: response.status,
              body: body.substring(0, 500),
              requestId
            });
          }
        }

        // Define the expected GitHub content response type
        interface GitHubContentResponse {
          content?: string;
          encoding?: string;
          size?: number;
          name?: string;
          path?: string;
        }

        const data = (await response.json()) as GitHubContentResponse;

        if (!data.content) {
          this.logger.warn({
            event: 'empty_ignore_file',
            owner,
            repo,
            requestId
          }, `Empty ${this.config.ignoreFileName} file`);
          return [];
        }

        // GitHub API returns base64 encoded content
        const content = atob(data.content.replace(/\n/g, ''));

        // Split content into lines and filter out empty lines and comments
        const patterns = content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'));
          
        this.logger.debug({
          event: 'ignore_file_parsed',
          owner,
          repo,
          patternCount: patterns.length,
          requestId
        }, `Successfully parsed ${patterns.length} patterns from ${this.config.ignoreFileName}`);
        
        return patterns;
      } catch (error) {
        // Special handling for 404 errors since they're expected
        if (error instanceof Error && error.message.includes('404')) {
          this.logger.debug({
            event: 'ignore_file_not_found',
            owner,
            repo,
            requestId
          }, `${this.config.ignoreFileName} file not found (404)`);
          return null;
        }

        // Convert to a DomeError and add context
        throw toDomeError(error, `Failed to fetch ignore file for ${owner}/${repo}`, {
          owner,
          repo,
          fileName: this.config.ignoreFileName,
          domain: this.domain,
          requestId
        });
      }
    }, { owner, repo, requestId });
  }
}
