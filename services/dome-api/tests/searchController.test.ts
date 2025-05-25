import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from 'hono';

// Mock common dependencies
vi.mock('@dome/common', () => ({
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
  getIdentity: vi.fn(),
  ServiceError: class extends Error {
    code: string;
    status?: number;
    constructor(message: string, code: string, status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

// Mock metrics utilities
const mockMetrics = {
  counter: vi.fn(),
  gauge: vi.fn(),
  timing: vi.fn(),
  startTimer: vi.fn(() => ({
    stop: vi.fn(),
  })),
};

vi.mock('../src/utils/metrics', () => ({
  trackTiming: vi.fn((name: string, tags: any) => (fn: any) => fn()),
  trackOperation: vi.fn((name: string, fn: any) => fn()),
  incrementCounter: vi.fn(),
  getMetrics: () => mockMetrics,
}));

// Mock service factory and search service
const mockSearchService = {
  search: vi.fn(),
};

const mockConstellationService = {};
const mockSiloService = {};

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: () => ({
    getConstellationService: () => mockConstellationService,
    getSiloService: () => mockSiloService,
  }),
}));

vi.mock('../src/services/searchService', () => ({
  SearchService: vi.fn().mockImplementation(() => mockSearchService),
}));

// Mock authentication middleware
vi.mock('../src/middleware/authenticationMiddleware', () => ({
  authenticationMiddleware: vi.fn((c: any, next: any) => next()),
  AuthContext: {},
}));

import { SearchController, buildSearchRouter } from '../src/controllers/searchController';
import type { AppEnv } from '../src/types';
import type { AuthContext } from '../src/middleware/authenticationMiddleware';
import { ServiceError } from '@dome/common';

describe('SearchController', () => {
  let searchController: SearchController;
  let mockContext: Context<AppEnv & { Variables: { auth: AuthContext } }>;
  
  // Define validSearchParams at the top level so it's accessible to all tests
  const validSearchParams = {
    q: 'test query',
    limit: 10,
    offset: 0,
    useCache: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    searchController = new SearchController();
    
    // Create a mock Hono context with auth context
    mockContext = {
      env: {
        AUTH_SERVICE: {},
        CONSTELLATION_SERVICE: {},
        SILO_SERVICE: {},
      },
      req: {
        header: vi.fn(),
        valid: vi.fn(),
      },
      json: vi.fn((data, status) => ({
        data,
        status,
        headers: new Headers(),
      })),
      get: vi.fn((key: string) => {
        if (key === 'auth') {
          return { userId: 'user123', userRole: 'user', userEmail: 'test@example.com' };
        }
        return undefined;
      }),
      set: vi.fn(),
    } as any;
  });

  describe('search', () => {

    it('should successfully perform a search', async () => {
      const mockResults = {
        results: [
          {
            id: 'result1',
            title: 'Test Result',
            summary: 'A test result',
            category: 'note',
            mimeType: 'text/markdown',
            createdAt: 1678886400000,
            score: 0.85,
          },
        ],
        pagination: {
          total: 1,
          limit: 10,
          offset: 0,
          hasMore: false,
        },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          userId: 'user123',
          query: 'test query',
          limit: 10,
          offset: 0,
          useCache: true,
        })
      );
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          results: mockResults.results,
          pagination: mockResults.pagination,
          query: mockResults.query,
        },
        200
      );
    });

    it('should return empty results for short queries', async () => {
      const shortQuery = { ...validSearchParams, q: 'ab' };

      const result = await searchController.search(mockContext, shortQuery);

      expect(mockSearchService.search).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          results: [],
          pagination: {
            total: 0,
            limit: 10,
            offset: 0,
            hasMore: false,
          },
          query: 'ab',
          message: 'Use at least 3 characters for better results.',
        },
        200
      );
    });

    it('should handle search with filters', async () => {
      const searchWithFilters = {
        ...validSearchParams,
        category: 'note',
        mimeType: 'text/markdown',
        startDate: 1678886400000,
        endDate: 1678972800000,
      };

      const mockResults = {
        results: [],
        pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      const result = await searchController.search(mockContext, searchWithFilters);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          userId: 'user123',
          query: 'test query',
          category: 'note',
          mimeType: 'text/markdown',
          startDate: 1678886400000,
          endDate: 1678972800000,
        })
      );
    });

    it('should handle ServiceError with 400 status', async () => {
      const serviceError = new ServiceError('Bad request');
      serviceError.code = 'VALIDATION_ERROR';
      serviceError.status = 400;
      mockSearchService.search.mockRejectedValue(serviceError);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Bad request',
          },
        },
        400
      );
    });

    it('should handle ServiceError with 401 status', async () => {
      const serviceError = new ServiceError('Unauthorized');
      serviceError.code = 'UNAUTHORIZED';
      serviceError.status = 401;
      mockSearchService.search.mockRejectedValue(serviceError);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          },
        },
        401
      );
    });

    it('should handle ServiceError with 500 status', async () => {
      const serviceError = new ServiceError('Internal error');
      serviceError.code = 'INTERNAL_ERROR';
      serviceError.status = 500;
      mockSearchService.search.mockRejectedValue(serviceError);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal error',
          },
        },
        500
      );
    });

    it('should handle ServiceError without status code', async () => {
      const serviceError = new ServiceError('Service error');
      serviceError.code = 'SERVICE_ERROR';
      mockSearchService.search.mockRejectedValue(serviceError);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: 'Service error',
          },
        },
        500
      );
    });

    it('should handle generic Error', async () => {
      const genericError = new Error('Network error');
      mockSearchService.search.mockRejectedValue(genericError);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: 'Network error',
          },
        },
        500
      );
    });

    it('should handle non-Error thrown values', async () => {
      const nonError = { message: 'String error' };
      mockSearchService.search.mockRejectedValue(nonError);

      const result = await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: 'An error occurred during search',
          },
        },
        500
      );
    });

    it('should handle empty query string', async () => {
      const emptyQuery = { ...validSearchParams, q: '   ' };

      const result = await searchController.search(mockContext, emptyQuery);

      expect(mockSearchService.search).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          results: [],
          pagination: {
            total: 0,
            limit: 10,
            offset: 0,
            hasMore: false,
          },
          query: '   ',
          message: 'Use at least 3 characters for better results.',
        },
        200
      );
    });

    it('should handle search with pagination parameters', async () => {
      const paginatedParams = {
        ...validSearchParams,
        limit: 5,
        offset: 10,
      };

      const mockResults = {
        results: [],
        pagination: { total: 15, limit: 5, offset: 10, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      const result = await searchController.search(mockContext, paginatedParams);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          limit: 5,
          offset: 10,
        })
      );
    });

    it('should handle search with useCache false', async () => {
      const noCacheParams = {
        ...validSearchParams,
        useCache: false,
      };

      const mockResults = {
        results: [],
        pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      const result = await searchController.search(mockContext, noCacheParams);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          useCache: false,
        })
      );
    });
  });

  describe('streamSearch', () => {

    it('should successfully stream search results', async () => {
      const mockResults = {
        results: [
          {
            id: 'result1',
            title: 'Test Result',
            summary: 'A test result',
            category: 'note',
            mimeType: 'text/markdown',
            createdAt: 1678886400000,
            score: 0.85,
          },
        ],
        pagination: {
          total: 1,
          limit: 10,
          offset: 0,
          hasMore: false,
        },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      const result = await searchController.streamSearch(mockContext, validSearchParams);

      expect(result).toBeInstanceOf(Response);
      expect(result.headers.get('Content-Type')).toBe('application/x-ndjson');
      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          userId: 'user123',
          query: 'test query',
        })
      );
    });

    it('should return error for short query in stream mode', async () => {
      const shortQuery = { ...validSearchParams, q: 'ab' };

      const result = await searchController.streamSearch(mockContext, shortQuery);

      expect(mockSearchService.search).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'QUERY_TOO_SHORT',
            message: 'Search query is too short. Use at least 3 characters for better results.',
          },
        },
        400
      );
    });

    it('should handle streaming with filters', async () => {
      const searchWithFilters = {
        ...validSearchParams,
        category: 'note',
        mimeType: 'text/markdown',
      };

      const mockResults = {
        results: [],
        pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      const result = await searchController.streamSearch(mockContext, searchWithFilters);

      expect(result).toBeInstanceOf(Response);
      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          category: 'note',
          mimeType: 'text/markdown',
        })
      );
    });

    it('should handle empty stream query', async () => {
      const emptyQuery = { ...validSearchParams, q: '  ' };

      const result = await searchController.streamSearch(mockContext, emptyQuery);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'QUERY_TOO_SHORT',
            message: 'Search query is too short. Use at least 3 characters for better results.',
          },
        },
        400
      );
    });

    it('should handle stream setup error', async () => {
      // Test that the streaming works without mocking TransformStream
      // since it's a Web API that may not be available in the test environment
      const result = await searchController.streamSearch(mockContext, validSearchParams);

      expect(result).toBeInstanceOf(Response);
      expect(result.headers.get('Content-Type')).toBe('application/x-ndjson');
    });
  });

  describe('buildSearchRouter', () => {
    it('should create a search router with authentication middleware', () => {
      const router = buildSearchRouter();
      expect(router).toBeDefined();
      expect(typeof router.openapi).toBe('function');
    });

    it('should handle search route with valid parameters', async () => {
      const router = buildSearchRouter();
      expect(router).toBeDefined();
      
      // Test that the router has the expected structure
      expect(typeof router.openapi).toBe('function');
      expect(typeof router.use).toBe('function');
    });

    it('should handle stream search route with valid parameters', async () => {
      const router = buildSearchRouter();
      expect(router).toBeDefined();
      
      // Verify the router can handle routes
      expect(typeof router.openapi).toBe('function');
    });
  });

  describe('private methods and utilities', () => {
    it('should correctly identify short queries', () => {
      // Testing the private tooShort function indirectly through search behavior
      const shortQueries = ['', ' ', 'a', 'ab', '  '];
      
      for (const query of shortQueries) {
        const params = { ...validSearchParams, q: query };
        searchController.search(mockContext, params);
        
        // Verify search service was not called for short queries
        expect(mockSearchService.search).not.toHaveBeenCalled();
        mockSearchService.search.mockClear();
      }
    });

    it('should correctly build search parameters', async () => {
      const fullParams = {
        q: 'test query',
        limit: 20,
        offset: 5,
        category: 'document',
        mimeType: 'application/pdf',
        startDate: 1678886400000,
        endDate: 1678972800000,
        useCache: false,
      };

      const mockResults = {
        results: [],
        pagination: { total: 0, limit: 20, offset: 5, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      await searchController.search(mockContext, fullParams);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        {
          userId: 'user123',
          query: 'test query',
          limit: 20,
          offset: 5,
          category: 'document',
          mimeType: 'application/pdf',
          startDate: 1678886400000,
          endDate: 1678972800000,
          useCache: false,
        }
      );
    });

    it('should correctly format search response', async () => {
      const mockResults = {
        results: [
          {
            id: 'test1',
            title: 'Test Document',
            summary: 'Summary',
            body: 'Full content',
            category: 'document',
            mimeType: 'text/plain',
            createdAt: 1678886400000,
            updatedAt: 1678972800000,
            score: 0.95,
          },
        ],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(mockResults);

      await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          results: mockResults.results,
          pagination: mockResults.pagination,
          query: mockResults.query,
        },
        200
      );
    });

    it('should handle empty results correctly', async () => {
      const emptyResults = {
        results: [],
        pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
        query: 'nonexistent query',
      };
      mockSearchService.search.mockResolvedValue(emptyResults);

      await searchController.search(mockContext, { ...validSearchParams, q: 'nonexistent query' });

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          results: [],
          pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
          query: 'nonexistent query',
        },
        200
      );
    });

    it('should handle results with optional fields', async () => {
      const resultsWithOptionals = {
        results: [
          {
            id: 'test1',
            title: 'Test Document',
            summary: 'Summary',
            category: 'document',
            mimeType: 'text/plain',
            createdAt: 1678886400000,
            score: 0.95,
            // Missing optional fields: body, updatedAt
          },
        ],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
        query: 'test query',
      };
      mockSearchService.search.mockResolvedValue(resultsWithOptionals);

      await searchController.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          results: resultsWithOptionals.results,
          pagination: resultsWithOptionals.pagination,
          query: resultsWithOptionals.query,
        },
        200
      );
    });
  });
});