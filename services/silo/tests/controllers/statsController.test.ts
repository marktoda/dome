import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatsController, createStatsController } from '../../src/controllers/statsController';
import { MetadataService } from '../../src/services/metadataService';

describe('StatsController', () => {
  let statsController: StatsController;
  let mockEnv: any;
  let mockMetadataService: MetadataService;

  beforeEach(() => {
    mockEnv = {
      BUCKET: {},
      DB: {},
      NEW_CONTENT: {},
    };

    // Create mock metadata service
    mockMetadataService = {
      getStats: vi.fn(),
    } as unknown as MetadataService;

    statsController = createStatsController(mockEnv, mockMetadataService);

    vi.clearAllMocks();
  });

  describe('getStats', () => {
    it('should retrieve statistics from metadata service', async () => {
      const mockStats = {
        total: 10,
        totalSize: 1024 * 1024,
        byType: {
          note: 5,
          image: 3,
          document: 2,
        },
      };

      (mockMetadataService.getStats as any).mockResolvedValue(mockStats);

      const result = await statsController.getStats();

      // Verify MetadataService.getStats was called
      expect(mockMetadataService.getStats).toHaveBeenCalled();

      // Verify result matches expected stats
      expect(result).toEqual(mockStats);
      expect(result.total).toBe(10);
      expect(result.totalSize).toBe(1024 * 1024);
      expect(result.byType.note).toBe(5);
      expect(result.byType.image).toBe(3);
      expect(result.byType.document).toBe(2);
    });

    it('should handle empty statistics', async () => {
      const emptyStats = {
        total: 0,
        totalSize: 0,
        byType: {},
      };

      (mockMetadataService.getStats as any).mockResolvedValue(emptyStats);

      const result = await statsController.getStats();

      expect(result).toEqual(emptyStats);
      expect(result.total).toBe(0);
      expect(result.totalSize).toBe(0);
      expect(result.byType).toEqual({});
    });

    it('should handle errors from metadata service', async () => {
      const error = new Error('Database error');
      (mockMetadataService.getStats as any).mockRejectedValue(error);

      await expect(statsController.getStats()).rejects.toThrow('Database error');
    });
  });
});
