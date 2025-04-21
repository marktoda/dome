import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { constellationService } from '../../src/services/constellationService';
import { ServiceError, SiloEmbedJob, VectorSearchResult, VectorIndexStats } from '@dome/common';

// Mock dependencies
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('ConstellationService', () => {
  // Mock environment
  const mockEnv = {
    CONSTELLATION: {
      embed: vi.fn(),
      query: vi.fn(),
      stats: vi.fn(),
    },
    EMBED_QUEUE: {
      send: vi.fn(),
    },
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
  };

  // Test data
  const mockUserId = 'user-123';
  const mockNoteId = 'note-123';
  const mockText = 'This is a test text for embedding';

  // Mock vector search results
  const mockVectorResults: VectorSearchResult[] = [
    {
      id: 'vector-1',
      score: 0.95,
      metadata: {
        userId: mockUserId,
        category: 'note',
        mimeType: 'text/markdown',
        contentId: 'note-123',
        createdAt: Math.floor(Date.now() / 1000),
        version: 1,
      },
    },
    {
      id: 'vector-2',
      score: 0.85,
      metadata: {
        userId: mockUserId,
        category: 'note',
        mimeType: 'text/markdown',
        contentId: 'note-456',
        createdAt: Math.floor(Date.now() / 1000),
        version: 1,
      },
    },
  ];

  // Mock content search results
  const mockContentResults = [
    { contentId: 'note-123', score: 0.95 },
    { contentId: 'note-456', score: 0.85 },
  ];

  // Mock vector stats
  const mockVectorStats: VectorIndexStats = {
    vectors: 100,
    dimension: 768,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('query', () => {
    it('should query embeddings successfully', async () => {
      // Arrange
      vi.mocked(mockEnv.CONSTELLATION.query).mockResolvedValue(mockVectorResults);
      const filter = { userId: mockUserId };
      const topK = 5;

      // Act
      const results = await constellationService.query(mockEnv as any, mockText, filter, topK);

      // Assert
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledWith(
        expect.any(String), // Preprocessed text
        filter,
        topK,
      );
      expect(results).toEqual(mockVectorResults);
    });

    it('should handle errors when querying embeddings', async () => {
      // Arrange
      const error = new Error('Query error');
      vi.mocked(mockEnv.CONSTELLATION.query).mockRejectedValue(error);

      // Act & Assert
      await expect(constellationService.query(mockEnv as any, mockText)).rejects.toThrow(
        ServiceError,
      );
    });

    it('should use default topK when not specified', async () => {
      // Arrange
      vi.mocked(mockEnv.CONSTELLATION.query).mockResolvedValue(mockVectorResults);
      const filter = { userId: mockUserId };

      // Act
      await constellationService.query(mockEnv as any, mockText, filter);

      // Assert
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledWith(
        expect.any(String),
        filter,
        10, // Default topK
      );
    });
  });

  describe('getStats', () => {
    it('should get vector index statistics successfully', async () => {
      // Arrange
      vi.mocked(mockEnv.CONSTELLATION.stats).mockResolvedValue(mockVectorStats);

      // Act
      const stats = await constellationService.getStats(mockEnv as any);

      // Assert
      expect(mockEnv.CONSTELLATION.stats).toHaveBeenCalled();
      expect(stats).toEqual(mockVectorStats);
    });

    it('should handle errors when getting statistics', async () => {
      // Arrange
      const error = new Error('Stats error');
      vi.mocked(mockEnv.CONSTELLATION.stats).mockRejectedValue(error);

      // Act & Assert
      await expect(constellationService.getStats(mockEnv as any)).rejects.toThrow(ServiceError);
    });
  });

  describe('searchNotes', () => {
    it('should search notes successfully', async () => {
      // Arrange
      vi.mocked(mockEnv.CONSTELLATION.query).mockResolvedValue(mockVectorResults);
      const topK = 5;

      // Act
      const results = await constellationService.searchNotes(
        mockEnv as any,
        mockText,
        mockUserId,
        topK,
      );

      // Assert
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledWith(
        expect.any(String),
        { userId: mockUserId },
        topK,
      );

      // Verify the results have the expected structure
      expect(results).toHaveLength(mockVectorResults.length);
      expect(results[0]).toHaveProperty('contentId');
      expect(results[0]).toHaveProperty('score');
      expect(results[0].contentId).toBe(mockVectorResults[0].metadata.contentId);
    });

    it('should handle errors when searching notes', async () => {
      // Arrange
      const error = new Error('Search error');
      vi.mocked(mockEnv.CONSTELLATION.query).mockRejectedValue(error);

      // Act & Assert
      await expect(
        constellationService.searchNotes(mockEnv as any, mockText, mockUserId),
      ).rejects.toThrow(ServiceError);
    });

    it('should use default topK when not specified', async () => {
      // Arrange
      vi.mocked(mockEnv.CONSTELLATION.query).mockResolvedValue(mockVectorResults);

      // Act
      await constellationService.searchNotes(mockEnv as any, mockText, mockUserId);

      // Assert
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledWith(
        expect.any(String),
        { userId: mockUserId },
        10, // Default topK
      );
    });
  });
});
