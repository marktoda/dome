import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebsiteCrawler, CrawlerConfig } from '../../../src/providers/website/websiteCrawler';
import { RobotsChecker } from '../../../src/providers/website/robotsChecker';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock logger
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock RobotsChecker
vi.mock('../../../src/providers/website/robotsChecker', () => ({
  RobotsChecker: vi.fn().mockImplementation(() => ({
    isAllowed: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('WebsiteCrawler', () => {
  let crawler: WebsiteCrawler;
  let mockRobotsChecker: RobotsChecker;
  const userAgent = 'TestBot/1.0';

  beforeEach(() => {
    crawler = new WebsiteCrawler(userAgent);
    mockRobotsChecker = new RobotsChecker(userAgent);
    vi.clearAllMocks();
    
    // Default successful response
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body><p>Test content</p></body></html>',
      headers: new Map([
        ['content-type', 'text/html'],
        ['last-modified', '2025-01-01T00:00:00Z']
      ]),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('configuration', () => {
    it('should configure the crawler with default values', () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
      };
      
      crawler.configure(config);
      
      // Test that default values are applied
      // This requires exposing the private fields for testing or using any
      expect((crawler as any).baseUrl).toBe('https://example.com');
      expect((crawler as any).maxDepth).toBe(2);
      expect((crawler as any).delayMs).toBe(1000);
      expect((crawler as any).includeImages).toBe(false);
      expect((crawler as any).includeScripts).toBe(false);
      expect((crawler as any).includeStyles).toBe(false);
      expect((crawler as any).followExternalLinks).toBe(false);
    });

    it('should override default values with provided configuration', () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        depth: 3,
        delayMs: 2000,
        includeImages: true,
        includeScripts: true,
        includeStyles: true,
        followExternalLinks: true,
        respectRobotsTxt: mockRobotsChecker,
        urlPatterns: ['^https://example\\.com/blog/.*'],
      };
      
      crawler.configure(config);
      
      expect((crawler as any).baseUrl).toBe('https://example.com');
      expect((crawler as any).maxDepth).toBe(3);
      expect((crawler as any).delayMs).toBe(2000);
      expect((crawler as any).includeImages).toBe(true);
      expect((crawler as any).includeScripts).toBe(true);
      expect((crawler as any).includeStyles).toBe(true);
      expect((crawler as any).followExternalLinks).toBe(true);
      expect((crawler as any).robotsChecker).toBe(mockRobotsChecker);
      expect((crawler as any).urlPatterns.length).toBe(1);
    });

    it('should handle invalid URL patterns gracefully', () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        urlPatterns: ['^https://example\\.com/blog/.*', '[invalid regex'],
      };
      
      crawler.configure(config);
      
      // Should only have one valid pattern
      expect((crawler as any).urlPatterns.length).toBe(1);
    });
  });

  describe('crawl', () => {
    it('should crawl a single URL', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
      };
      
      crawler.configure(config);
      
      const results = await crawler.crawl(['https://example.com']);
      
      expect(results.length).toBe(1);
      expect(results[0].url).toBe('https://example.com');
      expect(results[0].content).toContain('Test content');
      expect(results[0].statusCode).toBe(200);
      expect(results[0].contentType).toBe('text/html');
      expect(results[0].lastModified).toBe('2025-01-01T00:00:00Z');
    });

    it('should follow links up to the specified depth', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        depth: 2,
      };
      
      crawler.configure(config);
      
      // First page with links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/page1">Page 1</a>
              <a href="https://example.com/page2">Page 2</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Page 1 with more links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/page1/subpage1">Subpage 1</a>
              <a href="https://example.com/page1/subpage2">Subpage 2</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Page 2 with no links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Page 2</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Subpage 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Subpage 1</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Subpage 2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Subpage 2</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      const results = await crawler.crawl(['https://example.com']);
      
      // Should have crawled all 5 pages
      expect(results.length).toBe(5);
      expect(results.some(page => page.url === 'https://example.com')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/page1')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/page2')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/page1/subpage1')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/page1/subpage2')).toBe(true);
    });

    it('should respect robots.txt when enabled', async () => {
      const mockRobotsChecker = {
        isAllowed: vi.fn().mockImplementation((url) => {
          // Only allow the base URL, block all others
          return url === 'https://example.com';
        }),
        initialize: vi.fn().mockResolvedValue(undefined),
      };
      
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        respectRobotsTxt: mockRobotsChecker as unknown as RobotsChecker,
      };
      
      crawler.configure(config);
      
      // Base page with links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/page1">Page 1</a>
              <a href="https://example.com/page2">Page 2</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      const results = await crawler.crawl(['https://example.com']);
      
      // Should only have crawled the base URL
      expect(results.length).toBe(1);
      expect(results[0].url).toBe('https://example.com');
      
      // Should have checked robots.txt for all URLs
      expect(mockRobotsChecker.isAllowed).toHaveBeenCalledWith('https://example.com');
      expect(mockRobotsChecker.isAllowed).toHaveBeenCalledWith('https://example.com/page1');
      expect(mockRobotsChecker.isAllowed).toHaveBeenCalledWith('https://example.com/page2');
    });

    it('should filter URLs based on patterns when provided', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        urlPatterns: ['^https://example\\.com/blog/.*'],
      };
      
      crawler.configure(config);
      
      // Base page with links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/blog/post1">Blog Post 1</a>
              <a href="https://example.com/about">About</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Blog post page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Blog Post 1</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      const results = await crawler.crawl(['https://example.com']);
      
      // Should have crawled the base URL and the blog post, but not the about page
      expect(results.length).toBe(2);
      expect(results.some(page => page.url === 'https://example.com')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/blog/post1')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/about')).toBe(false);
    });

    it('should handle non-HTML content types', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        includeScripts: true,
        includeStyles: true,
      };
      
      crawler.configure(config);
      
      // Base page with links to different content types
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/script.js">JavaScript</a>
              <a href="https://example.com/style.css">CSS</a>
              <a href="https://example.com/data.json">JSON</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // JavaScript file
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `function test() { return 'Hello'; }`,
        headers: new Map([
          ['content-type', 'application/javascript'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // CSS file
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `body { color: red; }`,
        headers: new Map([
          ['content-type', 'text/css'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // JSON file
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `{"key": "value"}`,
        headers: new Map([
          ['content-type', 'application/json'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      const results = await crawler.crawl(['https://example.com']);
      
      // Should have crawled all 4 URLs
      expect(results.length).toBe(4);
      expect(results.some(page => page.url === 'https://example.com')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/script.js')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/style.css')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/data.json')).toBe(true);
      
      // Check content types
      const jsPage = results.find(page => page.url === 'https://example.com/script.js');
      const cssPage = results.find(page => page.url === 'https://example.com/style.css');
      const jsonPage = results.find(page => page.url === 'https://example.com/data.json');
      
      expect(jsPage?.contentType).toBe('application/javascript');
      expect(cssPage?.contentType).toBe('text/css');
      expect(jsonPage?.contentType).toBe('application/json');
    });

    it('should handle HTTP errors gracefully', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
      };
      
      crawler.configure(config);
      
      // Base page with links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/not-found">Not Found</a>
              <a href="https://example.com/server-error">Server Error</a>
              <a href="https://example.com/valid">Valid Page</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // 404 Not Found
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '404 Not Found',
        headers: new Map([
          ['content-type', 'text/plain'],
        ]),
      });
      
      // 500 Server Error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => '500 Internal Server Error',
        headers: new Map([
          ['content-type', 'text/plain'],
        ]),
      });
      
      // Valid page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Valid Page</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      const results = await crawler.crawl(['https://example.com']);
      
      // Should have crawled all 4 URLs, including the error pages
      expect(results.length).toBe(4);
      
      // Check status codes
      const notFoundPage = results.find(page => page.url === 'https://example.com/not-found');
      const serverErrorPage = results.find(page => page.url === 'https://example.com/server-error');
      const validPage = results.find(page => page.url === 'https://example.com/valid');
      
      expect(notFoundPage?.statusCode).toBe(404);
      expect(serverErrorPage?.statusCode).toBe(500);
      expect(validPage?.statusCode).toBe(200);
    });

    it('should handle network errors gracefully', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
      };
      
      crawler.configure(config);
      
      // Base page with links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/network-error">Network Error</a>
              <a href="https://example.com/valid">Valid Page</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Network error
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      
      // Valid page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Valid Page</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      const results = await crawler.crawl(['https://example.com']);
      
      // Should have crawled only the base URL and the valid page
      expect(results.length).toBe(2);
      expect(results.some(page => page.url === 'https://example.com')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/valid')).toBe(true);
      expect(results.some(page => page.url === 'https://example.com/network-error')).toBe(false);
    });
  });

  describe('getPendingUrls', () => {
    it('should return URLs that were not crawled due to external domain', async () => {
      const config: CrawlerConfig = {
        baseUrl: 'https://example.com',
        followExternalLinks: false,
      };
      
      crawler.configure(config);
      
      // Base page with external links
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <body>
              <a href="https://example.com/internal">Internal</a>
              <a href="https://external.com/page">External</a>
            </body>
          </html>
        `,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      // Internal page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body><p>Internal Page</p></body></html>`,
        headers: new Map([
          ['content-type', 'text/html'],
          ['last-modified', '2025-01-01T00:00:00Z']
        ]),
      });
      
      await crawler.crawl(['https://example.com']);
      
      const pendingUrls = crawler.getPendingUrls();
      
      expect(pendingUrls).toContain('https://external.com/page');
      expect(pendingUrls).not.toContain('https://example.com/internal');
    });
  });
});
