import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentRepository, createContentRepository } from '../../src/repositories/contentRepository';

describe('ContentRepository', () => {
  let contentRepository: ContentRepository;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue({}),
        }),
      }),
    };

    mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn(),
          all: vi.fn(),
          run: vi.fn(),
        }),
      },
    };

    // Mock drizzle
    vi.mock('drizzle-orm/d1', () => ({
      drizzle: vi.fn().mockReturnValue(mockDb),
    }));

    contentRepository = createContentRepository(mockEnv);

    vi.clearAllMocks();
  });

  describe('insertContent', () => {
    it('should insert content metadata with version 1', async () => {
      const contentData = {
        id: 'test-id',
        userId: 'user123',
        contentType: 'note',
        size: 1024,
        r2Key: 'content/test-id',
        createdAt: 1234567890,
      };

      await contentRepository.insertContent(contentData);

      // Verify drizzle insert was called with correct data
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.insert().values).toHaveBeenCalledWith({
        ...contentData,
        version: 1,
      });
      expect(mockDb.insert().values().onConflictDoNothing).toHaveBeenCalled();
    });

    it('should handle null userId', async () => {
      const contentData = {
        id: 'test-id',
        userId: null,
        contentType: 'note',
        size: 1024,
        r2Key: 'content/test-id',
        createdAt: 1234567890,
      };

      await contentRepository.insertContent(contentData);

      // Verify drizzle insert was called with correct data
      expect(mockDb.insert().values).toHaveBeenCalledWith({
        ...contentData,
        version: 1,
      });
    });
  });

  describe('getContentById', () => {
    it('should retrieve content by ID', async () => {
      const mockContent = {
        id: 'test-id',
        userId: 'user123',
        contentType: 'note',
        size: 1024,
        r2Key: 'content/test-id',
        createdAt: 1234567890,
        version: 1,
      };

      mockEnv.DB.prepare().first.mockResolvedValue(mockContent);

      const result = await contentRepository.getContentById('test-id');

      // Verify DB prepare was called with correct query
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT'));
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ?'));
      
      // Verify bind was called with ID
      expect(mockEnv.DB.prepare().bind).toHaveBeenCalledWith('test-id');
      
      // Verify result
      expect(result).toEqual(mockContent);
    });

    it('should return null for non-existent content', async () => {
      mockEnv.DB.prepare().first.mockResolvedValue(null);

      const result = await contentRepository.getContentById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getContentByIds', () => {
    it('should retrieve content for multiple IDs', async () => {
      const mockResults = {
        results: [
          {
            id: 'id1',
            userId: 'user123',
            contentType: 'note',
            size: 10,
            r2Key: 'content/id1',
            createdAt: 100,
            version: 1,
          },
          {
            id: 'id2',
            userId: null,
            contentType: 'image',
            size: 2048,
            r2Key: 'content/id2',
            createdAt: 200,
            version: 1,
          },
        ],
      };

      mockEnv.DB.prepare().all.mockResolvedValue(mockResults);

      const result = await contentRepository.getContentByIds(['id1', 'id2']);

      // Verify DB prepare was called with correct query
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT'));
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE id IN'));
      
      // Verify bind was called with IDs
      expect(mockEnv.DB.prepare().bind).toHaveBeenCalledWith('id1', 'id2');
      
      // Verify result
      expect(result).toEqual(mockResults.results);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('id1');
      expect(result[1].id).toBe('id2');
    });

    it('should return empty array for empty input', async () => {
      const result = await contentRepository.getContentByIds([]);

      expect(result).toEqual([]);
      expect(mockEnv.DB.prepare).not.toHaveBeenCalled();
    });
  });

  describe('deleteContent', () => {
    it('should delete content by ID', async () => {
      await contentRepository.deleteContent('test-id');

      // Verify DB prepare was called with correct query
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM contents'));
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ?'));
      
      // Verify bind was called with ID
      expect(mockEnv.DB.prepare().bind).toHaveBeenCalledWith('test-id');
      
      // Verify run was called
      expect(mockEnv.DB.prepare().run).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should retrieve storage statistics', async () => {
      const mockCountResult = {
        total: 42,
        totalSize: 12345,
      };
      
      const mockTypeResult = {
        results: [
          { contentType: 'note', count: 30 },
          { contentType: 'image', count: 10 },
          { contentType: 'document', count: 2 },
        ],
      };

      mockEnv.DB.prepare().first.mockResolvedValue(mockCountResult);
      mockEnv.DB.prepare().all.mockResolvedValue(mockTypeResult);

      const result = await contentRepository.getStats();

      // Verify DB prepare was called for both queries
      expect(mockEnv.DB.prepare).toHaveBeenCalledTimes(2);
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'));
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('GROUP BY'));
      
      // Verify result
      expect(result.total).toBe(42);
      expect(result.totalSize).toBe(12345);
      expect(result.byType).toEqual({
        note: 30,
        image: 10,
        document: 2,
      });
    });

    it('should handle null count results', async () => {
      const mockCountResult = {
        total: null,
        totalSize: null,
      };
      
      const mockTypeResult = {
        results: [],
      };

      mockEnv.DB.prepare().first.mockResolvedValue(mockCountResult);
      mockEnv.DB.prepare().all.mockResolvedValue(mockTypeResult);

      const result = await contentRepository.getStats();

      expect(result.total).toBe(0);
      expect(result.totalSize).toBe(0);
      expect(result.byType).toEqual({});
    });
  });
});