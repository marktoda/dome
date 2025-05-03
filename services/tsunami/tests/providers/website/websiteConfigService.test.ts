import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebsiteConfigService } from '../../../src/providers/website/websiteConfigService';

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock DB client
const mockDbClient = {
  query: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../../../src/db/client', () => ({
  getDbClient: () => mockDbClient,
}));

describe('WebsiteConfigService', () => {
  let configService: WebsiteConfigService;

  beforeEach(() => {
    configService = new WebsiteConfigService();
    vi.clearAllMocks();
    
    // Default successful DB response
    mockDbClient.query.mockResolvedValue({ rows: [] });
    mockDbClient.execute.mockResolvedValue({ rowCount: 1 });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getConfig', () => {
    it('should retrieve configuration for a website', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const mockConfig = {
        url: 'https://example.com',
        crawlDepth: 3,
        respectRobotsTxt: true,
        delayMs: 2000,
        includeImages: false,
        includeScripts: false,
        includeStyles: false,
        followExternalLinks: false,
        urlPatterns: ['^https://example\\.com/blog/.*'],
      };
      
      mockDbClient.query.mockResolvedValueOnce({
        rows: [{ config: mockConfig }],
      });
      
      const result = await configService.getConfig(resourceId);
      
      expect(result).toEqual(mockConfig);
      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        expect.arrayContaining([resourceId])
      );
    });

    it('should return default configuration when no config exists', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      
      mockDbClient.query.mockResolvedValueOnce({
        rows: [],
      });
      
      const result = await configService.getConfig(resourceId);
      
      // Should return default config
      expect(result).toHaveProperty('url', 'https://example.com');
      expect(result).toHaveProperty('crawlDepth');
      expect(result).toHaveProperty('respectRobotsTxt');
      expect(result).toHaveProperty('delayMs');
    });

    it('should throw an error for invalid resourceId', async () => {
      const invalidResourceId = 'invalid-json';
      
      await expect(configService.getConfig(invalidResourceId)).rejects.toThrow('Invalid resourceId');
    });
  });

  describe('saveConfig', () => {
    it('should save configuration for a website', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const config = {
        url: 'https://example.com',
        crawlDepth: 3,
        respectRobotsTxt: true,
        delayMs: 2000,
      };
      
      await configService.saveConfig(resourceId, config);
      
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.arrayContaining([resourceId, expect.any(String)])
      );
    });

    it('should update existing configuration', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const config = {
        url: 'https://example.com',
        crawlDepth: 3,
      };
      
      // Mock that the config already exists
      mockDbClient.query.mockResolvedValueOnce({
        rows: [{ id: 1 }],
      });
      
      await configService.saveConfig(resourceId, config);
      
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.arrayContaining([expect.any(String), resourceId])
      );
    });

    it('should throw an error for invalid resourceId', async () => {
      const invalidResourceId = 'invalid-json';
      const config = {
        url: 'https://example.com',
      };
      
      await expect(configService.saveConfig(invalidResourceId, config)).rejects.toThrow('Invalid resourceId');
    });

    it('should validate configuration before saving', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const invalidConfig = {
        // Missing url
        crawlDepth: 3,
      };
      
      await expect(configService.saveConfig(resourceId, invalidConfig as any)).rejects.toThrow('Invalid configuration');
    });
  });

  describe('getCrawlState', () => {
    it('should retrieve crawl state for a website', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const mockState = {
        lastCrawl: '2025-01-01T00:00:00Z',
        crawledUrls: ['https://example.com', 'https://example.com/page1'],
        pendingUrls: ['https://example.com/page2'],
      };
      
      mockDbClient.query.mockResolvedValueOnce({
        rows: [{ state: mockState }],
      });
      
      const result = await configService.getCrawlState(resourceId);
      
      expect(result).toEqual(mockState);
      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        expect.arrayContaining([resourceId])
      );
    });

    it('should return null when no state exists', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      
      mockDbClient.query.mockResolvedValueOnce({
        rows: [],
      });
      
      const result = await configService.getCrawlState(resourceId);
      
      expect(result).toBeNull();
    });
  });

  describe('saveCrawlState', () => {
    it('should save crawl state for a website', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const state = {
        lastCrawl: '2025-01-01T00:00:00Z',
        crawledUrls: ['https://example.com', 'https://example.com/page1'],
        pendingUrls: ['https://example.com/page2'],
      };
      
      await configService.saveCrawlState(resourceId, state);
      
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.arrayContaining([resourceId, expect.any(String)])
      );
    });

    it('should update existing crawl state', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const state = {
        lastCrawl: '2025-01-01T00:00:00Z',
        crawledUrls: ['https://example.com'],
      };
      
      // Mock that the state already exists
      mockDbClient.query.mockResolvedValueOnce({
        rows: [{ id: 1 }],
      });
      
      await configService.saveCrawlState(resourceId, state);
      
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.arrayContaining([expect.any(String), resourceId])
      );
    });

    it('should merge with existing crawl state when specified', async () => {
      const resourceId = JSON.stringify({ url: 'https://example.com' });
      const existingState = {
        lastCrawl: '2025-01-01T00:00:00Z',
        crawledUrls: ['https://example.com'],
        pendingUrls: ['https://example.com/page1', 'https://example.com/page2'],
      };
      
      const newState = {
        lastCrawl: '2025-01-02T00:00:00Z',
        crawledUrls: ['https://example.com/page1'],
        pendingUrls: ['https://example.com/page3'],
      };
      
      // Mock that the state already exists
      mockDbClient.query.mockResolvedValueOnce({
        rows: [{ id: 1, state: existingState }],
      });
      
      await configService.saveCrawlState(resourceId, newState, true);
      
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.arrayContaining([
          expect.stringContaining('2025-01-02T00:00:00Z'), // New timestamp
          expect.stringContaining('example.com'), // Combined URLs
          expect.stringContaining('page1'),
          expect.stringContaining('page3'),
          resourceId
        ])
      );
    });
  });

  describe('getWebsitePatterns', () => {
    it('should return predefined patterns for common blog platforms', async () => {
      const wordpressPatterns = await configService.getWebsitePatterns('wordpress');
      const mediumPatterns = await configService.getWebsitePatterns('medium');
      const ghostPatterns = await configService.getWebsitePatterns('ghost');
      
      expect(wordpressPatterns).toBeInstanceOf(Array);
      expect(wordpressPatterns.length).toBeGreaterThan(0);
      expect(mediumPatterns).toBeInstanceOf(Array);
      expect(mediumPatterns.length).toBeGreaterThan(0);
      expect(ghostPatterns).toBeInstanceOf(Array);
      expect(ghostPatterns.length).toBeGreaterThan(0);
    });

    it('should return empty array for unknown platform', async () => {
      const patterns = await configService.getWebsitePatterns('unknown-platform');
      
      expect(patterns).toBeInstanceOf(Array);
      expect(patterns.length).toBe(0);
    });
  });

  describe('validateConfig', () => {
    it('should validate a valid configuration', () => {
      const validConfig = {
        url: 'https://example.com',
        crawlDepth: 3,
        respectRobotsTxt: true,
        delayMs: 2000,
      };
      
      expect(() => configService.validateConfig(validConfig)).not.toThrow();
    });

    it('should throw for missing URL', () => {
      const invalidConfig = {
        crawlDepth: 3,
      };
      
      expect(() => configService.validateConfig(invalidConfig as any)).toThrow('URL is required');
    });

    it('should throw for invalid URL', () => {
      const invalidConfig = {
        url: 'not-a-url',
        crawlDepth: 3,
      };
      
      expect(() => configService.validateConfig(invalidConfig)).toThrow('Invalid URL');
    });

    it('should throw for invalid crawl depth', () => {
      const invalidConfig = {
        url: 'https://example.com',
        crawlDepth: -1,
      };
      
      expect(() => configService.validateConfig(invalidConfig)).toThrow('Crawl depth must be non-negative');
    });

    it('should throw for invalid delay', () => {
      const invalidConfig = {
        url: 'https://example.com',
        delayMs: -100,
      };
      
      expect(() => configService.validateConfig(invalidConfig)).toThrow('Delay must be non-negative');
    });
  });
});