import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchController } from '../../src/controllers/searchController';
import { searchService, PaginatedSearchResults } from '../../src/services/searchService';
import { ServiceError } from '@dome/common';
import { z } from 'zod';

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

describe('SearchController', () => {
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

  // Create mock context
  const createMockContext = (query: Record<string, string> = {}) => {
    const mockJson = vi.fn();

    return {
      env: mockEnv,
      get: vi.fn().mockReturnValue(mockUserId),
      req: {
        query: vi.fn((key: string) => query[key] || ''),
      },
      json: mockJson,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('search', () => {
    it('should return search results successfully', async () => {
      // Arrange
      const mockContext = createMockContext({
        q: 'test query',
        limit: '10',
        offset: '0',
      });

      vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);

      // Act
      const response = await SearchController.search(mockContext as any);

      // Assert
      expect(searchService.search).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          query: 'test query',
          limit: 10,
          offset: 0,
        }),
      );

      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        results: mockSearchResults.results,
        pagination: mockSearchResults.pagination,
        query: mockSearchResults.query,
      });
    });

    it('should return empty results for short queries', async () => {
      // Arrange
      const mockContext = createMockContext({
        q: 'ab', // Less than 3 characters
      });

      // Act
      const response = await SearchController.search(mockContext as any);

      // Assert
      expect(searchService.search).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: [],
          pagination: expect.any(Object),
          message: expect.stringContaining('Use at least 3 characters'),
        }),
      );
    });

    it('should handle validation errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        // Missing required 'q' parameter
      });

      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['q'],
          message: 'Required',
        },
      ]);

      // Mock the parse method to throw a ZodError
      vi.spyOn(z.ZodObject.prototype, 'parse').mockImplementation(() => {
        throw zodError;
      });

      // Act
      const response = await SearchController.search(mockContext as any);

      // Assert
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid search parameters',
          details: expect.any(Array),
        },
      });
    });

    it('should handle service errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        q: 'test query',
      });

      const serviceError = new ServiceError('Search service error', {
        code: 'SEARCH_ERROR',
        status: 503,
      });
      vi.mocked(searchService.search).mockRejectedValue(serviceError);

      // Act
      const response = await SearchController.search(mockContext as any);

      // Assert
      expect(response.status).toBe(503);
      const responseBody = await response.json();
      expect(responseBody).toEqual({
        success: false,
        error: {
          code: 'SEARCH_ERROR',
          message: 'Search service error',
        },
      });
    });

    it('should handle generic errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        q: 'test query',
      });

      const error = new Error('Unexpected error');
      vi.mocked(searchService.search).mockRejectedValue(error);

      // Act
      const response = await SearchController.search(mockContext as any);

      // Assert
      expect(response.status).toBe(500);
      const responseBody = await response.json();
      expect(responseBody).toEqual({
        success: false,
        error: {
          code: 'SEARCH_ERROR',
          message: 'Unexpected error',
        },
      });
    });
  });

  describe('streamSearch', () => {
    it('should stream search results successfully', async () => {
      // Arrange
      const mockContext = createMockContext({
        q: 'test query',
        limit: '10',
        offset: '0',
      });

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

      // Act
      const response = await SearchController.streamSearch(mockContext as any);

      // Assert
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

      // Verify response
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
    });

    it('should handle errors during streaming setup', async () => {
      // Arrange
      const mockContext = createMockContext({
        // Missing required 'q' parameter
      });

      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['q'],
          message: 'Required',
        },
      ]);

      // Mock the parse method to throw a ZodError
      vi.spyOn(z.ZodObject.prototype, 'parse').mockImplementation(() => {
        throw zodError;
      });

      // Act
      const response = await SearchController.streamSearch(mockContext as any);

      // Assert
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid search parameters',
          details: expect.any(Array),
        },
      });
    });

    it('should handle errors during streaming', async () => {
      // Arrange
      const mockContext = createMockContext({
        q: 'test query',
      });

      const error = new Error('Search error during streaming');
      vi.mocked(searchService.search).mockRejectedValue(error);

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

      // Act
      const response = await SearchController.streamSearch(mockContext as any);

      // Assert
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');

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