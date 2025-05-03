import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RobotsChecker } from '../../../src/providers/website/robotsChecker';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('RobotsChecker', () => {
  let robotsChecker: RobotsChecker;
  const userAgent = 'TestBot/1.0';

  beforeEach(() => {
    robotsChecker = new RobotsChecker(userAgent);
    vi.clearAllMocks();
    
    // Default successful response
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initialization', () => {
    it('should create an instance with the provided user agent', () => {
      expect(robotsChecker).toBeInstanceOf(RobotsChecker);
    });

    it('should fetch and parse robots.txt on initialization', async () => {
      const baseUrl = 'https://example.com';
      const robotsTxt = `
        User-agent: *
        Disallow: /admin/
        Allow: /
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => robotsTxt,
      });
      
      await robotsChecker.initialize(baseUrl);
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/robots.txt',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': userAgent
          })
        })
      );
    });

    it('should handle 404 response for robots.txt by allowing all URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/any-path')).toBe(true);
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      
      await robotsChecker.initialize('https://example.com');
      
      // Should default to allowing all URLs on error
      expect(robotsChecker.isAllowed('https://example.com/any-path')).toBe(true);
    });
  });

  describe('isAllowed', () => {
    it('should allow URLs not explicitly disallowed', async () => {
      const robotsTxt = `
        User-agent: *
        Disallow: /admin/
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => robotsTxt,
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/public')).toBe(true);
    });

    it('should disallow URLs matching disallow rules', async () => {
      const robotsTxt = `
        User-agent: *
        Disallow: /admin/
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => robotsTxt,
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/admin/settings')).toBe(false);
    });

    it('should handle wildcard patterns in rules', async () => {
      const robotsTxt = `
        User-agent: *
        Disallow: /*.pdf$
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => robotsTxt,
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/document.pdf')).toBe(false);
      expect(robotsChecker.isAllowed('https://example.com/document.pdf?view=1')).toBe(true);
    });

    it('should prioritize specific user agent rules over wildcard rules', async () => {
      const robotsTxt = `
        User-agent: *
        Disallow: /private/

        User-agent: TestBot
        Allow: /private/public
        Disallow: /private/
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => robotsTxt,
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/private/secret')).toBe(false);
      expect(robotsChecker.isAllowed('https://example.com/private/public')).toBe(true);
    });

    it('should default to allowing URLs when not initialized', () => {
      expect(robotsChecker.isAllowed('https://example.com/any-path')).toBe(true);
    });
  });

  describe('robots.txt parsing', () => {
    it('should handle empty robots.txt', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/any-path')).toBe(true);
    });

    it('should handle malformed robots.txt', async () => {
      const malformedRobotsTxt = `
        This is not a valid robots.txt file
        It has no proper directives
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => malformedRobotsTxt,
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/any-path')).toBe(true);
    });

    it('should handle comments in robots.txt', async () => {
      const robotsTxtWithComments = `
        # This is a comment
        User-agent: * # This applies to all bots
        Disallow: /admin/ # Don't crawl admin
      `;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => robotsTxtWithComments,
      });
      
      await robotsChecker.initialize('https://example.com');
      
      expect(robotsChecker.isAllowed('https://example.com/admin/settings')).toBe(false);
    });
  });
});