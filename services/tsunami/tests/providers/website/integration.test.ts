import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebsiteProvider } from '../../../src/providers/website';
import { startMockServer, stopMockServer, getMockServerUrl } from './mockServer';

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  metrics: {
    timing: vi.fn(),
    increment: vi.fn(),
  },
}));

describe('WebsiteProvider Integration Tests', () => {
  let provider: WebsiteProvider;
  let mockEnv: any;
  let mockServerUrl: string;

  beforeAll(async () => {
    // Start mock server
    await startMockServer();
    mockServerUrl = getMockServerUrl();
  });

  afterAll(async () => {
    // Stop mock server
    await stopMockServer();
  });

  beforeEach(() => {
    mockEnv = {};
    provider = new WebsiteProvider(mockEnv);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('basic crawling', () => {
    it('should successfully crawl a simple website', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/simple-site`,
        crawlDepth: 2,
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should have crawled the main page and linked pages
      expect(result.contents.length).toBeGreaterThan(0);
      
      // Check that the main page was crawled
      const mainPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/simple-site`
      );
      expect(mainPage).toBeDefined();
      expect(mainPage?.content).toContain('Simple Site Home Page');
      
      // Check that linked pages were crawled
      const aboutPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/simple-site/about`
      );
      expect(aboutPage).toBeDefined();
      expect(aboutPage?.content).toContain('About Page');
      
      // Check cursor was created
      expect(result.newCursor).toBeTruthy();
      const cursor = JSON.parse(result.newCursor!);
      expect(cursor.lastCrawl).toBeDefined();
      expect(cursor.crawledUrls).toContain(`${mockServerUrl}/simple-site`);
    });

    it('should respect robots.txt directives', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/with-robots`,
        respectRobotsTxt: true,
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should have crawled allowed pages but not disallowed ones
      const adminPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/with-robots/admin`
      );
      expect(adminPage).toBeUndefined();
      
      const publicPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/with-robots/public`
      );
      expect(publicPage).toBeDefined();
    });

    it('should extract content correctly from different page structures', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/content-extraction`,
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Check content from page with main tag
      const mainTagPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/content-extraction/main-tag`
      );
      expect(mainTagPage).toBeDefined();
      expect(mainTagPage?.content).toContain('Main Tag Content');
      expect(mainTagPage?.content).not.toContain('Header Content');
      expect(mainTagPage?.content).not.toContain('Footer Content');
      
      // Check content from page with article tag
      const articleTagPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/content-extraction/article-tag`
      );
      expect(articleTagPage).toBeDefined();
      expect(articleTagPage?.content).toContain('Article Tag Content');
      expect(articleTagPage?.content).not.toContain('Navigation Content');
      
      // Check content from page with content class
      const contentClassPage = result.contents.find(
        content => content.metadata.url === `${mockServerUrl}/content-extraction/content-class`
      );
      expect(contentClassPage).toBeDefined();
      expect(contentClassPage?.content).toContain('Content Class Content');
      expect(contentClassPage?.content).not.toContain('Sidebar Content');
    });
  });

  describe('incremental syncing', () => {
    it('should only crawl new or updated pages when using cursor', async () => {
      // First crawl to establish baseline
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/incremental`,
      });

      const firstResult = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should have crawled all pages
      expect(firstResult.contents.length).toBeGreaterThan(1);
      
      // Second crawl with cursor
      const secondResult = await provider.pull({
        resourceId,
        cursor: firstResult.newCursor,
      });
      
      // Should not have crawled any pages since nothing changed
      expect(secondResult.contents.length).toBe(0);
      
      // Third crawl after "updating" a page on the mock server
      // This is simulated by the mock server based on a query parameter
      const resourceIdWithUpdate = JSON.stringify({
        url: `${mockServerUrl}/incremental?update=true`,
      });
      
      const thirdResult = await provider.pull({
        resourceId: resourceIdWithUpdate,
        cursor: secondResult.newCursor,
      });
      
      // Should have crawled only the updated page
      expect(thirdResult.contents.length).toBe(1);
      expect(thirdResult.contents[0].metadata.url).toBe(`${mockServerUrl}/incremental/updated-page`);
    });
  });

  describe('error handling', () => {
    it('should handle pages with malformed HTML', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/error-cases/malformed-html`,
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should still extract some content despite malformed HTML
      expect(result.contents.length).toBe(1);
      expect(result.contents[0].content).toContain('Malformed HTML Page');
    });

    it('should handle pages with invalid robots.txt', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/error-cases/invalid-robots`,
        respectRobotsTxt: true,
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should default to allowing all URLs when robots.txt is invalid
      expect(result.contents.length).toBeGreaterThan(0);
    });

    it('should handle rate limiting by respecting delayMs', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/rate-limited`,
        delayMs: 500, // Set a delay to avoid rate limiting
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should successfully crawl all pages with the delay
      expect(result.contents.length).toBeGreaterThan(1);
    });
  });

  describe('blog platform handling', () => {
    it('should extract content from WordPress-style pages', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/blog-platforms/wordpress`,
        urlPatterns: [
          `^${mockServerUrl}/blog-platforms/wordpress/\\d{4}/\\d{2}/.*`, // Post permalinks
          `^${mockServerUrl}/blog-platforms/wordpress/category/.*`,      // Category pages
        ],
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should have crawled WordPress posts matching the patterns
      const wordpressPost = result.contents.find(
        content => content.metadata.url.includes('/2025/01/')
      );
      expect(wordpressPost).toBeDefined();
      expect(wordpressPost?.content).toContain('WordPress Post Content');
      
      // Should have crawled category pages
      const categoryPage = result.contents.find(
        content => content.metadata.url.includes('/category/')
      );
      expect(categoryPage).toBeDefined();
    });

    it('should extract content from Medium-style pages', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/blog-platforms/medium`,
        urlPatterns: [
          `^${mockServerUrl}/blog-platforms/medium/[\\w-]+-[a-f0-9]{12}$` // Article pages
        ],
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should have crawled Medium posts matching the pattern
      const mediumPost = result.contents.find(
        content => /[a-f0-9]{12}$/.test(content.metadata.url)
      );
      expect(mediumPost).toBeDefined();
      expect(mediumPost?.content).toContain('Medium Post Content');
    });

    it('should extract content from Ghost-style pages', async () => {
      const resourceId = JSON.stringify({
        url: `${mockServerUrl}/blog-platforms/ghost`,
        urlPatterns: [
          `^${mockServerUrl}/blog-platforms/ghost/[\\w-]+/$` // Post pages
        ],
      });

      const result = await provider.pull({
        resourceId,
        cursor: null,
      });

      // Should have crawled Ghost posts matching the pattern
      const ghostPost = result.contents.find(
        content => /[\w-]+\/$/.test(content.metadata.url)
      );
      expect(ghostPost).toBeDefined();
      expect(ghostPost?.content).toContain('Ghost Post Content');
    });
  });
});