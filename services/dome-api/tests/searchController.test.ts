import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Context } from 'hono';
import { SearchController } from '../src/controllers/searchController';
import { SearchService, PaginatedSearchResults } from '../src/services/searchService';
import { ServiceError } from '@dome/common';
import { AppEnv } from '../src/types';
import { AuthContext } from '../src/middleware/authenticationMiddleware';
import { z } from 'zod';

// Mock all external dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  getIdentity: vi.fn(),
  ServiceError: class ServiceError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
    ) {
      super(message);
      this.name = 'ServiceError';
    }
  },
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: () => ({
    getConstellationService: vi.fn(),
    getSiloService: vi.fn(),
  }),
}));

vi.mock('../src/services/searchService', () => ({
  SearchService: vi.fn().mockImplementation(() => ({
    search: vi.fn(),
  })),
}));

vi.mock('../src/utils/metrics', () => ({
  trackTiming: vi.fn((metricName: string, tags: any) => (fn: any) => fn()),
  trackOperation: vi.fn(),
  incrementCounter: vi.fn(),
  getMetrics: () => ({
    startTimer: vi.fn(() => ({
      stop: vi.fn(),
    })),
  }),
}));

// Mock ReadableStream and TransformStream for streaming tests
global.ReadableStream = class MockReadableStream {
  constructor(source?: any) {
    this.source = source;
  }
  source: any;
} as any;

global.TransformStream = class MockTransformStream {
  readable: any;
  writable: any;
  
  constructor() {
    this.writable = {
      getWriter: () => ({
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    };
    this.readable = new MockReadableStream();
  }
} as any;

global.TextEncoder = class MockTextEncoder {
  encode(input: string): Uint8Array {
    return new Uint8Array(Buffer.from(input));
  }
} as any;

describe('SearchController', () => {
  let controller: SearchController;
  let mockContext: Context<AppEnv & { Variables: { auth: AuthContext } }>;
  let mockSearchService: any;
  let mockServiceFactory: any;

  const createMockSearchResults = (): PaginatedSearchResults => ({
    results: [
      {
        id: 'result-1',
        title: 'Test Document 1',
        summary: 'This is a test document',
        body: 'Full content of the test document',
        category: 'note',
        mimeType: 'text/markdown',
        createdAt: 1678886400000,
        updatedAt: 1678886400000,
        score: 0.95,
      },
      {
        id: 'result-2',
        title: 'Test Document 2',
        summary: 'Another test document',
        body: 'Full content of another test document',
        category: 'document',
        mimeType: 'text/plain',
        createdAt: 1678886500000,
        updatedAt: 1678886500000,
        score: 0.87,
      },
    ],
    pagination: {
      total: 25,
      limit: 10,
      offset: 0,
      hasMore: true,
    },
    query: 'test query',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    
    controller = new SearchController();
    
    // Mock search service
    mockSearchService = {
      search: vi.fn(),
    };
    
    // Mock SearchService constructor
    vi.mocked(SearchService).mockImplementation(() => mockSearchService);

    // Mock service factory
    mockServiceFactory = require('../src/services/serviceFactory').createServiceFactory();

    // Mock Hono context
    mockContext = {
      env: {
        CONSTELLATION: {},
        SILO: {},
      },
      get: vi.fn((key: string) => {
        if (key === 'auth') {
          return { userId: 'test-user-123' };
        }
        return undefined;
      }),
      json: vi.fn(),
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('search', () => {
    const validSearchParams = {
      q: 'test query',
      limit: 10,
      offset: 0,
      useCache: true,
    };

    it('should perform search successfully', async () => {
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      mockContext.json.mockReturnValue({
        success: true,
        results: mockResults.results,
        pagination: mockResults.pagination,
        query: mockResults.query,
      });

      await controller.search(mockContext, validSearchParams);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        {
          userId: 'test-user-123',
          query: 'test query',
          limit: 10,
          offset: 0,
          useCache: true,
        }
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

    it('should handle search with filters', async () => {
      const paramsWithFilters = {
        ...validSearchParams,
        category: 'note',
        mimeType: 'text/markdown',
        startDate: 1678800000000,
        endDate: 1678900000000,
      };

      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.search(mockContext, paramsWithFilters);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        {
          userId: 'test-user-123',
          query: 'test query',
          limit: 10,
          offset: 0,
          useCache: true,
          category: 'note',
          mimeType: 'text/markdown',
          startDate: 1678800000000,
          endDate: 1678900000000,
        }
      );
    });

    it('should return empty results for short queries', async () => {
      const shortQueryParams = { ...validSearchParams, q: 'hi' };

      await controller.search(mockContext, shortQueryParams);

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
          query: 'hi',
          message: 'Use at least 3 characters for better results.',
        },
        200
      );
    });

    it('should handle empty search results', async () => {
      const emptyResults: PaginatedSearchResults = {
        results: [],
        pagination: {
          total: 0,
          limit: 10,
          offset: 0,
          hasMore: false,
        },
        query: 'test query',
      };
      
      mockSearchService.search.mockResolvedValue(emptyResults);

      await controller.search(mockContext, validSearchParams);

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
          query: 'test query',
        },
        200
      );
    });

    it('should handle Zod validation errors', async () => {
      const zodError = new z.ZodError([
        {
          path: ['q'],
          message: 'Search query is required',
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
        },
      ]);

      mockSearchService.search.mockRejectedValue(zodError);

      await controller.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search parameters',
            details: zodError.errors,
          },
        },
        400
      );
    });

    it('should handle ServiceError with specific status codes', async () => {
      const serviceError = new (require('@dome/common').ServiceError)(
        'Search service unavailable',
        'SERVICE_UNAVAILABLE',
        503
      );

      mockSearchService.search.mockRejectedValue(serviceError);

      await controller.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Search service unavailable',
          },
        },
        500 // Should default to 500 for non-400/401 status codes
      );
    });

    it('should handle ServiceError with 400 status', async () => {
      const serviceError = new (require('@dome/common').ServiceError)(
        'Invalid parameters',
        'INVALID_PARAMS',
        400
      );

      mockSearchService.search.mockRejectedValue(serviceError);

      await controller.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'Invalid parameters',
          },
        },
        400
      );
    });

    it('should handle ServiceError with 401 status', async () => {
      const serviceError = new (require('@dome/common').ServiceError)(
        'Unauthorized access',
        'UNAUTHORIZED',
        401
      );

      mockSearchService.search.mockRejectedValue(serviceError);

      await controller.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized access',
          },
        },
        401
      );
    });

    it('should handle generic errors', async () => {
      const genericError = new Error('Something went wrong');
      mockSearchService.search.mockRejectedValue(genericError);

      await controller.search(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: 'Something went wrong',
          },
        },
        500
      );
    });

    it('should handle non-Error objects', async () => {
      const nonErrorObject = { message: 'Not an error object' };
      mockSearchService.search.mockRejectedValue(nonErrorObject);

      await controller.search(mockContext, validSearchParams);

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

    it('should track metrics correctly', async () => {
      const { incrementCounter, trackTiming } = require('../src/utils/metrics');
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.search(mockContext, validSearchParams);

      expect(incrementCounter).toHaveBeenCalledWith('search.query', 1, {
        query_length: '10',
        has_filters: 'false',
      });
      
      expect(trackTiming).toHaveBeenCalledWith('search.execution', {
        query_length: '10',
        has_filters: 'false',
      });
      
      expect(incrementCounter).toHaveBeenCalledWith('search.results', 2, {
        has_results: 'true',
      });
    });
  });

  describe('streamSearch', () => {
    const validSearchParams = {
      q: 'test query',
      limit: 10,
      offset: 0,
      useCache: true,
    };

    it('should stream search results successfully', async () => {
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      const response = await controller.streamSearch(mockContext, validSearchParams);

      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        {
          userId: 'test-user-123',
          query: 'test query',
          limit: 10,
          offset: 0,
          useCache: true,
        }
      );
    });

    it('should handle streaming with filters', async () => {
      const paramsWithFilters = {
        ...validSearchParams,
        category: 'note',
        mimeType: 'text/markdown',
      };

      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.streamSearch(mockContext, paramsWithFilters);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        {
          userId: 'test-user-123',
          query: 'test query',
          limit: 10,
          offset: 0,
          useCache: true,
          category: 'note',
          mimeType: 'text/markdown',
        }
      );
    });

    it('should return error response for short queries', async () => {
      const shortQueryParams = { ...validSearchParams, q: 'hi' };

      mockContext.json.mockReturnValue({
        success: false,
        error: {
          code: 'QUERY_TOO_SHORT',
          message: 'Search query is too short. Use at least 3 characters for better results.',
        },
      });

      const response = await controller.streamSearch(mockContext, shortQueryParams);

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

    it('should handle Zod validation errors in stream setup', async () => {
      const zodError = new z.ZodError([
        {
          path: ['q'],
          message: 'Search query is required',
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
        },
      ]);

      // Mock the controller to throw during setup
      const originalGetSearchService = controller['getSearchService'];
      controller['getSearchService'] = () => {
        throw zodError;
      };

      const response = await controller.streamSearch(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search parameters',
            details: zodError.errors,
          },
        },
        400
      );

      // Restore original method
      controller['getSearchService'] = originalGetSearchService;
    });

    it('should handle generic errors in stream setup', async () => {
      const setupError = new Error('Setup failed');

      // Mock the controller to throw during setup
      const originalGetSearchService = controller['getSearchService'];
      controller['getSearchService'] = () => {
        throw setupError;
      };

      const response = await controller.streamSearch(mockContext, validSearchParams);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SEARCH_SETUP_ERROR',
            message: 'Setup failed',
          },
        },
        500
      );

      // Restore original method
      controller['getSearchService'] = originalGetSearchService;
    });

    it('should track streaming metrics correctly', async () => {
      const { incrementCounter, getMetrics } = require('../src/utils/metrics');
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.streamSearch(mockContext, validSearchParams);

      expect(incrementCounter).toHaveBeenCalledWith('search.stream_query', 1, {
        query_length: '10',
        has_filters: 'false',
      });
      
      expect(getMetrics).toHaveBeenCalled();
      expect(incrementCounter).toHaveBeenCalledWith('search.stream_results', 2, {
        has_results: 'true',
      });
    });

    it('should handle empty streaming results', async () => {
      const emptyResults: PaginatedSearchResults = {
        results: [],
        pagination: {
          total: 0,
          limit: 10,
          offset: 0,
          hasMore: false,
        },
        query: 'test query',
      };
      
      mockSearchService.search.mockResolvedValue(emptyResults);

      const response = await controller.streamSearch(mockContext, validSearchParams);

      expect(response).toBeInstanceOf(Response);
      expect(require('../src/utils/metrics').incrementCounter).toHaveBeenCalledWith(
        'search.stream_results',
        0,
        { has_results: 'false' }
      );
    });
  });

  describe('getSearchService', () => {
    it('should create SearchService with correct dependencies', () => {
      const mockEnv = {
        CONSTELLATION: {},
        SILO: {},
      };

      const searchService = controller['getSearchService'](mockEnv);

      expect(SearchService).toHaveBeenCalledWith(
        expect.anything(), // constellation client
        expect.anything()  // silo client
      );
    });
  });

  describe('edge cases and utilities', () => {
    it('should handle very long queries', async () => {
      const longQuery = 'a'.repeat(1000);
      const paramsWithLongQuery = { ...validSearchParams, q: longQuery };
      
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.search(mockContext, paramsWithLongQuery);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          query: longQuery,
        })
      );
    });

    it('should handle queries with special characters', async () => {
      const specialQuery = 'test @#$%^&*()[]{}|\\:";\'<>?,./`~';
      const paramsWithSpecialChars = { ...validSearchParams, q: specialQuery };
      
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.search(mockContext, paramsWithSpecialChars);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          query: specialQuery,
        })
      );
    });

    it('should handle queries with only whitespace', async () => {
      const whitespaceQuery = '   ';
      const paramsWithWhitespace = { ...validSearchParams, q: whitespaceQuery };

      await controller.search(mockContext, paramsWithWhitespace);

      // Should treat as too short since trim().length < 3
      expect(mockSearchService.search).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: [],
          message: 'Use at least 3 characters for better results.',
        }),
        200
      );
    });

    it('should handle large pagination parameters', async () => {
      const largePaginationParams = {
        ...validSearchParams,
        limit: 1000,
        offset: 5000,
      };
      
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.search(mockContext, largePaginationParams);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          limit: 1000,
          offset: 5000,
        })
      );
    });

    it('should handle missing optional parameters', async () => {
      const minimalParams = { q: 'test query' };
      
      const mockResults = createMockSearchResults();
      mockSearchService.search.mockResolvedValue(mockResults);

      await controller.search(mockContext, minimalParams as any);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        mockContext.env,
        expect.objectContaining({
          userId: 'test-user-123',
          query: 'test query',
        })
      );
    });
  });
});