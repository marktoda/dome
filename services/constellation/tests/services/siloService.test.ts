/**
 * SiloService Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiloService } from '../../src/services/siloService';
import { NewContentMessage } from '@dome/common';

// Mock the logger and metrics
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn().mockReturnValue({
      stop: vi.fn(),
    }),
  },
  logError: vi.fn(),
}));

describe('SiloService', () => {
  let mockSiloBinding: any;
  let mockEnv: any;
  let siloService: SiloService;

  beforeEach(() => {
    // Create a mock Silo binding
    mockSiloBinding = {
      batchGet: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'test-content-id',
            body: 'Test content body',
          },
        ],
      }),
    };

    // Create a mock environment with the Silo binding
    mockEnv = {
      SILO: mockSiloBinding,
    };

    // Create a new SiloService with the mock environment
    siloService = new SiloService(mockEnv);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchContent', () => {
    it('should fetch content from Silo', async () => {
      const contentId = 'test-content-id';
      const userId = 'test-user-id';

      const result = await siloService.fetchContent(contentId, userId);

      expect(mockSiloBinding.batchGet).toHaveBeenCalledWith({
        ids: [contentId],
        userId,
      });
      expect(result).toBe('Test content body');
    });

    it('should throw an error if content is not found', async () => {
      const contentId = 'non-existent-content';
      const userId = 'test-user-id';

      mockSiloBinding.batchGet.mockResolvedValueOnce({ items: [] });

      await expect(siloService.fetchContent(contentId, userId)).rejects.toThrow(
        `Content not found: ${contentId}`,
      );
    });

    it('should throw an error if content body is not available', async () => {
      const contentId = 'content-without-body';
      const userId = 'test-user-id';

      mockSiloBinding.batchGet.mockResolvedValueOnce({
        items: [
          {
            id: contentId,
            body: null,
          },
        ],
      });

      await expect(siloService.fetchContent(contentId, userId)).rejects.toThrow(
        `Content body not available for: ${contentId}`,
      );
    });
  });

  describe('convertToEmbedJob', () => {
    it('should convert a message to an embed job', async () => {
      const message: NewContentMessage = {
        id: 'test-content-id',
        userId: 'test-user-id',
        category: 'note',
        mimeType: 'text/markdown',
        createdAt: 1650000000,
        deleted: false,
      };

      const result = await siloService.convertToEmbedJob(message);

      expect(result).toEqual({
        userId: 'test-user-id',
        contentId: 'test-content-id',
        text: 'Test content body',
        created: 1650000000 * 1000, // Converted to milliseconds
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      });
    });

    it('should tag public content (null userId) with PUBLIC_CONTENT_USER_ID', async () => {
      const message: NewContentMessage = {
        id: 'public-content-id',
        userId: null, // Public content has null userId
        category: 'note',
        mimeType: 'text/markdown',
        createdAt: 1650000000,
        deleted: false,
      };

      const result = await siloService.convertToEmbedJob(message);

      expect(result.userId).toBe(SiloService.PUBLIC_CONTENT_USER_ID);
      expect(result).toEqual({
        userId: SiloService.PUBLIC_CONTENT_USER_ID,
        contentId: 'public-content-id',
        text: 'Test content body',
        created: 1650000000 * 1000, // Converted to milliseconds
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      });
    });

    it('should throw an error for deleted content', async () => {
      const message: NewContentMessage = {
        id: 'deleted-content-id',
        userId: 'test-user-id',
        category: 'note',
        mimeType: 'text/markdown',
        createdAt: 1650000000,
        deleted: true, // Content is marked as deleted
      };

      await expect(siloService.convertToEmbedJob(message)).rejects.toThrow(
        'Content is marked as deleted, skipping embedding',
      );
    });

    it('should use current timestamp if createdAt is not provided', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const message: NewContentMessage = {
        id: 'test-content-id',
        userId: 'test-user-id',
        category: 'note',
        mimeType: 'text/markdown',
        deleted: false,
        // createdAt is not provided
      };

      const result = await siloService.convertToEmbedJob(message);

      expect(result.created).toBe(Math.floor(now / 1000) * 1000); // Converted to seconds then back to milliseconds
    });

    it('should use default values for missing category and mimeType', async () => {
      const message: NewContentMessage = {
        id: 'test-content-id',
        userId: 'test-user-id',
        deleted: false,
        createdAt: 1650000000,
        // category and mimeType are not provided
      };

      const result = await siloService.convertToEmbedJob(message);

      expect(result.category).toBe('note'); // Default category
      expect(result.mimeType).toBe('text/markdown'); // Default mimeType
    });
  });
});
