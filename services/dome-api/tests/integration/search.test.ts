import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { SearchController } from '../../src/controllers/searchController';
import { searchService, PaginatedSearchResults } from '../../src/services/searchService';

// Mock dependencies
vi.mock('../../src/services/searchService', () => ({
  searchService: {
    search: vi.fn(),
  },
  PaginatedSearchResults: vi.fn(),
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

describe('Search API Integration', () => {
  // Create a test app
  let app: Hono;

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
  const mockSearchResults: PaginatedSearchResults = {
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

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a new Hono app for each test
    app = new Hono();
    
    // Add middleware to set userId
    app.use('*', async (c, next) => {
      (c as any).set('userId', mockUserId);
      await next();
    });
    
    // Add routes
    app.get('/search', SearchController.search);
    app.get('/search/stream', SearchController.streamSearch);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /search', () => {
    it('should return search results successfully', async () => {
      // Arrange
      vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);

      // Create a test request
      const req = new Request('http://localhost/search?q=test+query&limit=10&offset=0', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toEqual({
        success: true,
        results: mockSearchResults.results,
        pagination: mockSearchResults.pagination,
        query: mockSearchResults.query,
      });

      // Verify service was called with correct parameters
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
          limit: 10,
          offset: 0,
        }),
      );
    });

    it('should return empty results for short queries', async () => {
      // Arrange
      // Create a test request with a short query
      const req = new Request('http://localhost/search?q=ab', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.results).toEqual([]);
      expect(data.message).toContain('Use at least 3 characters');

      // Verify service was not called
      expect(searchService.search).not.toHaveBeenCalled();
    });

    it('should handle validation errors', async () => {
      // Arrange
      // Create a test request without required query parameter
      const req = new Request('http://localhost/search', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle service errors', async () => {
      // Arrange
      vi.mocked(searchService.search).mockRejectedValue(new Error('Search service error'));

      // Create a test request
      const req = new Request('http://localhost/search?q=test+query', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(500);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('SEARCH_ERROR');
    });
  });

  describe('GET /search/stream', () => {
    it('should stream search results successfully', async () => {
      // Arrange
      vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);

      // Mock TransformStream
      const mockWriter = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockReadable = {};
      
      (global as any).TransformStream = vi.fn().mockImplementation(() => ({
        readable: mockReadable,
        writable: {
          getWriter: () => mockWriter,
        },
      }));

      // Mock TextEncoder
      (global as any).TextEncoder = vi.fn().mockImplementation(() => ({
        encode: (text: string) => new Uint8Array(Buffer.from(text)),
      }));

      // Create a test request
      const req = new Request('http://localhost/search/stream?q=test+query&limit=10&offset=0', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');

      // Verify service was called with correct parameters
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
          limit: 10,
          offset: 0,
        }),
      );

      // Wait for the async function inside streamSearch to complete
      await new Promise(resolve => setTimeout(resolve, 0));

      // Verify the writer was used to write metadata and results
      expect(mockWriter.write).toHaveBeenCalledTimes(3); // Metadata + 2 results
      expect(mockWriter.close).toHaveBeenCalled();
    });

    it('should return empty results for short queries', async () => {
      // Arrange
      // Create a test request with a short query
      const req = new Request('http://localhost/search/stream?q=ab', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.results).toEqual([]);
      expect(data.message).toContain('Use at least 3 characters');

      // Verify service was not called
      expect(searchService.search).not.toHaveBeenCalled();
    });

    it('should handle validation errors', async () => {
      // Arrange
      // Create a test request without required query parameter
      const req = new Request('http://localhost/search/stream', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle service errors during streaming', async () => {
      // Arrange
      vi.mocked(searchService.search).mockRejectedValue(new Error('Search service error'));

      // Mock TransformStream
      const mockWriter = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockReadable = {};
      
      (global as any).TransformStream = vi.fn().mockImplementation(() => ({
        readable: mockReadable,
        writable: {
          getWriter: () => mockWriter,
        },
      }));

      // Mock TextEncoder
      (global as any).TextEncoder = vi.fn().mockImplementation(() => ({
        encode: (text: string) => new Uint8Array(Buffer.from(text)),
      }));

      // Create a test request
      const req = new Request('http://localhost/search/stream?q=test+query', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');

      // Wait for the async function inside streamSearch to complete
      await new Promise(resolve => setTimeout(resolve, 0));

      // Verify the writer was used to write the error
      expect(mockWriter.write).toHaveBeenCalledWith(
        expect.any(Uint8Array)
      );
      expect(mockWriter.close).toHaveBeenCalled();
    });
  });
});