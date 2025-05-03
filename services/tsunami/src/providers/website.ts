/**
 * Website Provider
 *
 * This provider is responsible for crawling websites, extracting content,
 * and injecting metadata headers before sending to Silo.
 */
import { SiloSimplePutInput, ContentCategory, MimeType } from '@dome/common';
import { Provider, PullOpts, PullResult } from '.';
import { getLogger, logError, metrics } from '@dome/common';
import { DEFAULT_FILTER_CONFIG } from '../config/filterConfig';
import { IgnorePatternProcessor } from '../utils/ignorePatternProcessor';
import { RobotsChecker } from './website/robotsChecker';
import { WebsiteCrawler } from './website/websiteCrawler';
import { ContentExtractor } from './website/contentExtractor';
import { createWebsiteMetadata, injectMetadataHeader } from '../services/metadataHeaderService';

/* ─── constants ────────────────────────────────────────────────────────── */

const UA = 'Tsunami-Service/1.0.0 (+https://github.com/dome/tsunami)';
const MAX_SIZE = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_CRAWL_DEPTH = 2;
const DEFAULT_DELAY_MS = 1000; // 1 second delay between requests

/* ─── types ────────────────────────────────────────────────────────────── */

export type WebsiteConfig = {
  url: string;
  crawlDepth?: number;
  respectRobotsTxt?: boolean;
  delayMs?: number;
  includeImages?: boolean;
  includeScripts?: boolean;
  includeStyles?: boolean;
  followExternalLinks?: boolean;
  urlPatterns?: string[];
};

type WebsitePage = {
  url: string;
  title: string;
  content: string;
  lastModified: string | null;
  links: string[];
  contentType: string;
  statusCode: number;
  size: number;
};

/* ─── WebsiteProvider class ────────────────────────────────────────────── */

export class WebsiteProvider implements Provider {
  private log = getLogger();
  private ignorePatternProcessor: IgnorePatternProcessor;
  private robotsChecker: RobotsChecker;
  private crawler: WebsiteCrawler;
  private extractor: ContentExtractor;
  private filterConfig = DEFAULT_FILTER_CONFIG;

  constructor(env: Env) {
    // Initialize components
    this.ignorePatternProcessor = new IgnorePatternProcessor();
    this.robotsChecker = new RobotsChecker(UA);
    this.crawler = new WebsiteCrawler(UA);
    this.extractor = new ContentExtractor();
  }

  /* ─── Provider implementation ────────────────────────────────────────── */

  async pull({ userId, resourceId, cursor }: PullOpts): Promise<PullResult> {
    const t0 = Date.now();

    try {
      // Parse resourceId as a JSON string to get the website configuration
      let config: WebsiteConfig;
      try {
        config = JSON.parse(resourceId);
      } catch (error: any) {
        throw new Error(`Invalid resourceId for website provider: ${error.message}`);
      }

      if (!config.url) {
        throw new Error('Website configuration must include a URL');
      }

      this.log.info({ url: config.url, cursor }, 'website: pull start');

      // Set default configuration values if not provided
      const crawlDepth = config.crawlDepth ?? DEFAULT_CRAWL_DEPTH;
      const respectRobotsTxt = config.respectRobotsTxt !== false; // Default to true
      const delayMs = config.delayMs ?? DEFAULT_DELAY_MS;
      const includeImages = config.includeImages === true; // Default to false
      const includeScripts = config.includeScripts === true; // Default to false
      const includeStyles = config.includeStyles === true; // Default to false
      const followExternalLinks = config.followExternalLinks === true; // Default to false

      // Check robots.txt if enabled
      if (respectRobotsTxt) {
        const baseUrl = new URL(config.url).origin;
        await this.robotsChecker.initialize(baseUrl);

        if (!this.robotsChecker.isAllowed(config.url)) {
          this.log.warn({ url: config.url }, 'website: blocked by robots.txt');
          return { contents: [], newCursor: cursor };
        }
      }

      // Setup crawler configuration
      this.crawler.configure({
        baseUrl: config.url,
        depth: crawlDepth,
        delayMs,
        respectRobotsTxt: respectRobotsTxt ? this.robotsChecker : null,
        includeImages,
        includeScripts,
        includeStyles,
        followExternalLinks,
        urlPatterns: config.urlPatterns,
      });

      // Determine what URLs we need to crawl based on the cursor
      let startUrls: string[] = [config.url];
      let changedSinceDate: Date | null = null;

      if (cursor) {
        try {
          // Parse cursor as an ISO date string or as a JSON object with more detailed info
          const cursorData = JSON.parse(cursor);
          changedSinceDate = new Date(cursorData.lastCrawl);
          if (cursorData.crawledUrls && Array.isArray(cursorData.crawledUrls)) {
            // Only crawl URLs that weren't successfully crawled in the previous run
            startUrls = cursorData.pendingUrls ?? [config.url];
          }
        } catch (e) {
          // If cursor isn't valid JSON, try to parse it as a simple date string
          changedSinceDate = new Date(cursor);
        }
      }

      // Crawl the website
      const crawledPages = await this.crawler.crawl(startUrls, changedSinceDate);

      if (!crawledPages.length) {
        this.log.info({ url: config.url }, 'website: no updates found');
        return {
          contents: [],
          newCursor: this.createCursor(cursor, crawledPages, [])
        };
      }

      // Process pages and convert to storable format
      const puts: SiloSimplePutInput[] = [];
      const crawledUrls: string[] = [];
      const pendingUrls: string[] = this.crawler.getPendingUrls();
      let filteredPages = 0;

      for (const page of crawledPages) {
        // Track URLs we've successfully crawled
        crawledUrls.push(page.url);

        // Extract and clean content if it's an HTML page
        let content = page.content;
        let category: ContentCategory = 'document';
        let mimeType: MimeType = 'text/html';

        if (page.contentType.includes('text/html')) {
          content = this.extractor.extract(page.content, page.url);
          category = 'document';
        } else if (page.contentType.includes('application/json')) {
          category = 'code';
          mimeType = 'application/json';
        } else if (page.contentType.includes('text/css')) {
          category = 'code';
          mimeType = 'text/css';
        } else if (page.contentType.includes('application/javascript')) {
          category = 'code';
          mimeType = 'application/javascript';
        } else if (page.contentType.includes('text/')) {
          category = 'document';
          mimeType = 'text/plain';
        } else {
          // Skip non-text content
          this.log.debug({ url: page.url, contentType: page.contentType }, 'website: skipping non-text content');
          continue;
        }

        // Skip if file is too large or content extraction failed
        if (content.length === 0 || content.length > MAX_SIZE) {
          filteredPages++;
          continue;
        }

        // Create metadata for the page
        const metadata = createWebsiteMetadata(
          config.url,
          page.url,
          page.lastModified || new Date().toISOString(),
          page.title,
          content.length
        );

        // Inject metadata header into content
        const contentWithMetadata = injectMetadataHeader(content, metadata);

        puts.push({
          content: contentWithMetadata,
          category,
          mimeType,
          userId,
          metadata: {
            baseUrl: config.url,
            url: page.url,
            title: page.title,
            lastModified: page.lastModified,
            crawlDate: new Date().toISOString(),
          },
        });
      }

      // Create a new cursor with information for the next pull
      const newCursor = this.createCursor(cursor, crawledPages, pendingUrls);

      // Record metrics
      metrics.timing('website.pull.latency_ms', Date.now() - t0);
      metrics.increment('website.pull.pages_processed', puts.length);

      // Add metrics for filtered pages if enabled
      if (this.filterConfig.trackFilterMetrics) {
        metrics.increment('website.pull.pages_filtered', filteredPages);
      }

      this.log.info(
        {
          url: config.url,
          pages: puts.length,
          filtered: filteredPages,
          crawled: crawledUrls.length,
          pending: pendingUrls.length
        },
        'website: pull done',
      );

      return { contents: puts, newCursor };
    } catch (error) {
      logError(error, 'website: pull failed');

      metrics.increment('website.pull.errors');
      throw error;
    }
  }

  private createCursor(
    currentCursor: string | null,
    crawledPages: WebsitePage[],
    pendingUrls: string[]
  ): string {
    // Create a cursor that contains:
    // 1. The timestamp of this crawl
    // 2. The URLs that were successfully crawled
    // 3. The URLs that are pending for the next crawl

    // Parse existing cursor if available
    let existingCrawledUrls: string[] = [];

    if (currentCursor) {
      try {
        const parsed = JSON.parse(currentCursor);
        if (parsed.crawledUrls && Array.isArray(parsed.crawledUrls)) {
          existingCrawledUrls = parsed.crawledUrls;
        }
      } catch (e) {
        // If not valid JSON, start fresh
      }
    }

    // Combine existing and new crawled URLs
    const newCrawledUrls = crawledPages.map(page => page.url);
    const allCrawledUrls = [...new Set([...existingCrawledUrls, ...newCrawledUrls])];

    const cursor = {
      lastCrawl: new Date().toISOString(),
      crawledUrls: allCrawledUrls,
      pendingUrls: pendingUrls.length > 0 ? pendingUrls : null,
    };

    return JSON.stringify(cursor);
  }
}
