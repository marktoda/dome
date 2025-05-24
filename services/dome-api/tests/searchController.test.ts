import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  metrics: {
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  },
}));

vi.mock('../src/services/searchService', () => ({
  SearchService: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([
      {
        id: 'doc1',
        score: 0.95,
        metadata: { title: 'Test Document', content: 'Test content' },
      },
    ]),
  })),
}));

// Import after mocking
import { createSearchController } from '../src/controllers/searchController';

describe('SearchController', () => {
  let app: Hono;
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      VECTORIZE: {},
      CONSTELLATION: {},
    };

    app = new Hono();
    const searchController = createSearchController(mockEnv);
    app.route('/search', searchController);
    vi.clearAllMocks();
  });

  describe('POST /search', () => {
    it('should perform search successfully', async () => {
      const searchRequest = {
        query: 'test search query',
        options: {
          topK: 10,
          scoreThreshold: 0.5,
        },
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(searchRequest),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        id: 'doc1',
        score: 0.95,
      });
    });

    it('should handle missing query parameter', async () => {
      const invalidRequest = {
        options: { topK: 10 },
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidRequest),
      });

      expect(response.status).toBe(400);
    });

    it('should handle empty query', async () => {
      const emptyQueryRequest = {
        query: '',
        options: { topK: 10 },
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emptyQueryRequest),
      });

      expect(response.status).toBe(400);
    });

    it('should apply default search options', async () => {
      const minimalRequest = {
        query: 'test query',
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(minimalRequest),
      });

      expect(response.status).toBe(200);
    });

    it('should handle search service errors', async () => {
      // Mock search service to throw error
      vi.mocked(mockEnv.searchService?.search).mockRejectedValueOnce(
        new Error('Search service error')
      );

      const searchRequest = {
        query: 'error query',
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(searchRequest),
      });

      expect(response.status).toBe(500);
    });
  });

  describe('GET /search', () => {
    it('should handle query parameter search', async () => {
      const response = await app.request('/search?q=test%20query&topK=5');

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.results).toBeDefined();
    });

    it('should handle missing query parameter in GET', async () => {
      const response = await app.request('/search');

      expect(response.status).toBe(400);
    });

    it('should parse numeric parameters correctly', async () => {
      const response = await app.request('/search?q=test&topK=15&scoreThreshold=0.8');

      expect(response.status).toBe(200);
    });
  });

  describe('request validation', () => {
    it('should validate topK parameter bounds', async () => {
      const requestWithInvalidTopK = {
        query: 'test',
        options: { topK: -1 },
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestWithInvalidTopK),
      });

      expect(response.status).toBe(400);
    });

    it('should validate score threshold bounds', async () => {
      const requestWithInvalidScore = {
        query: 'test',
        options: { scoreThreshold: 1.5 }, // > 1.0
      };

      const response = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestWithInvalidScore),
      });

      expect(response.status).toBe(400);
    });
  });
});