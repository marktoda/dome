/**
 * Notion Provider
 *
 * This provider is responsible for pulling content from Notion workspaces
 * and injecting metadata headers before sending to Silo.
 */
import { SiloSimplePutInput, ContentCategory, MimeType } from '@dome/common';
import { Provider, PullOpts, PullResult } from '..';
import { getLogger, metrics } from '@dome/common';
import {
  createNotionMetadata,
  determineCategory,
  determineMimeType,
  blocksToText,
  shouldIgnorePage
} from './utils';
import { injectMetadataHeader } from '../../services/metadataHeaderService';
import { IgnorePatternProcessor } from '../../utils/ignorePatternProcessor';
import { DEFAULT_FILTER_CONFIG } from '../../config/filterConfig';
import { NotionClient } from './client';
import { NotionAuthManager } from './auth';

/**
 * Notion Provider implementation
 * Implements the Provider interface to pull content from Notion workspaces
 */
export class NotionProvider implements Provider {
  private log = getLogger();
  private notionClient: NotionClient;
  private authManager: NotionAuthManager;
  private ignorePatternProcessor: IgnorePatternProcessor;
  private filterConfig = DEFAULT_FILTER_CONFIG;

  constructor(env: Env) {
    const apiKey = (env as any).NOTION_API_KEY ?? '';
    this.authManager = new NotionAuthManager(env);
    this.notionClient = new NotionClient(apiKey, this.authManager);
    this.ignorePatternProcessor = new IgnorePatternProcessor();
  }

  /**
   * Pull method implementation for Provider interface
   * Retrieves content from Notion workspaces updated since cursor
   */
  async pull({ userId, resourceId, cursor }: PullOpts): Promise<PullResult> {
    // Get workspace ID from resourceId
    const workspaceId = resourceId;
    const startTime = performance.now();
    
    this.log.info({ workspaceId, cursor, userId }, 'notion: pull start');

    try {
      // Get client with user-specific token if available
      const client = userId
        ? await this.notionClient.forUser(userId, workspaceId)
        : this.notionClient;
      
      // Get pages changed since cursor
      const pages = await client.getUpdatedPages(workspaceId, cursor);
      
      if (!pages.length) {
        this.log.info({ resourceId }, 'notion: no updates found');
        return { contents: [], newCursor: cursor };
      }

      // Process pages and convert to storable format
      const puts: SiloSimplePutInput[] = [];
      let latestUpdate = cursor || '1970-01-01T00:00:00.000Z';

      for (const page of pages) {
        // Check if page should be filtered
        if (shouldIgnorePage(page)) {
          if (this.filterConfig.logFilteredFiles) {
            this.log.debug({ pageId: page.id }, 'Page filtered by ignore pattern');
          }
          continue;
        }

        try {
          // Get page content as blocks using same client instance
          const contentData = await client.getPageContent(page.id);
          
          // Create metadata for the page
          const metadata = createNotionMetadata(
            workspaceId,
            page.id,
            page.last_edited_time,
            page.title,
            contentData.length
          );

          // Inject metadata header into content
          const contentWithMetadata = injectMetadataHeader(contentData, metadata);

          puts.push({
            content: contentWithMetadata,
            category: determineCategory(page),
            mimeType: determineMimeType(page),
            userId,
            metadata: {
              workspace: workspaceId,
              pageId: page.id,
              title: page.title,
              lastEditedTime: page.last_edited_time,
              url: page.url,
            },
          });

          // Track latest update for cursor
          if (page.last_edited_time > latestUpdate) {
            latestUpdate = page.last_edited_time;
          }
        } catch (error) {
          this.log.error(
            { pageId: page.id, error: error instanceof Error ? error.message : String(error) },
            'notion: error processing page'
          );
          metrics.increment('notion.pull.page_errors');
        }
      }

      // Record metrics
      metrics.timing('notion.pull.latency_ms', performance.now() - startTime);
      metrics.increment('notion.pull.pages_processed', puts.length);

      // Add metrics for filtered pages if enabled
      const filteredPages = pages.length - puts.length;
      if (this.filterConfig.trackFilterMetrics) {
        metrics.increment('notion.pull.pages_filtered', filteredPages);
      }

      this.log.info(
        { resourceId, pages: puts.length, filtered: filteredPages },
        'notion: pull done'
      );

      return { contents: puts, newCursor: latestUpdate };
    } catch (error) {
      this.log.error(
        { resourceId, error: error instanceof Error ? error.message : String(error) },
        'notion: pull failed'
      );
      
      metrics.increment('notion.pull.errors');
      
      // Rethrow to let the caller handle it
      throw error;
    }
  }
}
