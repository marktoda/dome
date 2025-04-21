import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchController } from '../../src/controllers/searchController';
import { searchService } from '../../src/services/searchService';
import { constellationService } from '../../src/services/constellationService';

// Mock dependencies
vi.mock('../../src/services/searchService', () => ({
  searchService: {
    search: vi.fn(),
  },
}));

vi.mock('../../src/services/constellationService', () => ({
  constellationService: {
    searchNotes: vi.fn(),
  },
}));

// Mock logger
vi.mock('@dome/logging', () => {
  // Define the logger type to avoid TypeScript errors
  type MockLogger = {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
  };

  const mockLogger: MockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => mockLogger),
  };

  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    metrics: {
      increment: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({
        stop: vi.fn(),
      })),
    },
  };
});

describe('Search API Integration Tests', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Mock search results
  const mockSearchResults = {
    results: [
      {
        id: 'note-123',
        title: 'Test Note',
        summary: 'Test note summary',
        body: 'This is a test note',
        score: 0.95,
        createdAt: 1617235678000,
        updatedAt: 1617235678000,
        category: 'note',
        mimeType: 'text/plain',
      },
      {
        id: 'note-456',
        title: 'Another Test Note',
        summary: 'Another test note summary',
        body: 'This is another test note',
        score: 0.85,
        createdAt: 1617235679000,
        updatedAt: 1617235679000,
        category: 'note',
        mimeType: 'text/plain',
      },
    ],
    pagination: {
      total: 2,
      limit: 10,
      offset: 0,
      hasMore: false,
    },
    query: 'test query',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock searchService.search
    vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Search Controller', () => {
    it('should return search results successfully', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(name => (name === 'q' ? 'test query' : null)),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        json: vi.fn(),
      };

      // Call the search controller
      await searchController.search(mockContext as any);

      // Verify the response
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
        }),
      );
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        results: mockSearchResults.results,
        pagination: mockSearchResults.pagination,
        query: mockSearchResults.query,
      });
    });

    it('should return 400 when query is too short', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(name => (name === 'q' ? 'ab' : null)),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        json: vi.fn(),
      };

      // Call the search controller
      await searchController.search(mockContext as any);

      // Verify the response
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: [],
          message: expect.stringContaining('Use at least 3 characters'),
        }),
      );
      expect(searchService.search).not.toHaveBeenCalled();
    });

    it('should return 400 when query is missing', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(() => null), // No query
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Call the search controller
      await searchController.search(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(400);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('should return 401 when user ID is missing', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(name => (name === 'q' ? 'test query' : null)),
          header: vi.fn(() => null), // No user ID
        },
        env: mockEnv,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Call the search controller
      await searchController.search(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(401);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
        }),
      });
    });

    it('should handle service errors', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(name => (name === 'q' ? 'test query' : null)),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Mock service error
      vi.mocked(searchService.search).mockRejectedValue(new Error('Search service error'));

      // Call the search controller
      await searchController.search(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(500);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'SEARCH_ERROR',
        }),
      });
    });
  });

  describe('Stream Search Controller', () => {
    it('should return streaming search results with correct headers', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(name => (name === 'q' ? 'test query' : null)),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        set: vi.fn(),
        body: vi.fn(),
      };

      // Call the stream search controller
      await searchController.streamSearch(mockContext as any);

      // Verify the response
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
        }),
      );
      expect(mockContext.set).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
    });

    it('should return 400 when query is missing', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          query: vi.fn(() => null), // No query
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Call the stream search controller
      await searchController.streamSearch(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(400);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });
  });
});
