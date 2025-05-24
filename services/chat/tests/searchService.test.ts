import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchService } from '../src/services/searchService';

// Mock external dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  createServiceMetrics: vi.fn().mockReturnValue({
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  }),
}));

describe('SearchService', () => {
  let searchService: SearchService;
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: 'doc1',
              score: 0.95,
              metadata: { title: 'Test Document 1', content: 'Test content 1' },
            },
            {
              id: 'doc2',
              score: 0.87,
              metadata: { title: 'Test Document 2', content: 'Test content 2' },
            },
          ],
        }),
      },
      CONSTELLATION: {
        embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      },
    };

    searchService = new SearchService(mockEnv);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create SearchService instance', () => {
      expect(searchService).toBeInstanceOf(SearchService);
    });

    it('should require vectorize binding', () => {
      expect(() => new SearchService({})).toThrow();
    });
  });

  describe('search', () => {
    it('should perform vector search successfully', async () => {
      const query = 'test search query';
      const results = await searchService.search(query);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        id: 'doc1',
        score: 0.95,
        metadata: expect.objectContaining({
          title: 'Test Document 1',
        }),
      });
      expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          topK: expect.any(Number),
        })
      );
    });

    it('should handle empty search results', async () => {
      mockEnv.VECTORIZE.query.mockResolvedValueOnce({ matches: [] });

      const query = 'no results query';
      const results = await searchService.search(query);

      expect(results).toHaveLength(0);
    });

    it('should handle search errors gracefully', async () => {
      mockEnv.VECTORIZE.query.mockRejectedValueOnce(new Error('Vector search failed'));

      const query = 'error query';
      await expect(searchService.search(query)).rejects.toThrow('Vector search failed');
    });

    it('should apply score threshold filtering', async () => {
      mockEnv.VECTORIZE.query.mockResolvedValueOnce({
        matches: [
          { id: 'doc1', score: 0.95, metadata: { title: 'High score' } },
          { id: 'doc2', score: 0.3, metadata: { title: 'Low score' } },
        ],
      });

      const query = 'test query';
      const results = await searchService.search(query, { scoreThreshold: 0.5 });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('doc1');
    });

    it('should limit results with topK parameter', async () => {
      const query = 'test query';
      await searchService.search(query, { topK: 1 });

      expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          topK: 1,
        })
      );
    });
  });

  describe('embedding generation', () => {
    it('should generate embeddings for text', async () => {
      const text = 'test text for embedding';
      const embeddings = await searchService.generateEmbedding(text);

      expect(embeddings).toEqual([0.1, 0.2, 0.3]);
      expect(mockEnv.CONSTELLATION.embed).toHaveBeenCalledWith(text);
    });

    it('should handle embedding errors', async () => {
      mockEnv.CONSTELLATION.embed.mockRejectedValueOnce(new Error('Embedding failed'));

      const text = 'error text';
      await expect(searchService.generateEmbedding(text))
        .rejects.toThrow('Embedding failed');
    });

    it('should handle empty text input', async () => {
      const text = '';
      await expect(searchService.generateEmbedding(text))
        .rejects.toThrow();
    });
  });

  describe('search with filters', () => {
    it('should apply metadata filters', async () => {
      const query = 'test query';
      const filters = { category: 'documentation' };
      
      await searchService.search(query, { filters });

      expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          filter: filters,
        })
      );
    });

    it('should combine multiple search options', async () => {
      const query = 'complex search';
      const options = {
        topK: 5,
        scoreThreshold: 0.7,
        filters: { type: 'article' },
      };

      await searchService.search(query, options);

      expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          topK: 5,
          filter: { type: 'article' },
        })
      );
    });
  });
});