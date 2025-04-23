import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchController } from '../../src/controllers/searchController';
import { SearchService } from '../../src/services/searchService';
import { ConstellationService } from '../../src/services/constellationService';

// Mock dependencies
vi.mock('../../src/services/searchService', () => {
  return {
    SearchService: vi.fn().mockImplementation(() => {
      return {
        search: vi.fn(),
      };
    }),
  };
});

vi.mock('../../src/services/constellationService', () => {
  return {
    ConstellationService: vi.fn().mockImplementation(() => {
      return {
        searchNotes: vi.fn(),
      };
    }),
  };
});

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

  // Create mock instances
  let mockSearchService: SearchService;
  let mockConstellationService: ConstellationService;
  let controller: SearchController;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock instances
    mockConstellationService = new ConstellationService(null as any);
    mockSearchService = new SearchService(mockConstellationService, null as any);
    controller = new SearchController(mockSearchService);

    // Mock searchService.search
    vi.mocked(mockSearchService.search).mockResolvedValue(mockSearchResults);
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
      await controller.search(mockContext as any);

      // Verify the response
      expect(mockSearchService.search).toHaveBeenCalledWith(
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
      await controller.search(mockContext as any);

      // Verify the response
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: [],
          message: expect.stringContaining('Use at least 3 characters'),
        }),
      );
      expect(mockSearchService.search).not.toHaveBeenCalled();
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
      await controller.search(mockContext as any);

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
      await controller.search(mockContext as any);

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
      vi.mocked(mockSearchService.search).mockRejectedValue(new Error('Search service error'));

      // Call the search controller
      await controller.search(mockContext as any);

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
      await controller.streamSearch(mockContext as any);

      // Verify the response
      expect(mockSearchService.search).toHaveBeenCalledWith(
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
      await controller.streamSearch(mockContext as any);

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
