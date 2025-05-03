import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebsiteProvider } from '../../../src/providers/website';
import { RobotsChecker } from '../../../src/providers/website/robotsChecker';
import { WebsiteCrawler } from '../../../src/providers/website/websiteCrawler';
import { ContentExtractor } from '../../../src/providers/website/contentExtractor';

// Mock dependencies
vi.mock('@dome/common', () => ({
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

// Create mock implementations
const mockRobotsChecker = {
  initialize: vi.fn().mockResolvedValue(undefined),
  isAllowed: vi.fn().mockReturnValue(true),
};

const mockCrawler = {
  configure: vi.fn(),
  crawl: vi.fn().mockResolvedValue([
      {
        url: 'https://example.com',
        title: 'Example Domain',
        content: '<html><body><h1>Example Domain</h1><p>Test content</p></body></html>',
        links: ['https://example.com/page1', 'https://example.com/page2'],
        lastModified: '2025-01-01T00:00:00Z',
        contentType: 'text/html',
        statusCode: 200,
        size: 100,
      }
    ]),
  getPendingUrls: vi.fn().mockReturnValue(['https://example.com/page3']),
};

const mockContentExtractor = {
  extract: vi.fn().mockImplementation((html) => 'Extracted content from ' + html.substring(0, 20)),
};

// Mock the modules
vi.mock('../../../src/providers/website/robotsChecker', () => ({
  RobotsChecker: vi.fn().mockImplementation(() => mockRobotsChecker),
}));

vi.mock('../../../src/providers/website/websiteCrawler', () => ({
  WebsiteCrawler: vi.fn().mockImplementation(() => mockCrawler),
}));

vi.mock('../../../src/providers/website/contentExtractor', () => ({
  ContentExtractor: vi.fn().mockImplementation(() => mockContentExtractor),
}));

vi.mock('../../../src/services/metadataHeaderService', () => ({
  createWebsiteMetadata: vi.fn().mockReturnValue({
    source: {
      type: 'website',
      base_url: 'https://example.com',
      page_url: 'https://example.com',
      title: 'Example Domain',
      updated_at: '2025-01-01T00:00:00Z',
    },
    content: {
      type: 'document',
      language: 'html',
      size_bytes: 100,
    },
    ingestion: {
      timestamp: '2025-01-01T00:00:00Z',
      version: '1.0',
      request_id: 'test-request-id',
    },
  }),
  injectMetadataHeader: vi.fn().mockImplementation((content, metadata) => 
    `---METADATA---\n${JSON.stringify(metadata, null, 2)}\n---END-METADATA---\n\n${content}`
  ),
}));

describe('WebsiteProvider', () => {
  let provider: WebsiteProvider;
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {};
    provider = new WebsiteProvider(mockEnv);
    
    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initialization', () => {
    it('should create an instance of WebsiteProvider', () => {
      expect(provider).toBeInstanceOf(WebsiteProvider);
    });

    it('should initialize dependencies', () => {
      expect(RobotsChecker).toHaveBeenCalled();
      expect(WebsiteCrawler).toHaveBeenCalled();
      expect(ContentExtractor).toHaveBeenCalled();
    });
  });

  describe('pull', () => {
    it('should throw an error for invalid resourceId', async () => {
      await expect(provider.pull({
        resourceId: 'invalid-json',
        cursor: null,
      })).rejects.toThrow('Invalid resourceId for website provider');
    });

    it('should throw an error if URL is missing', async () => {
      await expect(provider.pull({
        resourceId: '{}',
        cursor: null,
      })).rejects.toThrow('Website configuration must include a URL');
    });

    it('should successfully pull content from a website', async () => {
      const result = await provider.pull({
        resourceId: JSON.stringify({ url: 'https://example.com' }),
        cursor: null,
      });

      // Check the crawler was configured
      expect(mockCrawler.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://example.com',
        })
      );

      // Check the crawler was called
      expect(mockCrawler.crawl).toHaveBeenCalled();

      // Check returned results
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toMatchObject({
        category: 'document',
        mimeType: 'text/html',
        metadata: {
          baseUrl: 'https://example.com',
          url: 'https://example.com',
          title: 'Example Domain',
          lastModified: '2025-01-01T00:00:00Z',
        },
      });

      // Check cursor is set
      expect(result.newCursor).toBeTruthy();
      expect(JSON.parse(result.newCursor!)).toMatchObject({
        lastCrawl: expect.any(String),
        crawledUrls: ['https://example.com'],
      });
    });

    it('should handle an empty result from crawler', async () => {
      // Override mock to return empty array
      mockCrawler.crawl.mockResolvedValueOnce([]);

      const result = await provider.pull({
        resourceId: JSON.stringify({ url: 'https://example.com' }),
        cursor: null,
      });

      expect(result.contents).toHaveLength(0);
      expect(result.newCursor).toBeTruthy();
    });

    it('should handle a cursor with previous crawl data', async () => {
      const previousCursor = JSON.stringify({
        lastCrawl: '2025-01-01T00:00:00Z',
        crawledUrls: ['https://example.com/old-page'],
      });

      const result = await provider.pull({
        resourceId: JSON.stringify({ url: 'https://example.com' }),
        cursor: previousCursor,
      });

      // Check cursor includes both old and new URLs
      expect(result.newCursor).toBeTruthy();
      const cursorData = JSON.parse(result.newCursor!);
      expect(cursorData.crawledUrls).toContain('https://example.com/old-page');
      expect(cursorData.crawledUrls).toContain('https://example.com');
    });

    it('should respect robots.txt if enabled', async () => {
      await provider.pull({
        resourceId: JSON.stringify({ 
          url: 'https://example.com',
          respectRobotsTxt: true
        }),
        cursor: null,
      });

      // Check the robots checker was initialized
      expect(mockRobotsChecker.initialize).toHaveBeenCalledWith(
        'https://example.com'
      );
    });

    it('should propagate crawler errors', async () => {
      // Override mock to throw an error
      mockCrawler.crawl.mockRejectedValueOnce(
        new Error('Network error')
      );

      await expect(provider.pull({
        resourceId: JSON.stringify({ url: 'https://example.com' }),
        cursor: null,
      })).rejects.toThrow('Network error');
    });
  });
});
