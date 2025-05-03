/**
 * WebsiteCrawler
 * 
 * This class is responsible for crawling websites and fetching pages.
 * It handles rate limiting, depth control, and URL filtering.
 */
import { getLogger } from '@dome/common';
import { RobotsChecker } from './robotsChecker';

export class WebsiteCrawler {
  private log = getLogger();
  private userAgent: string;
  private baseUrl: string = '';
  private maxDepth: number = 2;
  private delayMs: number = 1000;
  private robotsChecker: RobotsChecker | null = null;
  private includeImages: boolean = false;
  private includeScripts: boolean = false;
  private includeStyles: boolean = false;
  private followExternalLinks: boolean = false;
  private urlPatterns: RegExp[] = [];
  private visitedUrls: Set<string> = new Set();
  private pendingUrls: string[] = [];

  /**
   * Create a new WebsiteCrawler
   * @param userAgent The user agent to use for HTTP requests
   */
  constructor(userAgent: string) {
    this.userAgent = userAgent;
  }

  /**
   * Configure the crawler
   * @param config Configuration options
   */
  configure(config: CrawlerConfig): void {
    this.baseUrl = config.baseUrl;
    this.maxDepth = config.depth || 2;
    this.delayMs = config.delayMs || 1000;
    this.robotsChecker = config.respectRobotsTxt || null;
    this.includeImages = config.includeImages || false;
    this.includeScripts = config.includeScripts || false;
    this.includeStyles = config.includeStyles || false;
    this.followExternalLinks = config.followExternalLinks || false;

    // Compile regex patterns if provided
    this.urlPatterns = [];
    if (config.urlPatterns && config.urlPatterns.length > 0) {
      for (const pattern of config.urlPatterns) {
        try {
          this.urlPatterns.push(new RegExp(pattern));
        } catch (error) {
          this.log.warn({ pattern }, 'Invalid URL pattern, skipping');
        }
      }
    }

    this.log.info({
      baseUrl: this.baseUrl,
      maxDepth: this.maxDepth,
      delayMs: this.delayMs,
      respectRobotsTxt: !!this.robotsChecker,
      includeImages: this.includeImages,
      includeScripts: this.includeScripts,
      includeStyles: this.includeStyles,
      followExternalLinks: this.followExternalLinks,
      urlPatterns: config.urlPatterns
    }, 'Crawler configured');
  }

  /**
   * Crawl a list of URLs
   * @param startUrls The URLs to start crawling from
   * @param changedSinceDate Only return pages changed since this date (if available)
   * @returns An array of crawled pages
   */
  async crawl(startUrls: string[], changedSinceDate: Date | null = null): Promise<CrawledPage[]> {
    const baseUrlObj = new URL(this.baseUrl);
    const baseHostname = baseUrlObj.hostname;
    const results: CrawledPage[] = [];
    this.visitedUrls = new Set();
    this.pendingUrls = [];

    // Initialize the queue with the start URLs
    const queue: UrlDepthPair[] = startUrls.map(url => ({ url, depth: 0 }));
    
    while (queue.length > 0) {
      const { url, depth } = queue.shift()!;
      
      // Skip if we've already visited this URL
      if (this.visitedUrls.has(url)) {
        continue;
      }
      
      // Mark as visited
      this.visitedUrls.add(url);
      
      try {
        // Check if we should crawl this URL
        if (!this.shouldCrawl(url)) {
          continue;
        }
        
        // Fetch and process the page
        const page = await this.fetchPage(url);
        
        // Skip if the page has not changed since the specified date
        if (changedSinceDate && page.lastModified) {
          const lastModifiedDate = new Date(page.lastModified);
          if (lastModifiedDate <= changedSinceDate) {
            this.log.debug({ url, lastModified: page.lastModified }, 'Page not modified since last crawl');
            continue;
          }
        }
        
        // Add the page to the results
        results.push(page);
        
        // If we've reached the maximum depth, don't add new URLs to the queue
        if (depth >= this.maxDepth) {
          continue;
        }
        
        // Extract links from the page and add them to the queue
        if (page.links && page.links.length > 0) {
          for (const link of page.links) {
            try {
              const linkUrl = new URL(link, url).toString();
              const linkUrlObj = new URL(linkUrl);
              
              // Skip if it's not a supported protocol
              if (!linkUrl.startsWith('http:') && !linkUrl.startsWith('https:')) {
                continue;
              }
              
              // Skip external links if not allowed
              if (!this.followExternalLinks && linkUrlObj.hostname !== baseHostname) {
                this.pendingUrls.push(linkUrl);
                continue;
              }
              
              // Skip if we've already visited or queued this URL
              if (this.visitedUrls.has(linkUrl) || queue.some(item => item.url === linkUrl)) {
                continue;
              }
              
              // Add to the queue
              queue.push({ url: linkUrl, depth: depth + 1 });
            } catch (error) {
              // Skip invalid URLs
              this.log.debug({ link, error: error instanceof Error ? error.message : String(error) }, 'Invalid link URL');
            }
          }
        }
        
        // Respect the delay between requests
        if (queue.length > 0 && this.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }
      } catch (error) {
        this.log.warn({ 
          url, 
          error: error instanceof Error ? error.message : String(error) 
        }, 'Error crawling URL');
      }
    }

    return results;
  }

  /**
   * Get the list of URLs that are pending for the next crawl
   * @returns An array of pending URLs
   */
  getPendingUrls(): string[] {
    return [...this.pendingUrls];
  }

  /**
   * Check if a URL should be crawled
   * @param url The URL to check
   * @returns True if the URL should be crawled, false otherwise
   */
  private shouldCrawl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      
      // Check robots.txt if enabled
      if (this.robotsChecker && !this.robotsChecker.isAllowed(url)) {
        this.log.debug({ url }, 'URL blocked by robots.txt');
        return false;
      }
      
      // Skip URLs with unsupported file extensions
      const path = urlObj.pathname.toLowerCase();
      
      // Skip images, scripts, and styles if not explicitly included
      if (!this.includeImages && this.isImageUrl(path)) {
        return false;
      }
      
      if (!this.includeScripts && this.isScriptUrl(path)) {
        return false;
      }
      
      if (!this.includeStyles && this.isStyleUrl(path)) {
        return false;
      }
      
      // Check URL patterns if defined
      if (this.urlPatterns.length > 0) {
        const fullUrl = url.toString();
        const matches = this.urlPatterns.some(pattern => pattern.test(fullUrl));
        if (!matches) {
          this.log.debug({ url }, 'URL does not match any patterns');
          return false;
        }
      }
      
      return true;
    } catch (error) {
      this.log.warn({ url, error: error instanceof Error ? error.message : String(error) }, 'Error checking URL');
      return false;
    }
  }

  /**
   * Fetch a page and extract its content and links
   * @param url The URL to fetch
   * @returns The crawled page data
   */
  private async fetchPage(url: string): Promise<CrawledPage> {
    this.log.debug({ url }, 'Fetching page');
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': this.userAgent
      }
    });
    
    // Get content type and last modified date
    const contentType = response.headers.get('content-type') || 'text/html';
    const lastModified = response.headers.get('last-modified');
    
    // Handle non-successful responses
    if (!response.ok) {
      return {
        url,
        title: '',
        content: '',
        links: [],
        lastModified: null,
        contentType,
        statusCode: response.status,
        size: 0
      };
    }
    
    // Get text content for text/* and application/json
    let content = '';
    let links: string[] = [];
    let title = '';
    
    if (contentType.includes('text/html')) {
      content = await response.text();
      
      // Extract links and title from HTML
      const extractedData = this.extractFromHtml(content);
      links = extractedData.links;
      title = extractedData.title;
    } else if (
      contentType.includes('text/') || 
      contentType.includes('application/json') ||
      contentType.includes('application/javascript') ||
      contentType.includes('application/xml')
    ) {
      content = await response.text();
      
      // Use the last part of the URL path as the title
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      title = pathParts[pathParts.length - 1] || urlObj.hostname;
    } else {
      // Skip non-text content
      this.log.debug({ url, contentType }, 'Skipping non-text content');
    }
    
    return {
      url,
      title,
      content,
      links,
      lastModified,
      contentType,
      statusCode: response.status,
      size: content.length
    };
  }

  /**
   * Extract links and title from HTML content
   * @param html The HTML content
   * @returns The extracted links and title
   */
  private extractFromHtml(html: string): { links: string[], title: string } {
    const links: string[] = [];
    let title = '';
    
    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
    }
    
    // Extract links
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      
      // Skip anchor links and javascript: links
      if (href.startsWith('#') || href.startsWith('javascript:')) {
        continue;
      }
      
      links.push(href);
    }
    
    return { links, title };
  }

  /**
   * Check if a URL points to an image
   * @param path The URL path
   * @returns True if the URL points to an image
   */
  private isImageUrl(path: string): boolean {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.ico'];
    return imageExtensions.some(ext => path.endsWith(ext));
  }

  /**
   * Check if a URL points to a script
   * @param path The URL path
   * @returns True if the URL points to a script
   */
  private isScriptUrl(path: string): boolean {
    const scriptExtensions = ['.js', '.mjs', '.jsx', '.ts', '.tsx'];
    return scriptExtensions.some(ext => path.endsWith(ext));
  }

  /**
   * Check if a URL points to a stylesheet
   * @param path The URL path
   * @returns True if the URL points to a stylesheet
   */
  private isStyleUrl(path: string): boolean {
    const styleExtensions = ['.css', '.scss', '.sass', '.less'];
    return styleExtensions.some(ext => path.endsWith(ext));
  }
}

/**
 * Configuration for the WebsiteCrawler
 */
export interface CrawlerConfig {
  baseUrl: string;
  depth?: number;
  delayMs?: number;
  respectRobotsTxt?: RobotsChecker | null;
  includeImages?: boolean;
  includeScripts?: boolean;
  includeStyles?: boolean;
  followExternalLinks?: boolean;
  urlPatterns?: string[];
}

/**
 * URL and depth pair for the crawl queue
 */
interface UrlDepthPair {
  url: string;
  depth: number;
}

/**
 * Represents a crawled page
 */
export interface CrawledPage {
  url: string;
  title: string;
  content: string;
  links: string[];
  lastModified: string | null;
  contentType: string;
  statusCode: number;
  size: number;
}
