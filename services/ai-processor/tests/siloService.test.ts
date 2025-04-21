import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiloService } from '../src/services/siloService';

// Mock the logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  metrics: {
    increment: vi.fn(),
    timing: vi.fn(),
  },
}));

describe('SiloService', () => {
  let siloService: SiloService;
  const mockSilo = {
    batchGet: vi.fn(),
  };

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Create a new instance for each test
    siloService = new SiloService(mockSilo as any);
    
    // Default mock implementation for batchGet
    mockSilo.batchGet.mockResolvedValue({
      items: [
        {
          id: 'test-id',
          userId: 'test-user',
          contentType: 'note',
          size: 100,
          createdAt: 1234567890,
          body: 'Test content body',
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });
  });

  describe('fetchContent', () => {
    it('should fetch content from Silo successfully', async () => {
      const result = await siloService.fetchContent('test-id', 'test-user');
      
      // Check that Silo was called with the right parameters
      expect(mockSilo.batchGet).toHaveBeenCalledWith({
        ids: ['test-id'],
        userId: 'test-user',
      });
      
      // Check that the result is the content body
      expect(result).toBe('Test content body');
    });

    it('should throw an error if content is not found', async () => {
      // Mock Silo to return empty items
      mockSilo.batchGet.mockResolvedValue({
        items: [],
        total: 0,
        limit: 10,
        offset: 0,
      });
      
      // Check that the function throws an error
      await expect(siloService.fetchContent('test-id', 'test-user')).rejects.toThrow(
        'Content not found: test-id'
      );
    });

    it('should throw an error if content body is not available', async () => {
      // Mock Silo to return item without body
      mockSilo.batchGet.mockResolvedValue({
        items: [
          {
            id: 'test-id',
            userId: 'test-user',
            contentType: 'note',
            size: 100,
            createdAt: 1234567890,
            // No body property
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
      });
      
      // Check that the function throws an error
      await expect(siloService.fetchContent('test-id', 'test-user')).rejects.toThrow(
        'Content body not available for: test-id'
      );
    });

    it('should handle URL availability when body is not available', async () => {
      // Mock Silo to return item with URL but no body
      mockSilo.batchGet.mockResolvedValue({
        items: [
          {
            id: 'test-id',
            userId: 'test-user',
            contentType: 'note',
            size: 100,
            createdAt: 1234567890,
            url: 'https://example.com/content',
            // No body property
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
      });
      
      // Check that the function throws an error mentioning URL
      await expect(siloService.fetchContent('test-id', 'test-user')).rejects.toThrow(
        'Content body not available for: test-id (URL available)'
      );
    });

    it('should handle Silo API errors', async () => {
      // Mock Silo to throw an error
      mockSilo.batchGet.mockRejectedValue(new Error('Silo API error'));
      
      // Check that the function throws the same error
      await expect(siloService.fetchContent('test-id', 'test-user')).rejects.toThrow(
        'Silo API error'
      );
    });
  });
});