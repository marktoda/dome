import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IgnoreFileService } from '../../src/services/ignoreFileService';
import { DEFAULT_IGNORE_PATTERNS } from '../../src/config/defaultIgnorePatterns';
import { FilterConfig, DEFAULT_FILTER_CONFIG } from '../../src/config/filterConfig';

// Mock the global fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the atob function
global.atob = vi.fn((str) => Buffer.from(str, 'base64').toString('binary'));

// Mock the logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe('IgnoreFileService', () => {
  const mockGithubToken = 'test-token';
  let service: IgnoreFileService;
  let defaultConfig: FilterConfig;

  beforeEach(() => {
    defaultConfig = { ...DEFAULT_FILTER_CONFIG };
    service = new IgnoreFileService(mockGithubToken, defaultConfig);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getIgnorePatterns', () => {
    it('should return patterns from .tsunamiignore file when it exists', async () => {
      // Base64 encoded content for "node_modules/\n*.log\n# Comment\ndist/"
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          content: 'bm9kZV9tb2R1bGVzLwoqLmxvZwojIENvbW1lbnQKZGlzdC8='
        }),
        text: async () => ''
      };
      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await service.getIgnorePatterns('owner', 'repo');
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/contents/.tsunamiignore',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token'
          })
        })
      );
      expect(result).toEqual(['node_modules/', '*.log', 'dist/']);
    });

    it('should return default patterns when file is not found and useDefaultPatternsWhenNoIgnoreFile is true', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => ''
      };
      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await service.getIgnorePatterns('owner', 'repo');
      
      expect(result).toEqual(DEFAULT_IGNORE_PATTERNS);
    });

    it('should return empty array when file is not found and useDefaultPatternsWhenNoIgnoreFile is false', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => ''
      };
      mockFetch.mockResolvedValueOnce(mockResponse);

      // Create service with custom config
      const customConfig: Partial<FilterConfig> = {
        useDefaultPatternsWhenNoIgnoreFile: false
      };
      const customService = new IgnoreFileService(mockGithubToken, customConfig);

      const result = await customService.getIgnorePatterns('owner', 'repo');
      
      expect(result).toEqual([]);
    });

    it('should return empty array when filtering is disabled', async () => {
      // Create service with disabled filtering
      const customConfig: Partial<FilterConfig> = {
        enabled: false
      };
      const customService = new IgnoreFileService(mockGithubToken, customConfig);

      const result = await customService.getIgnorePatterns('owner', 'repo');
      
      // Should not call fetch when disabled
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should handle fetch errors and return default patterns when useDefaultPatternsWhenNoIgnoreFile is true', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.getIgnorePatterns('owner', 'repo');
      
      expect(result).toEqual(DEFAULT_IGNORE_PATTERNS);
    });

    it('should handle fetch errors and return empty array when useDefaultPatternsWhenNoIgnoreFile is false', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Create service with custom config
      const customConfig: Partial<FilterConfig> = {
        useDefaultPatternsWhenNoIgnoreFile: false
      };
      const customService = new IgnoreFileService(mockGithubToken, customConfig);

      const result = await customService.getIgnorePatterns('owner', 'repo');
      
      expect(result).toEqual([]);
    });

    it('should handle empty ignore file content', async () => {
      // Base64 encoded empty string
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          content: ''
        }),
        text: async () => ''
      };
      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await service.getIgnorePatterns('owner', 'repo');
      
      expect(result).toEqual([]);
    });

    it('should filter out comments and empty lines from ignore file', async () => {
      // Base64 encoded content for "node_modules/**\n\n# Comment\n\ndist/**"
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          content: 'bm9kZV9tb2R1bGVzLyoqCgojIENvbW1lbnQKCmRpc3QvKio='
        }),
        text: async () => ''
      };
      mockFetch.mockResolvedValueOnce(mockResponse);
      
      const result = await service.getIgnorePatterns('owner', 'repo');
      
      // We only care that the comments and empty lines were filtered out
      expect(result).toContain('node_modules/**');
      expect(result).toContain('dist/**');
      expect(result).not.toContain('# Comment');
    });

    it('should use custom ignore file name from config', async () => {
      // Create service with custom ignore file name
      const customConfig: Partial<FilterConfig> = {
        ignoreFileName: '.customignore'
      };
      const customService = new IgnoreFileService(mockGithubToken, customConfig);

      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          content: 'bm9kZV9tb2R1bGVzLw==' // "node_modules/" base64 encoded
        }),
        text: async () => ''
      };
      mockFetch.mockResolvedValueOnce(mockResponse);

      await customService.getIgnorePatterns('owner', 'repo');
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/contents/.customignore',
        expect.anything()
      );
    });

    it('should handle HTTP errors other than 404', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
        text: async () => 'Server Error'
      };
      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await service.getIgnorePatterns('owner', 'repo');
      
      // Should return default patterns when HTTP error occurs
      expect(result).toEqual(DEFAULT_IGNORE_PATTERNS);
    });
  });
});