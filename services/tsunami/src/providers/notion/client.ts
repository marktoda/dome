/**
 * Notion API Client
 *
 * This client handles communication with the Notion API, including authentication,
 * rate limiting, and error handling.
 */
import { getLogger, metrics } from '@dome/common';
import { ServiceError } from '@dome/common/src/errors';
import { NotionAuthManager } from './auth';

/* ─── Constants ───────────────────────────────────────────────────────────── */

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const UA = 'Tsunami-Service/1.0.0 (+https://github.com/dome/tsunami)';

// Rate limits and retry configuration
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

/* ─── Types ────────────────────────────────────────────────────────────────── */

export type NotionPage = {
  id: string;
  title: string;
  url: string;
  last_edited_time: string;
  parent: {
    type: string;
    database_id?: string;
    page_id?: string;
    workspace?: boolean;
  };
  properties: Record<string, any>;
};

export type NotionBlock = {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: any;
};

export type NotionDatabase = {
  id: string;
  title: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, any>;
};

export type NotionSearchParams = {
  query?: string;
  filter?: {
    value: 'page' | 'database';
    property: 'object';
  };
  sort?: {
    direction: 'ascending' | 'descending';
    timestamp: 'last_edited_time';
  };
  start_cursor?: string;
  page_size?: number;
};

/**
 * Notion API Client class
 * Handles direct communication with Notion's API, including authentication,
 * rate limiting, and error handling
 */
export class NotionClient {
  private log = getLogger();
  private headers: Record<string, string>;
  private apiKey: string;
  private authManager?: NotionAuthManager;

  constructor(apiKey: string, authManager?: NotionAuthManager) {
    this.apiKey = apiKey;
    this.authManager = authManager;
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    };
  }

  /**
   * Set authorization token for a specific request
   * Useful when using OAuth tokens instead of API key
   *
   * @param token - OAuth access token
   * @returns A new instance of NotionClient with the token
   */
  withToken(token: string): NotionClient {
    const client = new NotionClient(token, this.authManager);
    return client;
  }

  /**
   * Fetch updated pages in a workspace since a given cursor (timestamp)
   *
   * @param workspaceId - The Notion workspace ID
   * @param cursor - ISO timestamp string or null for first sync
   * @returns Array of Notion pages
   */
  async getUpdatedPages(workspaceId: string, cursor: string | null): Promise<NotionPage[]> {
    try {
      const startTime = performance.now();
      this.log.info({ workspaceId, cursor }, 'notion: fetching updated pages');

      // For Notion, we'll use the search endpoint with filters
      const params: NotionSearchParams = {
        filter: {
          value: 'page',
          property: 'object',
        },
        sort: {
          direction: 'descending',
          timestamp: 'last_edited_time',
        },
        page_size: 100,
      };

      const response = await this.post('/search', params);
      const pages = response.results || [];

      // Filter out pages updated before the cursor
      const filteredPages = cursor
        ? pages.filter((page: NotionPage) => new Date(page.last_edited_time) > new Date(cursor))
        : pages;

      this.log.info(
        { workspaceId, count: filteredPages.length, totalFetched: pages.length },
        'notion: updated pages fetched',
      );

      metrics.timing('notion.get_updated_pages.latency_ms', performance.now() - startTime);
      metrics.increment('notion.get_updated_pages.count', filteredPages.length);

      return filteredPages;
    } catch (error) {
      this.log.error(
        { workspaceId, error: error instanceof Error ? error.message : String(error) },
        'notion: error fetching updated pages',
      );

      metrics.increment('notion.get_updated_pages.errors');

      throw new ServiceError('Failed to fetch updated pages from Notion', {
        cause: error,
        context: { workspaceId, cursor },
      });
    }
  }

  /**
   * Fetch a specific page by ID
   *
   * @param pageId - The Notion page ID
   * @returns Notion page object
   */
  async getPage(pageId: string): Promise<NotionPage> {
    try {
      const startTime = performance.now();
      this.log.info({ pageId }, 'notion: fetching page');

      const page = await this.get(`/pages/${pageId}`);

      // Transform properties to extract the title
      const title = this.extractPageTitle(page);

      metrics.timing('notion.get_page.latency_ms', performance.now() - startTime);

      return {
        ...page,
        title,
      };
    } catch (error) {
      this.log.error(
        { pageId, error: error instanceof Error ? error.message : String(error) },
        'notion: error fetching page',
      );

      metrics.increment('notion.get_page.errors');

      throw new ServiceError('Failed to fetch page from Notion', {
        cause: error,
        context: { pageId },
      });
    }
  }

  /**
   * Get the content (blocks) of a page
   *
   * @param pageId - The Notion page ID
   * @returns String representation of the page content
   */
  async getPageContent(pageId: string): Promise<string> {
    try {
      const startTime = performance.now();
      this.log.info({ pageId }, 'notion: fetching page content');

      // Fetch all blocks for the page
      const blocks = await this.getAllBlocksByPageId(pageId);

      // Convert blocks to string (this would be implemented in the utils)
      const content = JSON.stringify(blocks);

      metrics.timing('notion.get_page_content.latency_ms', performance.now() - startTime);
      metrics.increment('notion.get_page_content.block_count', blocks.length);

      return content;
    } catch (error) {
      this.log.error(
        { pageId, error: error instanceof Error ? error.message : String(error) },
        'notion: error fetching page content',
      );

      metrics.increment('notion.get_page_content.errors');

      throw new ServiceError('Failed to fetch page content from Notion', {
        cause: error,
        context: { pageId },
      });
    }
  }

  /**
   * Fetch a database by ID
   *
   * @param databaseId - The Notion database ID
   * @returns Notion database object
   */
  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    try {
      const startTime = performance.now();
      this.log.info({ databaseId }, 'notion: fetching database');

      const database = await this.get(`/databases/${databaseId}`);

      metrics.timing('notion.get_database.latency_ms', performance.now() - startTime);

      return database;
    } catch (error) {
      this.log.error(
        { databaseId, error: error instanceof Error ? error.message : String(error) },
        'notion: error fetching database',
      );

      metrics.increment('notion.get_database.errors');

      throw new ServiceError('Failed to fetch database from Notion', {
        cause: error,
        context: { databaseId },
      });
    }
  }

  /**
   * Fetch all workspaces available to the integration
   *
   * @returns Array of workspace objects
   */
  async getWorkspaces(): Promise<any[]> {
    try {
      const startTime = performance.now();
      this.log.info('notion: fetching workspaces');

      // The users endpoint can be used to determine which workspaces the bot has access to
      const response = await this.get('/users');

      metrics.timing('notion.get_workspaces.latency_ms', performance.now() - startTime);

      return response.results || [];
    } catch (error) {
      this.log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'notion: error fetching workspaces',
      );

      metrics.increment('notion.get_workspaces.errors');

      throw new ServiceError('Failed to fetch workspaces from Notion', {
        cause: error,
      });
    }
  }

  /* ─── Private Helper Methods ────────────────────────────────────────────── */

  /**
   * Get all blocks for a page, handling pagination
   *
   * @param pageId - The Notion page ID
   * @returns Array of block objects
   */
  private async getAllBlocksByPageId(pageId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const params: any = { page_size: 100 };
      if (cursor) params.start_cursor = cursor;

      const response = await this.get(`/blocks/${pageId}/children`, params);

      blocks.push(...(response.results || []));
      cursor = response.next_cursor;

      // Recursively fetch child blocks for blocks that have children
      for (const block of response.results || []) {
        if (block.has_children) {
          const childBlocks = await this.getAllBlocksByPageId(block.id);
          // Add a reference to the parent block for context
          const childBlocksWithParent = childBlocks.map(childBlock => ({
            ...childBlock,
            parent_id: block.id,
          }));
          blocks.push(...childBlocksWithParent);
        }
      }
    } while (cursor);

    return blocks;
  }

  /**
   * Extract page title from Notion page object
   *
   * @param page - Notion page object
   * @returns Page title string
   */
  private extractPageTitle(page: any): string {
    try {
      // Check for title property first
      if (page.properties?.title) {
        const titleProp = page.properties.title;
        if (Array.isArray(titleProp.title)) {
          return titleProp.title.map((t: any) => t.plain_text || '').join('');
        }
      }

      // Check for Name property as fallback
      if (page.properties?.Name) {
        const nameProp = page.properties.Name;
        if (Array.isArray(nameProp.title)) {
          return nameProp.title.map((t: any) => t.plain_text || '').join('');
        }
      }

      // Fallback to page ID if no title found
      return `Untitled Page (${page.id})`;
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error), pageId: page.id },
        'notion: error extracting page title',
      );
      return `Untitled Page (${page.id})`;
    }
  }

  /* ─── API Request Methods ────────────────────────────────────────────────── */

  /**
   * Make a GET request to the Notion API
   *
   * @param endpoint - API endpoint (starting with /)
   * @param queryParams - Optional query parameters
   * @returns API response as JSON
   */
  private async get(endpoint: string, queryParams: Record<string, any> = {}): Promise<any> {
    const url = new URL(`${API_BASE}${endpoint}`);

    // Add query parameters
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });

    return this.request('GET', url.toString());
  }

  /**
   * Make a POST request to the Notion API
   *
   * @param endpoint - API endpoint (starting with /)
   * @param body - Request body
   * @returns API response as JSON
   */
  private async post(endpoint: string, body: any): Promise<any> {
    const url = `${API_BASE}${endpoint}`;
    return this.request('POST', url, body);
  }

  /**
   * Make a PATCH request to the Notion API
   *
   * @param endpoint - API endpoint (starting with /)
   * @param body - Request body
   * @returns API response as JSON
   */
  private async patch(endpoint: string, body: any): Promise<any> {
    const url = `${API_BASE}${endpoint}`;
    return this.request('PATCH', url, body);
  }

  /**
   * Make a request to the Notion API with retries and error handling
   *
   * @param method - HTTP method
   * @param url - Full URL
   * @param body - Optional request body
   * @returns API response as JSON
   */
  /**
   * Get a token for a specific user and workspace
   *
   * @param userId - User ID
   * @param workspaceId - Notion workspace ID
   * @returns The access token or null if not found
   */
  async getTokenForUser(userId: string, workspaceId: string): Promise<string | null> {
    if (!this.authManager) {
      this.log.warn({ userId, workspaceId }, 'notion: no auth manager available');
      return null;
    }

    return this.authManager.getUserToken(userId, workspaceId);
  }

  /**
   * Create a client instance for a specific user and workspace
   *
   * @param userId - User ID
   * @param workspaceId - Notion workspace ID
   * @returns A new client instance with the user's token, or this instance if no token found
   */
  async forUser(userId: string, workspaceId: string): Promise<NotionClient> {
    const token = await this.getTokenForUser(userId, workspaceId);
    if (token) {
      return this.withToken(token);
    }

    this.log.warn({ userId, workspaceId }, 'notion: no user token found, using default API key');

    return this;
  }

  private async request(method: string, url: string, body?: any): Promise<any> {
    let retries = 0;
    let delay = INITIAL_DELAY_MS;

    while (true) {
      try {
        const options: RequestInit = {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
        };

        const response = await fetch(url, options);

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
          const waitTime = retryAfter * 1000;

          this.log.warn({ url, retryAfter }, 'notion: rate limited, will retry');

          if (retries < MAX_RETRIES) {
            retries++;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            throw new ServiceError('Notion API rate limit exceeded', {
              context: { url, method, retries },
            });
          }
        }

        // Handle other error responses
        if (!response.ok) {
          const errorText = await response.text().catch(() => '<no-body>');
          this.log.error(
            { url, status: response.status, body: errorText },
            'notion: request failed',
          );

          throw new ServiceError(`Notion API error: ${response.status} ${response.statusText}`, {
            context: { url, method, status: response.status },
          });
        }

        // Log remaining rate limits if available
        const rateLimit = response.headers.get('x-ratelimit-remaining');
        if (rateLimit) {
          this.log.debug({ rateLimit, url }, 'notion: rate-limit');
        }

        return await response.json();
      } catch (error) {
        // Handle network errors and retry
        if (!(error instanceof ServiceError) && retries < MAX_RETRIES) {
          retries++;
          this.log.warn(
            {
              url,
              retries,
              delay,
              error: error instanceof Error ? error.message : String(error),
            },
            'notion: request failed, retrying',
          );

          await new Promise(resolve => setTimeout(resolve, delay));

          // Exponential backoff
          delay = Math.min(delay * 2, MAX_DELAY_MS);
          continue;
        }

        // If we've exhausted retries or it's a ServiceError, rethrow
        throw error instanceof ServiceError
          ? error
          : new ServiceError('Failed to communicate with Notion API', {
              cause: error,
              context: { url, method, retries },
            });
      }
    }
  }
}
