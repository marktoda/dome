import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatsService, createStatsService } from '../../src/services/statsService';
import { ContentRepository } from '../../src/repositories/contentRepository';

describe('StatsService', () => {
  let statsService: StatsService;
  let mockEnv: any;
  let mockContentRepository: any;

  beforeEach(() => {
    mockEnv = {
      DB: {},
    };

    mockContentRepository = {
      getStats: vi.fn(),
    };

    statsService = createStatsService(mockEnv, mockContentRepository);

    vi.clearAllMocks();
  });

  describe('getStats', () => {
    it('should retrieve stats from repository', async () => {
      const mockStats = {
        total: 42,
        totalSize: 12345,
        byType: {
          note: 30,
          image: 10,
          document: 2,
        },
      };

      mockContentRepository.getStats.mockResolvedValue(mockStats);

      const result = await statsService.getStats();

      // Verify repository method was called
      expect(mockContentRepository.getStats).toHaveBeenCalled();
      
      // Verify result matches repository data
      expect(result).toEqual(mockStats);
      expect(result.total).toBe(42);
      expect(result.totalSize).toBe(12345);
      expect(result.byType.note).toBe(30);
      expect(result.byType.image).toBe(10);
      expect(result.byType.document).toBe(2);
    });

    it('should handle empty stats', async () => {
      const emptyStats = {
        total: 0,
        totalSize: 0,
        byType: {},
      };

      mockContentRepository.getStats.mockResolvedValue(emptyStats);

      const result = await statsService.getStats();

      expect(result).toEqual(emptyStats);
      expect(result.total).toBe(0);
      expect(result.totalSize).toBe(0);
      expect(Object.keys(result.byType).length).toBe(0);
    });

    it('should handle repository errors', async () => {
      const mockError = new Error('Database error');
      mockContentRepository.getStats.mockRejectedValue(mockError);

      await expect(statsService.getStats()).rejects.toThrow('Database error');
    });
  });
});