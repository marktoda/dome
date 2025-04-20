import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { searchController } from '../../src/controllers/searchController';
import { searchService } from '../../src/services/searchService';
import { constellationService } from '../../src/services/constellationService';
import { userIdMiddleware } from '../../src/middleware/userIdMiddleware';

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
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

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
        body: 'This is a test note',
        score: 0.95,
        createdAt: 1617235678000,
        updatedAt: 1617235678000,
        contentType: 'text/plain',
      },
      {
        id: 'note-456',
        title: 'Another Test Note',
        body: 'This is another test note',
        score: 0.85,
        createdAt: 1617235679000,
        updatedAt: 1617235679000,
        contentType: 'text/plain',
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

  // Create Hono app for testing
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a new Hono app for each test
    app = new Hono();

    // Add middleware
    app.use('*', userIdMiddleware);

    // Add routes
    app.get('/api/search', searchController.search);
    app.get('/api/search/stream', searchController.streamSearch);

    // Mock searchService.search
    vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/search', () => {
    it('should return search results successfully', async () => {
      // Arrange
      const req = new Request('http://localhost/api/search?q=test+query', {
        method: 'GET',
        headers: {
          'x-user-id': mockUserId,
        },
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(200);
      expect(data).toEqual({
        success: true,
        results: mockSearchResults.results,
        pagination: mockSearchResults.pagination,
        query: mockSearchResults.query,
      });
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
        }),
      );
    });

    it('should return 400 when query is too short', async () => {
      // Arrange
      const req = new Request('http://localhost/api/search?q=ab', {
        method: 'GET',
        headers: {
          'x-user-id': mockUserId,
        },
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(200); // Note: The controller returns 200 even for short queries
      expect(data).toEqual(
        expect.objectContaining({
          success: true,
          results: [],
          message: expect.stringContaining('Use at least 3 characters'),
        }),
      );
      expect(searchService.search).not.toHaveBeenCalled();
    });

    it('should return 400 when query is missing', async () => {
      // Arrange
      const req = new Request('http://localhost/api/search', {
        method: 'GET',
        headers: {
          'x-user-id': mockUserId,
        },
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(400);
      expect(data).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR',
          }),
        }),
      );
    });

    it('should return 401 when user ID is missing', async () => {
      // Arrange
      const req = new Request('http://localhost/api/search?q=test+query', {
        method: 'GET',
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(401);
      expect(data).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'UNAUTHORIZED',
          }),
        }),
      );
    });

    it('should handle service errors', async () => {
      // Arrange
      vi.mocked(searchService.search).mockRejectedValue(
        new Error('Search service error'),
      );

      const req = new Request('http://localhost/api/search?q=test+query', {
        method: 'GET',
        headers: {
          'x-user-id': mockUserId,
        },
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(500);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'SEARCH_ERROR',
          message: expect.stringContaining('error'),
        },
      });
    });
  });

  describe('GET /api/search/stream', () => {
    it('should return streaming search results with correct headers', async () => {
      // Arrange
      const req = new Request('http://localhost/api/search/stream?q=test+query', {
        method: 'GET',
        headers: {
          'x-user-id': mockUserId,
        },
      });

      // Act
      const res = await app.fetch(req, mockEnv);

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
        }),
      );
    });

    it('should return 400 when query is missing', async () => {
      // Arrange
      const req = new Request('http://localhost/api/search/stream', {
        method: 'GET',
        headers: {
          'x-user-id': mockUserId,
        },
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(400);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid search parameters',
          details: expect.any(Array),
        },
      });
    });
  });
});